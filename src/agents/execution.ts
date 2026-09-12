import { z } from "zod";
import {
  AgentAbortError,
  AgentContext,
  AgentDecision,
  AgentFailureError,
  AgentMetadata,
  AgentUsage,
  InvalidAgentDecisionError,
  redactSecrets,
  throwIfAborted,
  validateAgentDecision,
} from "./types.js";

const StructuredDecisionSchema = z
  .object({
    actionId: z.string().min(1),
    reasoningSummary: z.string().max(1_000).optional(),
  })
  .strict();
export type AttemptStatus =
  | "success"
  | "timeout"
  | "retryable_failure"
  | "provider_failure"
  | "malformed_output"
  | "invalid_action"
  | "budget_exhausted"
  | "cancelled";
export interface AgentAttempt {
  attempt: number;
  status: AttemptStatus;
  latencyMs: number;
  usage?: AgentUsage;
  cost?: CostEstimate;
  error?: string;
}
export interface CostEstimate {
  amount?: number;
  currency: "USD";
  pricingVersion: string;
  source: "provider" | "calculated" | "unavailable";
}
export interface ProviderResult {
  output: unknown;
  usage?: AgentUsage;
  providerCost?: number;
  retryAfterMs?: number;
}
export interface ProviderClient {
  invoke(context: AgentContext, signal: AbortSignal): Promise<ProviderResult>;
}
export interface ExecutionClock {
  now(): number;
}
export interface ExecutionDependencies {
  clock?: ExecutionClock;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  limiter?: ExecutionLimiter;
}
export interface RateLimit {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
}
export interface ExecutionLimits {
  providerConcurrency?: number;
  modelConcurrency?: number;
  rate?: RateLimit;
  maxInputTokens?: number;
}
export interface Pricing {
  version: string;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
}
export interface DecisionBudget {
  perDecisionUsd?: number;
  perGameUsd?: number;
  perRunUsd?: number;
}
export class BudgetLedger {
  private run = 0;
  private readonly games = new Map<string, number>();
  spend(gameId: string, cost: number): void {
    this.run += cost;
    this.games.set(gameId, (this.games.get(gameId) ?? 0) + cost);
  }
  gameCost(gameId: string): number {
    return this.games.get(gameId) ?? 0;
  }
  runCost(): number {
    return this.run;
  }
}
export type TerminalPolicy = "forfeit" | "abort_match" | "fallback";
export interface ExecutionOptions {
  attemptTimeoutMs: number;
  maxAttempts: number;
  backoff: { baseMs: number; maxMs: number; jitter: number };
  limits?: ExecutionLimits;
  pricing: Pricing;
  budgets?: DecisionBudget;
  ledger?: BudgetLedger;
  terminalPolicy: TerminalPolicy;
  debugRawOutput?: boolean;
  onAttempt?: (attempt: AgentAttempt) => void;
  secrets?: readonly string[];
}
export class AgentTerminalError extends AgentFailureError {
  constructor(
    readonly policy: Exclude<TerminalPolicy, "fallback">,
    readonly attempts: readonly AgentAttempt[],
    message: string,
  ) {
    super(`${policy}: ${message}`);
    this.name = "AgentTerminalError";
  }
}

