import assert from "node:assert/strict";
import test from "node:test";
import { RunEvent, RunEventSchema } from "../src/run/events.js";
import { evaluateEvents, evaluationCsv } from "../src/results/statistics.js";

let sequence = 0;
function event(
  type: RunEvent["type"],
  values: Record<string, unknown> = {},
): RunEvent {
  sequence += 1;
  return RunEventSchema.parse({
    eventSchemaVersion: 1,
    sequence,
    timestamp: new Date(0).toISOString(),
    type,
    runId: "run",
    ...values,
  });
}
function fixture(): RunEvent[] {
  sequence = 0;
  return [
    event("match_scheduled", {
      matchId: "m1",
      gameId: "m1",
      seed: 1,
      pairedSeedId: "p1",
      fellowshipAgentId: "a",
      sauronAgentId: "b",
      setupFactors: { chapter: "one" },
    }),
    event("match_scheduled", {
      matchId: "m2",
      gameId: "m2",
      seed: 1,
      pairedSeedId: "p1",
      fellowshipAgentId: "b",
      sauronAgentId: "a",
      setupFactors: { chapter: "one" },
    }),
    event("decision_accepted", {
      matchId: "m1",
      gameId: "m1",
      agentId: "a",
      latencyMs: 10,
      usage: { promptTokens: 2, completionTokens: 3 },
      estimatedCost: 0.2,
    }),
    event("decision_accepted", {
      matchId: "m2",
      gameId: "m2",
      agentId: "b",
      latencyMs: 20,
      usage: { promptTokens: 4, completionTokens: 5 },
      estimatedCost: 0.3,
    }),
    event("agent_attempt_failed", {
      matchId: "m1",
      gameId: "m1",
      errorClass: "timeout",
    }),
    event("game_completed", {
      matchId: "m1",
      gameId: "m1",
      outcome: "winner",
      winner: "fellowship",
      actions: 2,
    }),
    event("game_completed", {
      matchId: "m2",
      gameId: "m2",
      outcome: "shared_victory",
      winner: null,
      actions: 2,
    }),
  ];
}
test("calculates descriptive counts, estimates, latency, token, cost, seat, and paired results", () => {
  const summary = evaluateEvents(fixture());
  assert.deepEqual(summary.counts, {
    completed: 2,
    wins: 1,
    losses: 1,
    draws: 1,
    failures: 0,
    forfeits: 0,
    cancellations: 0,
  });
  assert.equal(summary.winRate.rate, 0.5);
  assert.ok(summary.winRate.wilson95);
  assert.equal(summary.drawRate.rate, 0.5);
  assert.deepEqual(summary.latencyMs, {
    median: 10,
    p90: 20,
    p95: 20,
    p99: 20,
  });
  assert.deepEqual(summary.tokens, {
    input: 6,
    output: 8,
    total: 14,
    missingUsageEvents: 0,
  });
  assert.equal(summary.costs.perWin, 0.5);
  assert.equal(summary.bySeat.fellowship!.wins, 1);
  assert.equal(summary.paired.completePairs, 1);
  assert.deepEqual(summary.paired.incompletePairs, []);
  assert.match(evaluationCsv(summary).overview!, /win_rate/);
});
test("handles no games, all draws, incomplete pairs, missing costs, and failure statuses without NaN", () => {
  sequence = 0;
  const empty = evaluateEvents([]);
  assert.equal(empty.winRate.rate, null);
  assert.equal(empty.costs.perGame, null);
  const events = [
    event("match_scheduled", {
      matchId: "m",
      gameId: "m",
      seed: 1,
      pairedSeedId: "incomplete",
      fellowshipAgentId: "a",
      sauronAgentId: "b",
    }),
    event("decision_accepted", { matchId: "m", gameId: "m", latencyMs: 1 }),
    event("game_completed", {
      matchId: "m",
      gameId: "m",
      outcome: "shared_victory",
      winner: null,
      actions: 1,
    }),
    event("game_failed", {
      matchId: "failed",
      gameId: "failed",
      outcome: "failed",
      actions: 0,
    }),
  ];
  const summary = evaluateEvents(events);
  assert.equal(summary.drawRate.rate, 1);
  assert.equal(summary.counts.failures, 1);
  assert.deepEqual(summary.paired.incompletePairs, ["incomplete"]);
  assert.equal(summary.costs.missingCostEvents, 1);
  assert.ok(!JSON.stringify(summary).includes("NaN"));
});
