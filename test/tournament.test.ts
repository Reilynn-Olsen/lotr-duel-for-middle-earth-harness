import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agents/types.js";
import {
  executeTournament,
  planTournament,
  stableMatchId,
} from "../src/tournaments/scheduler.js";

const agent = (id: string): Agent => ({
  metadata: { id, version: "1", provider: "test" },
  choose: async (context) => ({
    actionId: context.legalActions[0]?.actionId ?? "",
    agent: { id, version: "1", provider: "test" },
    latencyMs: 0,
    attempts: 1,
  }),
});
const game = {
  maxActions: 1,
  serverCommand: "fake",
  serverCwd: ".",
  serverTimeoutMs: 1,
};
const config = {
  id: "benchmark",
  format: "head_to_head" as const,
  masterSeed: 99,
  gamesPerPairing: 2,
  seatSwapped: true,
};
test("stable match IDs and schedules are independent of agent input order", () => {
  const first = planTournament(config, [agent("b"), agent("a")], game);
  const second = planTournament(config, [agent("a"), agent("b")], game);
  assert.deepEqual(first.gameSeeds, second.gameSeeds);
  assert.deepEqual(
    first.matches.map((match) => match.id),
    second.matches.map((match) => match.id),
  );
  assert.equal(
    stableMatchId(config, "a", "b", first.gameSeeds[0]!),
    stableMatchId(config, "a", "b", first.gameSeeds[0]!),
  );
});
test("round robin produces each pairing once and optional explicit self play", () => {
  const round = planTournament(
    {
      id: "rr",
      format: "round_robin",
      masterSeed: 1,
      gamesPerPairing: 1,
      seatSwapped: false,
    },
    [agent("a"), agent("b"), agent("c")],
    game,
  );
  assert.equal(round.matches.length, 3);
  const self = planTournament(
    {
      id: "self",
      format: "round_robin",
      masterSeed: 1,
      gamesPerPairing: 1,
      seatSwapped: false,
      includeSelfPlay: true,
    },
    [agent("a"), agent("b")],
    game,
  );
  assert.equal(self.matches.length, 3);
});
test("seat swaps preserve the paired seed and no duplicate match IDs", () => {
  const plan = planTournament(
    { ...config, gamesPerPairing: 1 },
    [agent("a"), agent("b")],
    game,
  );
  assert.equal(plan.matches.length, 2);
  assert.equal(plan.matches[0]!.seed, plan.matches[1]!.seed);
  assert.equal(plan.matches[0]!.pairedSeedId, plan.matches[1]!.pairedSeedId);
  assert.notEqual(
    plan.matches[0]!.fellowship.metadata.id,
    plan.matches[1]!.fellowship.metadata.id,
  );
  assert.equal(
    new Set(plan.matches.map((match) => match.id)).size,
    plan.matches.length,
  );
});
test("duplicate agent IDs are rejected", () =>
  assert.throws(
    () => planTournament(config, [agent("same"), agent("same")], game),
    /duplicate agent IDs/,
  ));
test("execution respects concurrency and returns plan order despite completion order", async () => {
  const plan = planTournament(
    { ...config, gamesPerPairing: 3 },
    [agent("a"), agent("b")],
    game,
  );
  let active = 0;
  let maximum = 0;
  const executions = await executeTournament(
    plan,
    { concurrency: 2 },
    async (match) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) =>
        setTimeout(resolve, Number(match.seed % 3)),
      );
      active -= 1;
      return {
        id: match.id,
        seed: match.seed,
        fellowship: match.fellowship.metadata.id,
        sauron: match.sauron.metadata.id,
        outcome: "winner",
        winner: "fellowship",
        actions: 1,
        engineVersion: "test",
        totalCost: 0,
        durationMs: 1,
      };
    },
  );
  assert.ok(maximum <= 2);
  assert.deepEqual(
    executions.map((entry) => entry.match.id),
    [...plan.matches].map((match) => match.id),
  );
});
test("run budgets stop new work and individual failures do not corrupt other matches", async () => {
  const plan = planTournament(
    { ...config, gamesPerPairing: 2 },
    [agent("a"), agent("b")],
    game,
  );
  let calls = 0;
  const executions = await executeTournament(
    plan,
    { concurrency: 1, budget: { perRunUsd: 1 } },
    async (match) => {
      calls += 1;
      if (calls === 1) throw new Error("one match failed");
      return {
        id: match.id,
        seed: match.seed,
        fellowship: "a",
        sauron: "b",
        outcome: "winner",
        winner: "fellowship",
        actions: 1,
        engineVersion: "test",
        totalCost: 1,
        durationMs: 1,
      };
    },
  );
  assert.ok(executions.some((entry) => entry.status === "failed"));
  assert.ok(executions.some((entry) => entry.status === "skipped"));
});
test("cancellation stops scheduling and marks unstarted matches", async () => {
  const plan = planTournament(
    { ...config, gamesPerPairing: 3 },
    [agent("a"), agent("b")],
    game,
  );
  const controller = new AbortController();
  let calls = 0;
  const executions = await executeTournament(
    plan,
    { concurrency: 1, cancellationGraceMs: 0, signal: controller.signal },
    async (match) => {
      calls += 1;
      if (calls === 1) {
        controller.abort();
        throw new Error("cancelled");
      }
      return {
        id: match.id,
        seed: match.seed,
        fellowship: "a",
        sauron: "b",
        outcome: "winner",
        winner: "fellowship",
        actions: 1,
        engineVersion: "test",
        totalCost: 0,
        durationMs: 1,
      };
    },
  );
  assert.equal(calls, 1);
  assert.ok(executions.some((entry) => entry.status === "cancelled"));
});
