import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkReport } from "../src/results/benchmark-report.js";
import { evaluateEvents } from "../src/results/statistics.js";
import { RunEventSchema } from "../src/run/events.js";

const event = RunEventSchema.parse({
  eventSchemaVersion: 1,
  sequence: 1,
  timestamp: new Date(0).toISOString(),
  type: "run_completed",
  runId: "run",
});
test("benchmark report contains offline structural sections and no external assets", () => {
  const html = benchmarkReport({
    title: "Local baseline",
    evaluation: evaluateEvents([event]),
    config: { protocolVersion: 1 },
    games: [],
    events: [event],
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  for (const section of [
    "Leaderboard And Confidence",
    "Cost Versus Performance",
    "Head-to-Head Matrix",
    "Paired Seed Analysis",
    "Reproducibility Metadata",
    "Games",
  ])
    assert.ok(html.includes(section));
  assert.ok(html.includes("<style>"));
  assert.ok(html.includes("<script>"));
  assert.ok(!html.includes("https://"));
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error("report script is missing");
  assert.doesNotThrow(() => new Function(script));
});
test("untrusted config, event, and game content cannot inject markup", () => {
  const html = benchmarkReport({
    title: "<img src=x onerror=alert(1)>",
    evaluation: evaluateEvents([event]),
    config: { model: "<script>alert(1)</script>", apiKey: "secret" },
    games: [
      {
        id: "<svg/onload=alert(1)>",
        seed: 1,
        fellowship: "x",
        sauron: "y",
        outcome: "failed",
        winner: null,
        actions: 0,
        engineVersion: null,
        error: "<b>bad</b>",
        totalCost: 0,
        durationMs: 0,
      },
    ],
    events: [event],
  });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<svg/onload"));
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("secret"));
  assert.ok(html.includes("\\u003cscript"));
});
