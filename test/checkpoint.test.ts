import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "../src/agents/types.js";
import {
  commitCheckpoint,
  loadCheckpoint,
  recoverRun,
  ResumeCompatibilityError,
  RunLock,
} from "../src/tournaments/checkpoint.js";
import { EventLog } from "../src/run/events.js";
import { planTournament } from "../src/tournaments/scheduler.js";

const agent = (id: string): Agent => ({
  metadata: { id, version: "1", provider: "test" },
  choose: async (context) => ({
    actionId: context.legalActions[0]?.actionId ?? "",
    agent: { id, version: "1", provider: "test" },
    latencyMs: 0,
    attempts: 1,
  }),
});
const plan = () =>
  planTournament(
    {
      id: "resume-run",
      format: "head_to_head",
      masterSeed: 1,
      gamesPerPairing: 1,
      seatSwapped: true,
    },
    [agent("a"), agent("b")],
    {
      maxActions: 1,
      serverCommand: "server",
      serverCwd: ".",
      serverTimeoutMs: 1,
    },
  );
async function run(): Promise<{ directory: string; events: EventLog }> {
  const directory = await mkdtemp(join(tmpdir(), "lotr-resume-"));
  return { directory, events: new EventLog(join(directory, "events.jsonl")) };
}
const base = (matchId: string, gameId = matchId) => ({
  runId: "resume-run",
  matchId,
  gameId,
  seed: 1,
  protocolVersion: 1,
});
test("before a match starts recovers it as not started", async () => {
  const { directory, events } = await run();
  const state = await recoverRun(
    plan(),
    events.path,
    join(directory, "checkpoint.json"),
  );
  assert.ok(state.matches.every((match) => match.status === "not_started"));
});
test("agent-request and post-decision interruptions restart only that match with a new attempt", async () => {
  const { directory, events } = await run();
  const first = plan().matches[0]!;
  await events.append({ type: "game_started", ...base(first.id) });
  await events.append({
    type: "decision_requested",
    ...base(first.id),
    seat: "sauron",
    turn: 0,
  });
  await events.append({
    type: "decision_accepted",
    ...base(first.id),
    seat: "sauron",
    turn: 0,
    actionId: "issued-action",
  });
  const state = await recoverRun(
    plan(),
    events.path,
    join(directory, "checkpoint.json"),
  );
  assert.equal(
    state.matches.find((match) => match.match.id === first.id)?.status,
    "incomplete",
  );
  assert.match(
    state.matches.find((match) => match.match.id === first.id)?.attemptId ?? "",
    /retry-2$/,
  );
});
test("game completion is authoritative even if checkpoint update did not occur", async () => {
  const { directory, events } = await run();
  const first = plan().matches[0]!;
  await events.append({ type: "game_started", ...base(first.id) });
  await events.append({
    type: "game_completed",
    ...base(first.id),
    outcome: "winner",
    winner: "fellowship",
    actions: 1,
  });
  const state = await recoverRun(
    plan(),
    events.path,
    join(directory, "checkpoint.json"),
  );
  assert.equal(
    state.matches.find((match) => match.match.id === first.id)?.status,
    "completed",
  );
});
test("atomic checkpoint replacement tolerates an abandoned temporary file", async () => {
  const { directory, events } = await run();
  await events.append({ type: "run_created", runId: "resume-run" });
  const checkpoint = join(directory, "checkpoint.json");
  await commitCheckpoint(
    checkpoint,
    plan(),
    await (await import("../src/run/events.js")).readEventLog(events.path),
  );
  await writeFile(
    join(directory, ".checkpoint.json.interrupted.tmp"),
    "partial",
  );
  assert.equal((await loadCheckpoint(checkpoint))?.runId, "resume-run");
});
test("partial completion preserves completed matches and budget accounting", async () => {
  const { directory, events } = await run();
  const tournament = plan();
  const first = tournament.matches[0]!;
  await events.append({
    type: "agent_attempt_completed",
    ...base(first.id),
    estimatedCost: 0.5,
  });
  await events.append({
    type: "game_completed",
    ...base(first.id),
    outcome: "winner",
    winner: "fellowship",
    actions: 1,
  });
  const checkpoint = await commitCheckpoint(
    join(directory, "checkpoint.json"),
    tournament,
    await (await import("../src/run/events.js")).readEventLog(events.path),
  );
  const state = await recoverRun(
    tournament,
    events.path,
    join(directory, "checkpoint.json"),
  );
  assert.equal(checkpoint.totalCost, 0.5);
  assert.equal(state.totalCost, 0.5);
  assert.equal(
    state.matches.filter((match) => match.status === "completed").length,
    1,
  );
});
test("resume refuses semantic configuration changes", async () => {
  const { directory, events } = await run();
  const tournament = plan();
  await events.append({ type: "run_created", runId: "resume-run" });
  await commitCheckpoint(
    join(directory, "checkpoint.json"),
    tournament,
    await (await import("../src/run/events.js")).readEventLog(events.path),
  );
  const changed = planTournament(
    {
      id: "resume-run",
      format: "head_to_head",
      masterSeed: 2,
      gamesPerPairing: 1,
      seatSwapped: true,
    },
    [agent("a"), agent("b")],
    {
      maxActions: 1,
      serverCommand: "server",
      serverCwd: ".",
      serverTimeoutMs: 1,
    },
  );
  await assert.rejects(
    recoverRun(changed, events.path, join(directory, "checkpoint.json")),
    ResumeCompatibilityError,
  );
});
test("two simultaneous resume attempts cannot acquire the same lock", async () => {
  const { directory } = await run();
  const first = await RunLock.acquire(directory);
  await assert.rejects(RunLock.acquire(directory), /already locked/);
  await first.release();
  const second = await RunLock.acquire(directory);
  await second.release();
});
