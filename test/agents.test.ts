import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentAttempt,
  AgentTerminalError,
  BudgetLedger,
  ExecutionLimiter,
  LlmExecutionAgent,
  ProviderClient,
  RetryableProviderError,
} from "../src/agents/execution.js";
import { OpenRouterAgent } from "../src/agents/openrouter.js";
import { AgentAbortError, AgentContext } from "../src/agents/types.js";
import { RandomAgent, ScriptedAgent } from "../src/agents/test-agents.js";

const context = (signal = new AbortController().signal): AgentContext => ({
  observation: "public state",
  legalActions: [{ actionId: "a" }, { actionId: "b" }, { actionId: "c" }],
  gameId: "server-game",
  matchId: "match-1",
  seat: "sauron",
  turn: 2,
  signal,
});
const metadata = {
  id: "test-agent",
  version: "1",
  provider: "test",
  model: "test-model",
};
const execution = (overrides = {}) => ({
  attemptTimeoutMs: 10,
  maxAttempts: 2,
  backoff: { baseMs: 10, maxMs: 100, jitter: 0 },
  pricing: {
    version: "test-v1",
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 2,
  },
  terminalPolicy: "forfeit" as const,
  ...overrides,
});
class SequenceRng {
  private index = 0;
  constructor(private readonly values: readonly number[]) {}
  next(): number {
    return this.values[this.index++ % this.values.length]!;
  }
}
const provider = (...values: Array<unknown | Error>): ProviderClient => {
  let index = 0;
  return {
    invoke: async () => {
      const value = values[index++]!;
      if (value instanceof Error) throw value;
      return { output: value, usage: { promptTokens: 3, completionTokens: 4 } };
    },
  };
};
const immediate = async () => {};

