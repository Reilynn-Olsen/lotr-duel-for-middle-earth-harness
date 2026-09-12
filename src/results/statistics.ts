import { RunEvent } from "../run/events.js";

export const EVALUATION_SCHEMA_VERSION = 1;
export interface Proportion {
  numerator: number;
  denominator: number;
  rate: number | null;
  wilson95: readonly [number, number] | null;
}
export interface EvaluationSummary {
  evaluationSchemaVersion: number;
  methodology: { completedGames: string; pairedComparison: string };
  counts: Record<string, number>;
  winRate: Proportion;
  drawRate: Proportion;
  scoreDifferential: {
    available: boolean;
    count: number;
    mean: number | null;
    confidence95: readonly [number, number] | null;
  };
  bySeat: Record<string, Record<string, number>>;
  byVictoryType: Record<string, number>;
  bySetupFactor: Record<string, Record<string, number>>;
  latencyMs: Record<string, number | null>;
  tokens: {
    input: number;
    output: number;
    total: number;
    missingUsageEvents: number;
  };
  costs: {
    total: number;
    missingCostEvents: number;
    perGame: number | null;
    perDecision: number | null;
    perWin: number | null;
  };
  errorRates: Record<string, Proportion>;
  headToHead: Array<{
    fellowship: string;
    sauron: string;
    games: number;
    fellowshipWins: number;
    sauronWins: number;
    draws: number;
  }>;
  paired: {
    completePairs: number;
    incompletePairs: string[];
    pairs: Array<{ pairedSeedId: string; games: number; winners: string[] }>;
  };
}

