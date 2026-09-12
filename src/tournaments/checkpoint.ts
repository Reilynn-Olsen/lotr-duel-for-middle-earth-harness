import { createHash } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { PROTOCOL_VERSION } from "../protocol.js";
import {
  EventLogCorruptionError,
  RunEvent,
  readEventLog,
} from "../run/events.js";
import { TournamentMatch, TournamentPlan } from "./scheduler.js";

export const CHECKPOINT_VERSION = 1;
const CheckpointSchema = z
  .object({
    checkpointVersion: z.literal(CHECKPOINT_VERSION),
    runId: z.string().min(1),
    planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    completedMatchIds: z.array(z.string()),
    totalCost: z.number().nonnegative(),
    lastSequence: z.number().int().nonnegative(),
  })
  .strict();
export type RunCheckpoint = z.infer<typeof CheckpointSchema>;
export type RecoveredMatchStatus =
  | "completed"
  | "forfeited"
  | "failed"
  | "skipped"
  | "incomplete"
  | "not_started";
export interface RecoveredMatch {
  match: TournamentMatch;
  status: RecoveredMatchStatus;
  attemptId?: string;
}
export class ResumeCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeCompatibilityError";
  }
}
export class RunLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLockError";
  }
}

export function planFingerprint(plan: TournamentPlan): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        config: plan.config,
        protocolVersion: PROTOCOL_VERSION,
        matches: plan.matches.map((match) => ({
          id: match.id,
          seed: match.seed,
          fellowship: match.fellowship.metadata,
          sauron: match.sauron.metadata,
          pairedSeedId: match.pairedSeedId,
          maxActions: match.maxActions,
          serverCommand: match.serverCommand,
          serverCwd: match.serverCwd,
          serverTimeoutMs: match.serverTimeoutMs,
        })),
      }),
    )
    .digest("hex");
}
export async function loadCheckpoint(
  path: string,
): Promise<RunCheckpoint | undefined> {
  try {
    return CheckpointSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ResumeCompatibilityError(
      `invalid checkpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export async function commitCheckpoint(
  path: string,
  plan: TournamentPlan,
  events: readonly RunEvent[],
): Promise<RunCheckpoint> {
  const checkpoint: RunCheckpoint = {
    checkpointVersion: CHECKPOINT_VERSION,
    runId: plan.config.id,
    planFingerprint: planFingerprint(plan),
    protocolVersion: PROTOCOL_VERSION,
    completedMatchIds: [
      ...new Set(
        events
          .filter(
            (event) =>
              event.type === "game_completed" ||
              event.type === "game_forfeited" ||
              event.type === "game_failed",
          )
          .map((event) => event.matchId)
          .filter((id): id is string => Boolean(id)),
      ),
    ].sort(),
    totalCost: events
      .filter((event) => event.type === "agent_attempt_completed")
      .reduce((sum, event) => sum + (event.estimatedCost ?? 0), 0),
    lastSequence: events.at(-1)?.sequence ?? 0,
  };
  CheckpointSchema.parse(checkpoint);
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temp, `${JSON.stringify(checkpoint)}\n`);
  await rename(temp, path);
  return checkpoint;
}
export async function recoverRun(
  plan: TournamentPlan,
  eventsPath: string,
  checkpointPath: string,
  _options: { allowNonSemanticMetadataOverride?: boolean } = {},
): Promise<{
  events: RunEvent[];
  checkpoint?: RunCheckpoint;
  matches: RecoveredMatch[];
  totalCost: number;
}> {
  let events: RunEvent[];
  try {
    events = await readEventLog(eventsPath);
  } catch (error) {
    if (error instanceof EventLogCorruptionError) throw error;
    throw new ResumeCompatibilityError(
      `cannot recover event log: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const checkpoint = await loadCheckpoint(checkpointPath);
  const fingerprint = planFingerprint(plan);
  if (
    checkpoint &&
    (checkpoint.runId !== plan.config.id ||
      checkpoint.protocolVersion !== PROTOCOL_VERSION ||
      checkpoint.planFingerprint !== fingerprint)
  )
    throw new ResumeCompatibilityError(
      "saved tournament configuration, agents, seats, seed, server, prompts, or protocol is incompatible with this resume",
    );
  const state = new Map<string, RecoveredMatchStatus>();
  for (const event of events)
    if (event.matchId) {
      if (event.type === "game_completed")
        state.set(event.matchId, "completed");
      else if (event.type === "game_forfeited")
        state.set(event.matchId, "forfeited");
      else if (event.type === "game_failed") state.set(event.matchId, "failed");
      else if (
        event.type === "game_started" ||
        event.type === "decision_requested" ||
        event.type === "decision_accepted"
      )
        if (!state.has(event.matchId)) state.set(event.matchId, "incomplete");
    }
  const matches = plan.matches.map((match) => {
    const status = state.get(match.id) ?? "not_started";
    return {
      match,
      status,
      attemptId:
        status === "incomplete"
          ? `${match.id}-retry-${events.filter((event) => event.matchId === match.id && event.type === "game_started").length + 1}`
          : undefined,
    };
  });
  return {
    events,
    checkpoint,
    matches,
    totalCost:
      checkpoint?.totalCost ??
      events
        .filter((event) => event.type === "agent_attempt_completed")
        .reduce((sum, event) => sum + (event.estimatedCost ?? 0), 0),
  };
}

export class RunLock {
  private constructor(private readonly path: string) {}
  static async acquire(runDirectory: string): Promise<RunLock> {
    const path = join(runDirectory, ".resume.lock");
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${process.pid}\n`);
      await handle.sync();
      await handle.close();
      return new RunLock(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid: number | undefined;
      try {
        pid = Number((await readFile(path, "utf8")).trim());
        process.kill(pid, 0);
      } catch (lockError: unknown) {
        if ((lockError as NodeJS.ErrnoException).code === "ESRCH") {
          await unlink(path);
          return RunLock.acquire(runDirectory);
        }
      }
      throw new RunLockError(
        `run is already locked by process ${pid ?? "unknown"}`,
      );
    }
  }
  async release(): Promise<void> {
    await unlink(this.path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
