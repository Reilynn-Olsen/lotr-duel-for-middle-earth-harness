import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardView,
  renderDashboard,
  shouldUseDashboard,
  TerminalDashboard,
} from "../src/run/dashboard.js";
import { RunEventSchema } from "../src/run/events.js";

let sequence = 0;
function event(
  type: ReturnType<typeof RunEventSchema.parse>["type"],
  values: Record<string, unknown> = {},
) {
  sequence += 1;
  return RunEventSchema.parse({
    eventSchemaVersion: 1,
    sequence,
    timestamp: new Date(sequence * 1000).toISOString(),
    type,
    runId: "run",
    ...values,
  });
}
test("event-to-view transformation reports active matches, leaderboard, and errors", () => {
  sequence = 0;
  const events = [
    event("match_scheduled", {
      matchId: "m",
      gameId: "m",
      seed: 7,
      fellowshipAgentId: "a",
      sauronAgentId: "b",
    }),
    event("game_started", { matchId: "m", gameId: "m", turn: 2 }),
    event("decision_accepted", { matchId: "m", gameId: "m", turn: 3 }),
    event("agent_attempt_failed", {
      matchId: "m",
      gameId: "m",
      errorClass: "timeout",
    }),
  ];
  const view = dashboardView(events, 5_000);
  assert.equal(view.total, 1);
  assert.equal(view.active[0]?.seed, 7);
  assert.equal(view.active[0]?.turn, 3);
  assert.equal(view.active[0]?.latest, "decision_accepted");
  assert.equal(view.errors.timeouts, 1);
  assert.match(renderDashboard(view, 30), /Tournament live/);
});
test("non-TTY and CI select line logging", () => {
  const stream = { isTTY: false } as NodeJS.WriteStream;
  assert.equal(shouldUseDashboard(stream, stream, {}), false);
  const tty = { isTTY: true } as NodeJS.WriteStream;
  assert.equal(shouldUseDashboard(tty, tty, { CI: "true" }), false);
  assert.equal(shouldUseDashboard(tty, tty, {}), true);
});
test("empty and narrow views remain safe", () => {
  const view = dashboardView([], 10);
  const text = renderDashboard(view, 12);
  assert.ok(text.includes("0/0"));
  assert.ok(!text.includes("NaN"));
});
test("dashboard cleanup restores cursor", () => {
  const writes: string[] = [];
  const stream = {
    columns: 80,
    write: (value: string) => {
      writes.push(value);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const dashboard = new TerminalDashboard(
    "/missing/events.jsonl",
    stream,
    10_000,
  );
  dashboard.start();
  dashboard.stop();
  assert.ok(writes.some((value) => value.includes("?25l")));
  assert.ok(writes.some((value) => value.includes("?25h")));
});