test("random and scripted agents are deterministic", async () => {
  const first = new RandomAgent(new SequenceRng([0.1, 0.9]));
  const second = new RandomAgent(new SequenceRng([0.1, 0.9]));
  assert.deepEqual(
    [await first.choose(context()), await first.choose(context())].map(
      (value) => value.actionId,
    ),
    [await second.choose(context()), await second.choose(context())].map(
      (value) => value.actionId,
    ),
  );
  const script = new ScriptedAgent("script", ["b", "a"]);
  assert.deepEqual(
    [
      (await script.choose(context())).actionId,
      (await script.choose(context())).actionId,
    ],
    ["b", "a"],
  );
});
test("successful first attempt records structured output, usage, and calculated cost", async () => {
  const attempts: string[] = [];
  const agent = new LlmExecutionAgent(
    metadata,
    "test-model",
    provider('{"actionId":"b"}'),
    execution({
      onAttempt: (attempt: AgentAttempt) => attempts.push(attempt.status),
    }),
    { sleep: immediate },
  );
  const result = await agent.choose(context());
  assert.equal(result.actionId, "b");
  assert.equal(result.attempts, 1);
  assert.equal(result.cost?.source, "calculated");
  assert.deepEqual(attempts, ["success"]);
});
test("timeout followed by success retries", async () => {
  const agent = new LlmExecutionAgent(
    metadata,
    "test-model",
    provider(new DOMException("timed out", "TimeoutError"), '{"actionId":"a"}'),
    execution(),
    { sleep: immediate },
  );
  assert.equal((await agent.choose(context())).actionId, "a");
});
test("HTTP 429 honors Retry-After", async () => {
  const waits: number[] = [];
  let calls = 0;
  const agent = new OpenRouterAgent({
    model: "m",
    apiKey: "secret",
    endpoint: "https://provider.invalid",
    execution: execution(),
    dependencies: {
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response("slow down", {
            status: 429,
            headers: { "retry-after": "2" },
          })
        : new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"actionId":"a"}' } }],
            }),
            { status: 200 },
          );
    },
  });
  await agent.choose(context());
  assert.deepEqual(waits, [2_000]);
});
test("OpenRouter metadata IDs can distinguish identical model seats", () => {
  const first = new OpenRouterAgent({
    model: "meta/muse-spark-1.3-contributor",
    apiKey: "secret",
    endpoint: "https://provider.invalid",
    execution: execution(),
    metadata: { id: "openrouter:meta/muse-spark-1.3-contributor" },
  });
  const second = new OpenRouterAgent({
    model: "meta/muse-spark-1.3-contributor",
    apiKey: "secret",
    endpoint: "https://provider.invalid",
    execution: execution(),
    metadata: { id: "openrouter:meta/muse-spark-1.3-contributor-opponent" },
  });
  assert.notEqual(first.metadata.id, second.metadata.id);
  assert.equal(first.metadata.model, second.metadata.model);
});
test("OpenRouter accepts standard response metadata", async () => {
  let requestBody: { max_tokens?: number; reasoning_effort?: string } = {};
  const agent = new OpenRouterAgent({
    model: "m",
    apiKey: "secret",
    endpoint: "https://provider.invalid",
    execution: execution(),
    maxTokens: 512,
    reasoningEffort: "minimal",
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "gen-1",
          object: "chat.completion",
          created: 1,
          model: "m",
          provider: "Meta",
          system_fingerprint: "fp-1",
          service_tier: "default",
          choices: [
            {
              index: 0,
              message: { content: '{"actionId":"a"}' },
              logprobs: null,
              finish_reason: "stop",
              native_finish_reason: "stop",
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  assert.equal((await agent.choose(context())).actionId, "a");
  assert.equal(requestBody.max_tokens, 512);
  assert.equal(requestBody.reasoning_effort, "minimal");
});
test("retryable 5xx retries and authentication failures do not", async () => {
  let calls = 0;
  const five = new OpenRouterAgent({
    model: "m",
    apiKey: "secret",
    endpoint: "https://provider.invalid",
    execution: execution(),
    dependencies: { sleep: immediate },
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response("down", { status: 503 })
        : new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"actionId":"a"}' } }],
            }),
            { status: 200 },
          );
    },
  });
  await five.choose(context());
  assert.equal(calls, 2);
  const auth = new OpenRouterAgent({
    model: "m",
    apiKey: "secret",
    endpoint: "https://provider.invalid",
    execution: execution(),
    fetch: async () => new Response("no", { status: 401 }),
  });
  await assert.rejects(auth.choose(context()), AgentTerminalError);
});
test("malformed output and unavailable actions are terminal invalid decisions", async () => {
  const malformed = new LlmExecutionAgent(
    metadata,
    "m",
    provider("not-json"),
    execution(),
    { sleep: immediate },
  );
  await assert.rejects(malformed.choose(context()), AgentTerminalError);
  const invalid = new LlmExecutionAgent(
    metadata,
    "m",
    provider('{"actionId":"not-offered"}'),
    execution(),
    { sleep: immediate },
  );
  await assert.rejects(invalid.choose(context()), AgentTerminalError);
});
test("budget exhaustion is terminal and costs are ledgered", async () => {
  const ledger = new BudgetLedger();
  const agent = new LlmExecutionAgent(
    metadata,
    "m",
    { invoke: async () => ({ output: '{"actionId":"a"}', providerCost: 2 }) },
    execution({ budgets: { perDecisionUsd: 1 }, ledger }),
    { sleep: immediate },
  );
  await assert.rejects(agent.choose(context()), AgentTerminalError);
  assert.equal(ledger.runCost(), 0);
});
test("a provider response without cost succeeds when no budget is configured", async () => {
  const agent = new LlmExecutionAgent(
    metadata,
    "m",
    { invoke: async () => ({ output: '{"actionId":"a"}' }) },
    execution({ pricing: { version: "provider-reported-v1" } }),
    { sleep: immediate },
  );
  assert.equal((await agent.choose(context())).actionId, "a");
});
test("cancellation interrupts requests and backoff", async () => {
  const requestController = new AbortController();
  const hanging: ProviderClient = {
    invoke: (_context, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new AgentAbortError()), {
          once: true,
        }),
      ),
  };
  const requestAgent = new LlmExecutionAgent(
    metadata,
    "m",
    hanging,
    execution(),
    { sleep: immediate },
  );
  const pending = requestAgent.choose(context(requestController.signal));
  requestController.abort();
  await assert.rejects(pending, AgentAbortError);
  const backoffController = new AbortController();
  const retrying = new LlmExecutionAgent(
    metadata,
    "m",
    provider(new RetryableProviderError("retry")),
    execution(),
    {
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new AgentAbortError()),
            { once: true },
          ),
        ),
    },
  );
  const retryPending = retrying.choose(context(backoffController.signal));
  backoffController.abort();
  await assert.rejects(retryPending, AgentAbortError);
});
test("concurrency and requests-per-minute limits queue deterministically", async () => {
  let now = 0;
  const waits: number[] = [];
  const limiter = new ExecutionLimiter(
    { providerConcurrency: 1, rate: { requestsPerMinute: 1 } },
    { now: () => now },
    async (ms) => {
      waits.push(ms);
      now += ms;
    },
  );
  const release = await limiter.acquire("m", 1, context().signal);
  const second = limiter.acquire("m", 1, context().signal);
  release();
  const releaseSecond = await second;
  releaseSecond();
  assert.deepEqual(waits, [60_000]);
});
test("provider errors redact secrets", async () => {
  const key = "or-secret-token";
  const agent = new OpenRouterAgent({
    model: "m",
    apiKey: key,
    endpoint: "https://provider.invalid",
    execution: execution(),
    fetch: async () =>
      new Response(`authorization: Bearer ${key}`, { status: 401 }),
  });
  await assert.rejects(agent.choose(context()), (error: Error) => {
    assert.ok(!error.message.includes(key));
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
});
