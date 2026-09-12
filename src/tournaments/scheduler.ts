import { createHash } from "node:crypto";
import { Agent } from "../agents/types.js";
import { PROTOCOL_VERSION } from "../protocol.js";
import { GameResult, GameSpec } from "./game-runner.js";

export const TOURNAMENT_CONFIG_VERSION = 1;
export type TournamentFormat = "head_to_head" | "round_robin" | "self_play";
export type MatchStatus =
  | "completed"
  | "forfeited"
  | "failed"
  | "cancelled"
  | "skipped";
export interface TournamentConfig {
  id: string;
  format: TournamentFormat;
  masterSeed: number;
  gamesPerPairing: number;
  seatSwapped: boolean;
  includeSelfPlay?: boolean;
  configurationVersion?: number;
}
export interface TournamentMatch extends GameSpec {
  tournamentId: string;
  pairedSeedId: string;
  pairing: readonly [string, string];
  seatSwapped: boolean;
}
export interface TournamentPlan {
  config: Required<TournamentConfig>;
  gameSeeds: readonly number[];
  matches: readonly TournamentMatch[];
}
export interface TournamentBudget {
  perGameUsd?: number;
  perRunUsd?: number;
}
export interface TournamentExecutionOptions {
  concurrency: number;
  matchTimeoutMs?: number;
  cancellationGraceMs?: number;
  failFast?: boolean;
  budget?: TournamentBudget;
  signal?: AbortSignal;
}
export interface MatchExecution {
  match: TournamentMatch;
  status: MatchStatus;
  result?: GameResult;
  error?: string;
}
export type MatchRunner = (
  match: TournamentMatch,
  signal: AbortSignal,
) => Promise<GameResult>;

export function planTournament(
  config: TournamentConfig,
  agents: readonly Agent[],
  game: Omit<GameSpec, "id" | "seed" | "fellowship" | "sauron" | "signal">,
): TournamentPlan {
  const resolved = validateConfig(config, agents);
  const ordered = [...agents].sort((left, right) =>
    left.metadata.id.localeCompare(right.metadata.id),
  );
  const byId = new Map(ordered.map((agent) => [agent.metadata.id, agent]));
  const seeds = generateSeeds(resolved.masterSeed, resolved.gamesPerPairing);
  const pairings = buildPairings(
    resolved.format,
    ordered.map((agent) => agent.metadata.id),
    resolved.includeSelfPlay,
  );
  const matches: TournamentMatch[] = [];
  for (const [firstId, secondId] of pairings)
    for (let index = 0; index < seeds.length; index += 1) {
      const seed = seeds[index]!;
      const pairedSeedId = stableId({
        tournamentId: resolved.id,
        pairing: [firstId, secondId],
        seed,
        index,
        version: resolved.configurationVersion,
        protocolVersion: PROTOCOL_VERSION,
      });
      const seats: Array<readonly [string, string, boolean]> =
        resolved.seatSwapped
          ? [
              [firstId, secondId, false],
              [secondId, firstId, true],
            ]
          : [[firstId, secondId, false]];
      for (const [fellowshipId, sauronId, seatSwapped] of seats) {
        const fellowship = byId.get(fellowshipId);
        const sauron = byId.get(sauronId);
        if (!fellowship || !sauron)
          throw new Error("scheduler could not resolve a planned agent");
        const id = stableMatchId(resolved, fellowshipId, sauronId, seed);
        matches.push({
          ...game,
          id,
          seed,
          fellowship,
          sauron,
          tournamentId: resolved.id,
          pairedSeedId,
          pairing: [firstId, secondId],
          seatSwapped,
        });
      }
    }
  const unique = new Set(matches.map((match) => match.id));
  if (unique.size !== matches.length)
    throw new Error("tournament configuration generated duplicate matches");
  return {
    config: resolved,
    gameSeeds: seeds,
    matches: matches.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function stableMatchId(
  config: Pick<TournamentConfig, "id" | "configurationVersion">,
  fellowshipId: string,
  sauronId: string,
  seed: number,
): string {
  return stableId({
    tournamentId: config.id,
    fellowshipId,
    sauronId,
    seed,
    configurationVersion:
      config.configurationVersion ?? TOURNAMENT_CONFIG_VERSION,
    protocolVersion: PROTOCOL_VERSION,
  });
}

export async function executeTournament(
  plan: TournamentPlan,
  options: TournamentExecutionOptions,
  runMatch: MatchRunner,
): Promise<MatchExecution[]> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1)
    throw new Error("tournament concurrency must be a positive integer");
  const controller = new AbortController();
  const external = () => {
    stopped = true;
    if (options.cancellationGraceMs === 0) controller.abort();
    else
      setTimeout(
        () => controller.abort(),
        options.cancellationGraceMs ?? 5_000,
      );
  };
  let stopped = false;
  options.signal?.addEventListener("abort", external, { once: true });
  const results: MatchExecution[] = [];
  let next = 0;
  let totalCost = 0;
  const worker = async (): Promise<void> => {
    while (!stopped) {
      const match = plan.matches[next++];
      if (!match) return;
      if (
        options.budget?.perRunUsd !== undefined &&
        totalCost >= options.budget.perRunUsd
      ) {
        stopped = true;
        results.push({
          match,
          status: "skipped",
          error: "run budget exhausted",
        });
        return;
      }
      try {
        const timeout = options.matchTimeoutMs
          ? AbortSignal.timeout(options.matchTimeoutMs)
          : undefined;
        const signal = timeout
          ? AbortSignal.any([controller.signal, timeout])
          : controller.signal;
        const result = await runMatch(match, signal);
        totalCost += result.totalCost;
        const status: MatchStatus =
          result.outcome === "failed"
            ? result.error?.includes("forfeit")
              ? "forfeited"
              : "failed"
            : "completed";
        const entry: MatchExecution =
          options.budget?.perGameUsd !== undefined &&
          result.totalCost > options.budget.perGameUsd
            ? {
                match,
                status: "failed",
                result,
                error: "game budget exhausted",
              }
            : { match, status, result };
        results.push(entry);
        if (options.failFast && entry.status === "failed") stopped = true;
      } catch (error) {
        const status: MatchStatus =
          controller.signal.aborted || options.signal?.aborted
            ? "cancelled"
            : "failed";
        results.push({
          match,
          status,
          error: error instanceof Error ? error.message : String(error),
        });
        if (options.failFast && status === "failed") stopped = true;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, plan.matches.length) },
      worker,
    ),
  );
  options.signal?.removeEventListener("abort", external);
  for (; next < plan.matches.length; next += 1)
    results.push({
      match: plan.matches[next]!,
      status: stopped || options.signal?.aborted ? "cancelled" : "skipped",
      error: stopped ? "scheduling stopped" : "not scheduled",
    });
  return results.sort((left, right) =>
    left.match.id.localeCompare(right.match.id),
  );
}

