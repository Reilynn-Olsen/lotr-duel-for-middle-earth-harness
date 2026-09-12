import { Faction, StateResponse } from "../protocol.js";
import type { AgentAttempt, CostEstimate } from "./execution.js";

export interface AgentMetadata {
  id: string;
  version: string;
  provider: string;
  model?: string;
}
export interface AgentUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}
export interface AgentContext {
  observation: StateResponse["observation"];
  legalActions: readonly Readonly<StateResponse["legalActions"][number]>[];
  gameId: string;
  matchId: string;
  seat: Faction;
  turn: number;
  signal: AbortSignal;
}
export interface AgentDecision {
  actionId: string;
  agent: AgentMetadata;
  latencyMs: number;
  attempts: number;
  usage?: AgentUsage;
  estimatedCost?: number;
  cost?: CostEstimate;
  reasoningSummary?: string;
  rawOutput?: string;
  attemptLog?: readonly AgentAttempt[];
}
export interface Agent {
  readonly metadata: AgentMetadata;
  choose(context: AgentContext): Promise<AgentDecision>;
}

export class AgentFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentFailureError";
  }
}
export class InvalidAgentDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentDecisionError";
  }
}
export class AgentAbortError extends AgentFailureError {
  constructor() {
    super("agent request aborted");
    this.name = "AgentAbortError";
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentAbortError();
}
export function validateAgentDecision(
  context: AgentContext,
  decision: AgentDecision,
  expectedAgent?: AgentMetadata,
): AgentDecision {
  if (
    !context.legalActions.some(
      (action) => action.actionId === decision.actionId,
    )
  )
    throw new InvalidAgentDecisionError(
      `agent ${decision.agent.id} chose an action ID that was not offered`,
    );
  if (
    expectedAgent &&
    (decision.agent.id !== expectedAgent.id ||
      decision.agent.version !== expectedAgent.version ||
      decision.agent.provider !== expectedAgent.provider ||
      decision.agent.model !== expectedAgent.model)
  )
    throw new InvalidAgentDecisionError(
      "agent decision metadata does not match the configured agent",
    );
  return decision;
}

export function redactSecrets(
  value: string,
  secrets: readonly string[] = [],
): string {
  let redacted = value;
  for (const secret of secrets)
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|or)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}
