import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EVENT_SCHEMA_VERSION,
  EventLog,
  EventLogCorruptionError,
  RunEventSchema,
  projectEvents,
  readEventLog,
} from "../src/run/events.js";

async function path(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "lotr-events-")), name);
}
const event = (
  type: "run_created" | "game_started" | "game_completed" = "run_created",
) => ({
  type,
  runId: "run-1",
  gameId: type === "run_created" ? undefined : "game-1",
  matchId: type === "run_created" ? undefined : "match-1",
  seed: type === "run_created" ? undefined : 4,
  protocolVersion: 1,
});
test("appends, fsyncs, and reads validated events", async () => {
  const file = await path("events.jsonl");
  const log = new EventLog(file);
  const first = await log.append(event());
  const second = await log.append(event("game_started"));
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(
    (await readEventLog(file)).map((value) => value.sequence),
    [1, 2],
  );
});
test("recovery ignores only a truncated final line", async () => {
  const file = await path("events.jsonl");
  const log = new EventLog(file);
  await log.append(event());
  await appendFile(file, '{"eventSchemaVersion":1,"sequence":2');
  assert.equal((await readEventLog(file)).length, 1);
});
test("recovery rejects mid-file corruption and sequence gaps", async () => {
  const file = await path("events.jsonl");
  const valid = RunEventSchema.parse({
    ...event(),
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    sequence: 1,
    timestamp: new Date().toISOString(),
  });
  await writeFile(
    file,
    `${JSON.stringify(valid)}\nnot-json\n${JSON.stringify({ ...valid, sequence: 3 })}\n`,
  );
  await assert.rejects(readEventLog(file), EventLogCorruptionError);
  const gap = await path("gap.jsonl");
  await writeFile(
    gap,
    `${JSON.stringify(valid)}\n${JSON.stringify({ ...valid, sequence: 3 })}\n`,
  );
  await assert.rejects(readEventLog(gap), /sequence gap/);
});
test("redacts secrets and prevents hidden observations from entering the schema", async () => {
  const file = await path("events.jsonl");
  const log = new EventLog(file, { secrets: ["secret-key"] });
  const stored = await log.append({
    ...event(),
    error: "authorization: Bearer secret-key",
  });
  assert.ok(!stored.error?.includes("secret-key"));
  assert.match(stored.error ?? "", /\[REDACTED\]/);
  assert.throws(() =>
    RunEventSchema.parse({ ...stored, observation: "hidden card" }),
  );
});
test("projects completed game summaries from events", async () => {
  const file = await path("events.jsonl");
  const log = new EventLog(file);
  await log.append(event("game_started"));
  await log.append({
    ...event("game_completed"),
    outcome: "winner",
    winner: "fellowship",
    actions: 4,
    estimatedCost: 0.2,
  });
  const projection = projectEvents(await readEventLog(file));
  assert.equal(projection.status, "running");
  assert.deepEqual(projection.games["game-1"], {
    status: "completed",
    outcome: "winner",
    winner: "fellowship",
    actions: 4,
    totalCost: 0.2,
  });
});
test("concurrent games cannot interleave JSONL writes", async () => {
  const file = await path("events.jsonl");
  const log = new EventLog(file);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      log.append({
        type: "game_started",
        runId: "run-1",
        matchId: `match-${index}`,
        gameId: `game-${index}`,
        seed: index,
        protocolVersion: 1,
      }),
    ),
  );
  const events = await readEventLog(file);
  assert.deepEqual(
    events.map((value) => value.sequence),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
});