function validateConfig(
  config: TournamentConfig,
  agents: readonly Agent[],
): Required<TournamentConfig> {
  if (!config.id.trim()) throw new Error("tournament id is required");
  if (!Number.isSafeInteger(config.masterSeed))
    throw new Error("masterSeed must be a safe integer");
  if (!Number.isInteger(config.gamesPerPairing) || config.gamesPerPairing < 1)
    throw new Error("gamesPerPairing must be a positive integer");
  if (!agents.length) throw new Error("at least one agent is required");
  const ids = agents.map((agent) => agent.metadata.id);
  if (new Set(ids).size !== ids.length)
    throw new Error("duplicate agent IDs are ambiguous in a tournament");
  if (config.format === "head_to_head" && agents.length !== 2)
    throw new Error("head_to_head requires exactly two agents");
  if (config.format === "self_play" && !config.includeSelfPlay)
    throw new Error("self_play requires includeSelfPlay: true");
  return {
    ...config,
    includeSelfPlay: config.includeSelfPlay ?? false,
    configurationVersion:
      config.configurationVersion ?? TOURNAMENT_CONFIG_VERSION,
  };
}
function buildPairings(
  format: TournamentFormat,
  ids: readonly string[],
  includeSelfPlay: boolean,
): Array<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  if (format === "head_to_head") pairs.push([ids[0]!, ids[1]!]);
  else if (format === "self_play") for (const id of ids) pairs.push([id, id]);
  else
    for (let first = 0; first < ids.length; first += 1)
      for (let second = first + 1; second < ids.length; second += 1)
        pairs.push([ids[first]!, ids[second]!]);
  if (format === "round_robin" && includeSelfPlay)
    for (const id of ids) pairs.push([id, id]);
  return pairs;
}
function generateSeeds(masterSeed: number, count: number): number[] {
  let state = masterSeed >>> 0;
  return Array.from({ length: count }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  });
}
function stableId(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 24);
}

// Compatibility wrapper for the original two-seat CLI flow.
export function pairedSchedule(
  options: Omit<GameSpec, "id" | "seed" | "fellowship" | "sauron"> & {
    seeds: number[];
    first: Agent;
    second: Agent;
  },
): GameSpec[] {
  return options.seeds.flatMap((seed, index) => [
    {
      ...options,
      id: `game-${index + 1}-a`,
      seed,
      fellowship: options.first,
      sauron: options.second,
    },
    {
      ...options,
      id: `game-${index + 1}-b`,
      seed,
      fellowship: options.second,
      sauron: options.first,
    },
  ]);
}
