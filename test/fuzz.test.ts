import assert from "node:assert/strict";
import test from "node:test";
import { RequestSchema, ServerResponseSchema } from "../src/protocol.js";
import { FirstLegalAgent } from "../src/agents/test-agents.js";
import { planTournament } from "../src/tournaments/scheduler.js";

function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
}
test("protocol parsers never throw on deterministic random JSON-like inputs", () => {
  const next = rng(17);
  for (let index = 0; index < 500; index += 1) {
    const value =
      index % 5 === 0
        ? null
        : index % 5 === 1
          ? next()
          : index % 5 === 2
            ? [next()]
            : index % 5 === 3
              ? {
                  protocolVersion: next(),
                  requestId: String(next()),
                  type: "choose",
                }
              : String(next());
    assert.doesNotThrow(() => RequestSchema.safeParse(value));
    assert.doesNotThrow(() => ServerResponseSchema.safeParse(value));
  }
});
test("scheduler invariants hold across generated seeds and agent order", () => {
  const next = rng(29);
  for (let index = 0; index < 100; index += 1) {
    const agents = [
      new FirstLegalAgent("a"),
      new FirstLegalAgent("b"),
      new FirstLegalAgent("c"),
    ];
    const plan = planTournament(
      {
        id: `fuzz-${index}`,
        format: "round_robin",
        masterSeed: next(),
        gamesPerPairing: (next() % 3) + 1,
        seatSwapped: true,
      },
      index % 2 ? agents : [...agents].reverse(),
      {
        maxActions: 1,
        serverCommand: "fake",
        serverCwd: ".",
        serverTimeoutMs: 1,
      },
    );
    assert.equal(
      new Set(plan.matches.map((match) => match.id)).size,
      plan.matches.length,
    );
    for (const seed of plan.gameSeeds) assert.ok(Number.isSafeInteger(seed));
  }
});
