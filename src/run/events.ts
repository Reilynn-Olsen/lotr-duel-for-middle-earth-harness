import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { redactSecrets } from "../agents/types.js";

export const EVENT_SCHEMA_VERSION = 1;
export const EventTypeSchema = z.enum([
  "run_created",
  "run_configuration_resolved",
  "match_scheduled",
  "game_started",
  "game_interrupted",
  "decision_requested",
  "agent_attempt_completed",
  "agent_attempt_failed",
  "decision_accepted",
  "decision_rejected",
  "state_transition",
  "checkpoint_committed",
  "game_completed",
  "game_forfeited",
  "game_failed",
  "match_completed",
  "run_cancelled",
  "run_completed",
]);
export type EventType = z.infer<typeof EventTypeSchema>;
export const RunEventSchema = z
  .object({
    eventSchemaVersion: z.literal(EVENT_SCHEMA_VERSION),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime(),
    type: EventTypeSchema,
    runId: z.string().min(1).optional(),
    matchId: z.string().min(1).optional(),
    gameId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    agentVersion: z.string().min(1).optional(),
    seat: z.enum(["fellowship", "sauron"]).optional(),
    turn: z.number().int().nonnegative().optional(),
    seed: z.number().int().nonnegative().optional(),
    beforeStateHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    afterStateHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    actionId: z.string().min(1).optional(),
    latencyMs: z.number().nonnegative().optional(),
    usage: z
      .object({
        promptTokens: z.number().nonnegative().optional(),
        completionTokens: z.number().nonnegative().optional(),
        totalTokens: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    estimatedCost: z.number().nonnegative().optional(),
    errorClass: z.string().min(1).optional(),
    error: z.string().max(2_000).optional(),
    protocolVersion: z.number().int().positive().optional(),
    harnessRevision: z.string().min(1).optional(),
    serverRevision: z.string().min(1).optional(),
    promptHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    modelParameters: z.record(z.unknown()).optional(),
    pricing: z
      .object({
        version: z.string().min(1),
        source: z.enum(["provider", "calculated", "unavailable"]).optional(),
      })
      .strict()
      .optional(),
    pairedSeedId: z.string().min(1).optional(),
    fellowshipAgentId: z.string().min(1).optional(),
    sauronAgentId: z.string().min(1).optional(),
    setupFactors: z.record(z.string()).optional(),
    status: z.string().min(1).optional(),
    outcome: z.string().min(1).optional(),
    winner: z.enum(["fellowship", "sauron"]).nullable().optional(),
    actions: z.number().int().nonnegative().optional(),
    rawOutput: z.string().max(20_000).optional(),
    configuration: z.record(z.unknown()).optional(),
    checkpoint: z.string().min(1).optional(),
  })
  .strict();
export type RunEvent = z.infer<typeof RunEventSchema>;
export type EventInput = Omit<
  RunEvent,
  "eventSchemaVersion" | "sequence" | "timestamp"
>;
export class EventLogCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventLogCorruptionError";
  }
}

export class EventLog {
  private sequence: number | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly path: string,
    private readonly options: {
      includeRawOutput?: boolean;
      secrets?: readonly string[];
    } = {},
  ) {}
  async append(input: EventInput): Promise<RunEvent> {
    const write = async (): Promise<RunEvent> => {
      if (this.sequence === undefined)
        this.sequence = (await readEventLog(this.path)).at(-1)?.sequence ?? 0;
      const raw = {
        ...sanitizeEvent(input, this.options),
        eventSchemaVersion: EVENT_SCHEMA_VERSION,
        sequence: this.sequence + 1,
        timestamp: new Date().toISOString(),
      };
      const event = RunEventSchema.parse(raw);
      await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(this.path, "a");
      try {
        await handle.write(`${JSON.stringify(event)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.sequence = event.sequence;
      return event;
    };
    const result = this.queue.then(write, write);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function readEventLog(path: string): Promise<RunEvent[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines = text.split("\n");
  const complete = text.endsWith("\n")
    ? lines.slice(0, -1)
    : lines.slice(0, -1);
  const events: RunEvent[] = [];
  for (let index = 0; index < complete.length; index += 1) {
    try {
      events.push(RunEventSchema.parse(JSON.parse(complete[index]!)));
    } catch (error) {
      throw new EventLogCorruptionError(
        `invalid event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!text.endsWith("\n") && lines.at(-1)?.trim()) {
    try {
      events.push(RunEventSchema.parse(JSON.parse(lines.at(-1)!)));
    } catch {
      /* A crash can leave only the final line truncated; ignore it. */
    }
  }
  for (let index = 0; index < events.length; index += 1)
    if (events[index]!.sequence !== index + 1)
      throw new EventLogCorruptionError(
        `event sequence gap or duplicate at sequence ${events[index]!.sequence}`,
      );
  return events;
}

export interface EventProjection {
  runId?: string;
  status: "running" | "completed" | "cancelled";
  games: Record<
    string,
    {
      status: string;
      outcome?: string;
      winner?: string | null;
      actions?: number;
      totalCost: number;
    }
  >;
  totalCost: number;
}
export function projectEvents(events: readonly RunEvent[]): EventProjection {
  const projection: EventProjection = {
    runId: events.find((event) => event.runId)?.runId,
    status: events.some((event) => event.type === "run_cancelled")
      ? "cancelled"
      : events.some((event) => event.type === "run_completed")
        ? "completed"
        : "running",
    games: {},
    totalCost: 0,
  };
  for (const event of events) {
    if (event.gameId) {
      const game = projection.games[event.gameId] ?? {
        status: "running",
        totalCost: 0,
      };
      if (
        event.type === "game_completed" ||
        event.type === "game_forfeited" ||
        event.type === "game_failed"
      ) {
        game.status = event.type.replace("game_", "");
        game.outcome = event.outcome;
        game.winner = event.winner;
        game.actions = event.actions;
      }
      if (event.estimatedCost !== undefined) {
        game.totalCost += event.estimatedCost;
        projection.totalCost += event.estimatedCost;
      }
      projection.games[event.gameId] = game;
    }
  }
  return projection;
}

function sanitizeEvent(
  input: EventInput,
  options: { includeRawOutput?: boolean; secrets?: readonly string[] },
): EventInput {
  const value = structuredClone(input) as EventInput;
  if (!options.includeRawOutput) delete value.rawOutput;
  for (const key of ["error", "errorClass"] as const)
    if (value[key]) value[key] = redactSecrets(value[key]!, options.secrets);
  return value;
}
export async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, path);
}
export async function writeAtomicText(
  path: string,
  value: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, value);
  await rename(temp, path);
}