export class ExecutionLimiter {
  private active = 0;
  private readonly activeByModel = new Map<string, number>();
  private readonly waits: Array<() => void> = [];
  private readonly requestTimes: number[] = [];
  private readonly tokenTimes: Array<{ at: number; tokens: number }> = [];
  constructor(
    private readonly limits: ExecutionLimits,
    private readonly clock: ExecutionClock,
    private readonly sleep: (
      milliseconds: number,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}
  async acquire(
    model: string,
    inputTokens: number,
    signal: AbortSignal,
  ): Promise<() => void> {
    throwIfAborted(signal);
    const providerMax = this.limits.providerConcurrency ?? Infinity;
    const modelMax = this.limits.modelConcurrency ?? Infinity;
    while (
      this.active >= providerMax ||
      (this.activeByModel.get(model) ?? 0) >= modelMax
    )
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = this.waits.indexOf(wake);
          if (index >= 0) this.waits.splice(index, 1);
          reject(new AgentAbortError());
        };
        this.waits.push(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    await this.waitForRate(inputTokens, signal);
    this.active += 1;
    this.activeByModel.set(model, (this.activeByModel.get(model) ?? 0) + 1);
    return () => {
      this.active -= 1;
      const active = (this.activeByModel.get(model) ?? 1) - 1;
      if (active === 0) this.activeByModel.delete(model);
      else this.activeByModel.set(model, active);
      this.waits.shift()?.();
    };
  }
  private async waitForRate(
    inputTokens: number,
    signal: AbortSignal,
  ): Promise<void> {
    const now = this.clock.now();
    const cutoff = now - 60_000;
    while (
      this.requestTimes[0] !== undefined &&
      this.requestTimes[0]! <= cutoff
    )
      this.requestTimes.shift();
    while (
      this.tokenTimes[0]?.at !== undefined &&
      this.tokenTimes[0]!.at <= cutoff
    )
      this.tokenTimes.shift();
    const rpm = this.limits.rate?.requestsPerMinute;
    const tpm = this.limits.rate?.tokensPerMinute;
    const usedTokens = this.tokenTimes.reduce(
      (sum, entry) => sum + entry.tokens,
      0,
    );
    if (
      (rpm && this.requestTimes.length >= rpm) ||
      (tpm && usedTokens + inputTokens > tpm)
    ) {
      const earliest = Math.min(
        this.requestTimes[0] ?? Infinity,
        this.tokenTimes[0]?.at ?? Infinity,
      );
      await this.sleep(Math.max(1, earliest + 60_000 - now), signal);
      return this.waitForRate(inputTokens, signal);
    }
    this.requestTimes.push(this.clock.now());
    this.tokenTimes.push({ at: this.clock.now(), tokens: inputTokens });
  }
}

export class LlmExecutionAgent {
  constructor(
    readonly metadata: AgentMetadata,
    private readonly model: string,
    private readonly provider: ProviderClient,
    private readonly options: ExecutionOptions,
    private readonly dependencies: ExecutionDependencies = {},
  ) {}
  async choose(context: AgentContext): Promise<AgentDecision> {
    const clock = this.dependencies.clock ?? { now: () => Date.now() };
    const sleep = this.dependencies.sleep ?? abortableSleep;
    const random = this.dependencies.random ?? Math.random;
    const limiter =
      this.dependencies.limiter ??
      new ExecutionLimiter(this.options.limits ?? {}, clock, sleep);
    const inputTokens = estimateInputTokens(context);
    const attempts: AgentAttempt[] = [];
    const started = clock.now();
    if (
      this.options.limits?.maxInputTokens !== undefined &&
      inputTokens > this.options.limits.maxInputTokens
    )
      return this.terminal(
        context,
        attempts,
        "input exceeds maximum input token limit",
        started,
        clock.now(),
      );
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      throwIfAborted(context.signal);
      const release = await limiter.acquire(
        this.model,
        inputTokens,
        context.signal,
      );
      let released = false;
      const attemptStarted = clock.now();
      try {
        throwIfAborted(context.signal);
        const timeout = AbortSignal.timeout(this.options.attemptTimeoutMs);
        const signal = AbortSignal.any([context.signal, timeout]);
        const result = await this.provider.invoke(context, signal);
        const selected = parseOutput(result.output);
        const cost = calculateCost(
          result.usage,
          result.providerCost,
          this.options.pricing,
        );
        this.enforceBudget(context, cost);
        const decision = validateAgentDecision(context, {
          actionId: selected.actionId,
          agent: this.metadata,
          latencyMs: clock.now() - started,
          attempts: attempt,
          usage: result.usage,
          estimatedCost: cost.amount,
          cost,
          reasoningSummary: selected.reasoningSummary
            ? sanitize(selected.reasoningSummary, this.options.secrets)
            : undefined,
          rawOutput:
            this.options.debugRawOutput && typeof result.output === "string"
              ? result.output
              : undefined,
        });
        this.record(attempts, {
          attempt,
          status: "success",
          latencyMs: clock.now() - attemptStarted,
          usage: result.usage,
          cost,
        });
        if (cost.amount !== undefined)
          this.options.ledger?.spend(context.gameId, cost.amount);
        return { ...decision, attemptLog: attempts };
      } catch (error) {
        if (context.signal.aborted) throw new AgentAbortError();
        const classified = classify(error);
        const event: AgentAttempt = {
          attempt,
          status: classified,
          latencyMs: clock.now() - attemptStarted,
          error: sanitize(
            error instanceof Error ? error.message : String(error),
            this.options.secrets,
          ),
        };
        this.record(attempts, event);
        if (
          classified === "malformed_output" ||
          classified === "invalid_action" ||
          classified === "budget_exhausted" ||
          classified === "provider_failure"
        )
          return this.terminal(
            context,
            attempts,
            event.error ?? "agent failure",
            started,
            clock.now(),
          );
        if (attempt === this.options.maxAttempts)
          return this.terminal(
            context,
            attempts,
            event.error ?? "agent failed",
            started,
            clock.now(),
          );
        const retryAfter =
          error instanceof RetryableProviderError
            ? error.retryAfterMs
            : undefined;
        const backoff =
          retryAfter ??
          Math.min(
            this.options.backoff.maxMs,
            this.options.backoff.baseMs * 2 ** (attempt - 1),
          );
        const jitter = Math.floor(
          backoff * this.options.backoff.jitter * random(),
        );
        release();
        released = true;
        throwIfAborted(context.signal);
        await sleep(backoff + jitter, context.signal);
      } finally {
        if (!released) release();
      }
    }
    return this.terminal(
      context,
      attempts,
      "agent failed",
      started,
      clock.now(),
    );
  }
  private enforceBudget(context: AgentContext, cost: CostEstimate): void {
    const budget = this.options.budgets;
    if (!budget) return;
    if (cost.amount === undefined)
      throw new BudgetError(
        "cost is unavailable while a dollar budget is configured",
      );
    const game = this.options.ledger?.gameCost(context.gameId) ?? 0;
    const run = this.options.ledger?.runCost() ?? 0;
    if (
      (budget.perDecisionUsd !== undefined &&
        cost.amount > budget.perDecisionUsd) ||
      (budget.perGameUsd !== undefined &&
        game + cost.amount > budget.perGameUsd) ||
      (budget.perRunUsd !== undefined && run + cost.amount > budget.perRunUsd)
    )
      throw new BudgetError("dollar budget exhausted");
  }
  private record(attempts: AgentAttempt[], event: AgentAttempt): void {
    attempts.push(event);
    this.options.onAttempt?.(event);
  }
  private terminal(
    context: AgentContext,
    attempts: AgentAttempt[],
    message: string,
    started: number,
    now: number,
  ): AgentDecision {
    if (this.options.terminalPolicy === "fallback") {
      const actionId = context.legalActions[0]?.actionId;
      if (!actionId)
        throw new AgentFailureError(
          "cannot select fallback without an offered action",
        );
      return {
        actionId,
        agent: this.metadata,
        latencyMs: now - started,
        attempts: attempts.length,
        cost: {
          currency: "USD",
          pricingVersion: this.options.pricing.version,
          source: "unavailable",
        },
        reasoningSummary: "deterministic fallback after agent failure",
        attemptLog: attempts,
      };
    }
    throw new AgentTerminalError(
      this.options.terminalPolicy,
      attempts,
      message,
    );
  }
}
class RetryableProviderError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
class BudgetError extends Error {}
function parseOutput(
  output: unknown,
): z.infer<typeof StructuredDecisionSchema> {
  try {
    const value = typeof output === "string" ? JSON.parse(output) : output;
    return StructuredDecisionSchema.parse(value);
  } catch {
    throw new InvalidAgentDecisionError(
      "provider response was not a valid structured decision",
    );
  }
}
function classify(error: unknown): AttemptStatus {
  if (error instanceof InvalidAgentDecisionError)
    return error.message.includes("not offered")
      ? "invalid_action"
      : "malformed_output";
  if (error instanceof BudgetError) return "budget_exhausted";
  if (error instanceof RetryableProviderError) return "retryable_failure";
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "timeout";
  return "provider_failure";
}
function calculateCost(
  usage: AgentUsage | undefined,
  providerCost: number | undefined,
  pricing: Pricing,
): CostEstimate {
  if (providerCost !== undefined)
    return {
      amount: providerCost,
      currency: "USD",
      pricingVersion: pricing.version,
      source: "provider",
    };
  if (
    usage?.promptTokens !== undefined &&
    usage.completionTokens !== undefined &&
    pricing.inputUsdPerMillionTokens !== undefined &&
    pricing.outputUsdPerMillionTokens !== undefined
  )
    return {
      amount:
        (usage.promptTokens * pricing.inputUsdPerMillionTokens) / 1_000_000 +
        (usage.completionTokens * pricing.outputUsdPerMillionTokens) /
          1_000_000,
      currency: "USD",
      pricingVersion: pricing.version,
      source: "calculated",
    };
  return {
    currency: "USD",
    pricingVersion: pricing.version,
    source: "unavailable",
  };
}
function estimateInputTokens(context: AgentContext): number {
  return Math.ceil(
    JSON.stringify({
      observation: context.observation,
      legalActions: context.legalActions,
    }).length / 4,
  );
}
function sanitize(value: string, secrets: readonly string[] = []): string {
  return redactSecrets(value, secrets)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .slice(0, 1_000);
}
function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AgentAbortError());
      },
      { once: true },
    );
  });
}
export { RetryableProviderError };
