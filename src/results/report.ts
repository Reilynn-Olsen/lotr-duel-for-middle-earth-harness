import { GameResult } from "../tournaments/game-runner.js";

export function summarize(results: GameResult[]): Record<string, unknown> {
  const completed = results.filter((result) => result.outcome !== "failed");
  const agents = [
    ...new Set(results.flatMap((result) => [result.fellowship, result.sauron])),
  ];
  const standings = Object.fromEntries(
    agents.map((agent) => {
      const games = completed.filter(
        (result) => result.fellowship === agent || result.sauron === agent,
      );
      const wins = games.filter(
        (result) =>
          (result.fellowship === agent && result.winner === "fellowship") ||
          (result.sauron === agent && result.winner === "sauron"),
      ).length;
      if (games.length === 0)
        return [agent, { games: 0, wins: 0, winRate: 0, wilson95: [0, 0] }];
      const rate = games.length ? wins / games.length : 0;
      const z = 1.96;
      const denominator = 1 + z ** 2 / games.length;
      const center = (rate + z ** 2 / (2 * games.length)) / denominator;
      const margin =
        (z *
          Math.sqrt(
            (rate * (1 - rate)) / games.length +
              z ** 2 / (4 * games.length ** 2),
          )) /
        denominator;
      return [
        agent,
        {
          games: games.length,
          wins,
          winRate: rate,
          wilson95: games.length
            ? [Math.max(0, center - margin), Math.min(1, center + margin)]
            : [0, 0],
        },
      ];
    }),
  );
  const paired = results.reduce<
    Record<
      string,
      { firstWins: number; secondWins: number; draws: number; failed: number }
    >
  >((all, result) => {
    const key = [result.fellowship, result.sauron].sort().join(" vs ");
    const value = all[key] ?? {
      firstWins: 0,
      secondWins: 0,
      draws: 0,
      failed: 0,
    };
    if (result.outcome === "failed") value.failed += 1;
    else if (!result.winner) value.draws += 1;
    else if (result.winner === "fellowship") value.firstWins += 1;
    else value.secondWins += 1;
    all[key] = value;
    return all;
  }, {});
  return {
    games: results.length,
    completed: completed.length,
    failed: results.length - completed.length,
    outcomes: Object.fromEntries(
      ["winner", "shared_victory", "stalled", "failed"].map((outcome) => [
        outcome,
        results.filter((result) => result.outcome === outcome).length,
      ]),
    ),
    standings,
    paired,
    meanActions: completed.length
      ? completed.reduce((sum, result) => sum + result.actions, 0) /
        completed.length
      : 0,
    totalCost: results.reduce((sum, result) => sum + result.totalCost, 0),
  };
}