export function evaluateEvents(events: readonly RunEvent[]): EvaluationSummary {
  const scheduled = new Map<string, RunEvent>();
  const terminal = new Map<string, RunEvent>();
  const latencies: number[] = [];
  let input = 0;
  let output = 0;
  let total = 0;
  let missingUsage = 0;
  let cost = 0;
  let missingCost = 0;
  let decisions = 0;
  const error = { invalid: 0, retry: 0, timeout: 0, provider: 0, attempts: 0 };
  for (const event of events) {
    if (event.type === "match_scheduled" && event.matchId)
      scheduled.set(event.matchId, event);
    if (
      (event.type === "game_completed" ||
        event.type === "game_forfeited" ||
        event.type === "game_failed") &&
      event.matchId
    )
      terminal.set(event.matchId, event);
    if (event.type === "decision_accepted") {
      decisions += 1;
      if (event.latencyMs !== undefined) latencies.push(event.latencyMs);
      if (event.usage) {
        input += event.usage.promptTokens ?? 0;
        output += event.usage.completionTokens ?? 0;
        total +=
          event.usage.totalTokens ??
          (event.usage.promptTokens ?? 0) + (event.usage.completionTokens ?? 0);
      } else missingUsage += 1;
      if (event.estimatedCost !== undefined) cost += event.estimatedCost;
      else missingCost += 1;
    }
    if (
      event.type === "agent_attempt_completed" ||
      event.type === "agent_attempt_failed"
    ) {
      error.attempts += 1;
      const kind = event.errorClass ?? "";
      if (kind.includes("invalid")) error.invalid += 1;
      if (kind.includes("retry")) error.retry += 1;
      if (kind.includes("timeout")) error.timeout += 1;
      if (kind.includes("provider")) error.provider += 1;
    }
  }
  const completed = [...terminal.values()].filter(
    (event) => event.type === "game_completed",
  );
  const forfeits = [...terminal.values()].filter(
    (event) => event.type === "game_forfeited",
  );
  const failures = [...terminal.values()].filter(
    (event) => event.type === "game_failed",
  );
  const wins = completed.filter((event) => event.outcome === "winner");
  const draws = completed.filter((event) => event.outcome !== "winner");
  const eligible = completed.length;
  const bySeat = {
    fellowship: { wins: 0, losses: 0, draws: 0 },
    sauron: { wins: 0, losses: 0, draws: 0 },
  };
  for (const event of completed) {
    if (event.winner === "fellowship") {
      bySeat.fellowship.wins += 1;
      bySeat.sauron.losses += 1;
    } else if (event.winner === "sauron") {
      bySeat.sauron.wins += 1;
      bySeat.fellowship.losses += 1;
    } else {
      bySeat.fellowship.draws += 1;
      bySeat.sauron.draws += 1;
    }
  }
  const victory: Record<string, number> = {};
  const setup: Record<string, Record<string, number>> = {};
  const matrix = new Map<
    string,
    {
      fellowship: string;
      sauron: string;
      games: number;
      fellowshipWins: number;
      sauronWins: number;
      draws: number;
    }
  >();
  const pairs = new Map<string, { games: number; winners: string[] }>();
  for (const event of completed) {
    victory[event.outcome ?? "unknown"] =
      (victory[event.outcome ?? "unknown"] ?? 0) + 1;
    const match = event.matchId ? scheduled.get(event.matchId) : undefined;
    if (match) {
      for (const [key, value] of Object.entries(match.setupFactors ?? {})) {
        const values = setup[key] ?? {};
        values[value] = (values[value] ?? 0) + 1;
        setup[key] = values;
      }
      const key = `${match.fellowshipAgentId ?? "unknown"}|${match.sauronAgentId ?? "unknown"}`;
      const value = matrix.get(key) ?? {
        fellowship: match.fellowshipAgentId ?? "unknown",
        sauron: match.sauronAgentId ?? "unknown",
        games: 0,
        fellowshipWins: 0,
        sauronWins: 0,
        draws: 0,
      };
      value.games += 1;
      if (event.winner === "fellowship") value.fellowshipWins += 1;
      else if (event.winner === "sauron") value.sauronWins += 1;
      else value.draws += 1;
      matrix.set(key, value);
      const pair = pairs.get(match.pairedSeedId ?? match.matchId!) ?? {
        games: 0,
        winners: [],
      };
      pair.games += 1;
      if (event.winner)
        pair.winners.push(
          event.winner === "fellowship"
            ? (match.fellowshipAgentId ?? "unknown")
            : (match.sauronAgentId ?? "unknown"),
        );
      pairs.set(match.pairedSeedId ?? match.matchId!, pair);
    }
  }
  const completePairs = [...pairs.entries()].filter(
    ([, pair]) => pair.games === 2,
  );
  const incomplete = [...pairs.entries()]
    .filter(([, pair]) => pair.games !== 2)
    .map(([id]) => id)
    .sort();
  const completeCostData = missingCost === 0;
  return {
    evaluationSchemaVersion: EVALUATION_SCHEMA_VERSION,
    methodology: {
      completedGames:
        "Win/draw estimates exclude failed, forfeited, and cancelled games; those outcomes are reported separately.",
      pairedComparison:
        "Seat-swapped games are grouped by pairedSeedId; only groups with exactly two completed games are complete pairs.",
    },
    counts: {
      completed: completed.length,
      wins: wins.length,
      losses: wins.length,
      draws: draws.length,
      failures: failures.length,
      forfeits: forfeits.length,
      cancellations: events.filter((event) => event.type === "run_cancelled")
        .length,
    },
    winRate: proportion(wins.length, eligible),
    drawRate: proportion(draws.length, eligible),
    scoreDifferential: {
      available: false,
      count: 0,
      mean: null,
      confidence95: null,
    },
    bySeat,
    byVictoryType: ordered(victory),
    bySetupFactor: Object.fromEntries(
      Object.entries(setup)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, ordered(value)]),
    ),
    latencyMs: distribution(latencies),
    tokens: { input, output, total, missingUsageEvents: missingUsage },
    costs: {
      total: cost,
      missingCostEvents: missingCost,
      perGame:
        completeCostData && completed.length ? cost / completed.length : null,
      perDecision: completeCostData && decisions ? cost / decisions : null,
      perWin: completeCostData && wins.length ? cost / wins.length : null,
    },
    errorRates: {
      invalidDecision: proportion(error.invalid, error.attempts),
      retry: proportion(error.retry, error.attempts),
      timeout: proportion(error.timeout, error.attempts),
      providerError: proportion(error.provider, error.attempts),
    },
    headToHead: [...matrix.values()].sort((a, b) =>
      `${a.fellowship}|${a.sauron}`.localeCompare(
        `${b.fellowship}|${b.sauron}`,
      ),
    ),
    paired: {
      completePairs: completePairs.length,
      incompletePairs: incomplete,
      pairs: [...pairs.entries()]
        .map(([pairedSeedId, pair]) => ({ pairedSeedId, ...pair }))
        .sort((a, b) => a.pairedSeedId.localeCompare(b.pairedSeedId)),
    },
  };
}
export function evaluationCsv(
  summary: EvaluationSummary,
): Record<string, string> {
  return {
    overview: csv([
      ["metric", "value"],
      ...Object.entries(summary.counts).map(([key, value]) => [key, value]),
      ["win_rate", summary.winRate.rate ?? ""],
      ["draw_rate", summary.drawRate.rate ?? ""],
      ["cost_total", summary.costs.total],
    ]),
    head_to_head: csv([
      [
        "fellowship",
        "sauron",
        "games",
        "fellowship_wins",
        "sauron_wins",
        "draws",
      ],
      ...summary.headToHead.map((row) => [
        row.fellowship,
        row.sauron,
        row.games,
        row.fellowshipWins,
        row.sauronWins,
        row.draws,
      ]),
    ]),
  };
}
function proportion(numerator: number, denominator: number): Proportion {
  if (!denominator)
    return { numerator, denominator, rate: null, wilson95: null };
  const rate = numerator / denominator;
  const z = 1.96;
  const d = 1 + z ** 2 / denominator;
  const center = (rate + z ** 2 / (2 * denominator)) / d;
  const margin =
    (z *
      Math.sqrt(
        (rate * (1 - rate)) / denominator + z ** 2 / (4 * denominator ** 2),
      )) /
    d;
  return {
    numerator,
    denominator,
    rate,
    wilson95: [Math.max(0, center - margin), Math.min(1, center + margin)],
  };
}
function distribution(values: number[]): Record<string, number | null> {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (q: number) =>
    sorted.length ? sorted[Math.ceil(q * sorted.length) - 1]! : null;
  return {
    median: quantile(0.5),
    p90: quantile(0.9),
    p95: quantile(0.95),
    p99: quantile(0.99),
  };
}
function ordered(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).sort(([a], [b]) => a.localeCompare(b)),
  );
}
function csv(rows: Array<Array<string | number>>): string {
  return (
    rows
      .map((row) =>
        row
          .map((value) => `"${String(value).replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\n") + "\n"
  );
}
