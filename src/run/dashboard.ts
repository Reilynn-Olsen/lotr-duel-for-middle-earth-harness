import { readEventLog, RunEvent } from "./events.js";

export interface DashboardView {
  total: number;
  completed: number;
  active: Array<{
    matchId: string;
    seed?: number;
    seats: string;
    turn?: number;
    latest: string;
  }>;
  elapsedMs: number;
  etaMs: number | null;
  cost: number;
  budget: number | null;
  leaderboard: Array<{
    agent: string;
    wins: number;
    losses: number;
    draws: number;
  }>;
  errors: {
    retries: number;
    invalid: number;
    timeouts: number;
    failures: number;
  };
  concurrency: { active: number; total: number };
}
export function dashboardView(
  events: readonly RunEvent[],
  now = Date.now(),
): DashboardView {
  const scheduled = new Map<string, RunEvent>();
  const terminal = new Set<string>();
  const active = new Map<string, RunEvent>();
  const scores = new Map<
    string,
    { wins: number; losses: number; draws: number }
  >();
  let started = events[0] ? Date.parse(events[0].timestamp) : now;
  let cost = 0;
  const errors = { retries: 0, invalid: 0, timeouts: 0, failures: 0 };
  for (const event of events) {
    started = Math.min(started, Date.parse(event.timestamp));
    if (event.type === "match_scheduled" && event.matchId)
      scheduled.set(event.matchId, event);
    if (event.matchId && event.type === "game_started")
      active.set(event.matchId, event);
    if (
      event.matchId &&
      active.has(event.matchId) &&
      ["decision_requested", "decision_accepted", "state_transition"].includes(
        event.type,
      )
    )
      active.set(event.matchId, event);
    if (
      event.matchId &&
      ["game_completed", "game_failed", "game_forfeited"].includes(event.type)
    ) {
      terminal.add(event.matchId);
      active.delete(event.matchId);
      const match = scheduled.get(event.matchId);
      if (match) {
        const fellowship = score(scores, match.fellowshipAgentId ?? "unknown");
        const sauron = score(scores, match.sauronAgentId ?? "unknown");
        if (event.winner === "fellowship") {
          fellowship.wins += 1;
          sauron.losses += 1;
        } else if (event.winner === "sauron") {
          sauron.wins += 1;
          fellowship.losses += 1;
        } else if (event.type === "game_completed") {
          fellowship.draws += 1;
          sauron.draws += 1;
        }
      }
    }
    if (event.type === "decision_accepted") cost += event.estimatedCost ?? 0;
    if (event.type === "agent_attempt_failed") {
      const kind = event.errorClass?.toLowerCase() ?? "";
      if (kind.includes("retry")) errors.retries += 1;
      else if (kind.includes("invalid")) errors.invalid += 1;
      else if (kind.includes("timeout")) errors.timeouts += 1;
      else errors.failures += 1;
    }
  }
  const done = terminal.size;
  const elapsedMs = Math.max(0, now - started);
  const etaMs =
    done > 0 && scheduled.size > done
      ? (elapsedMs / done) * (scheduled.size - done)
      : null;
  return {
    total: scheduled.size,
    completed: done,
    active: [...active.entries()]
      .map(([matchId, event]) => {
        const match = scheduled.get(matchId);
        return {
          matchId,
          seed: match?.seed,
          seats: `${match?.fellowshipAgentId ?? "?"} vs ${match?.sauronAgentId ?? "?"}`,
          turn: event.turn,
          latest: event.type,
        };
      })
      .sort((a, b) => a.matchId.localeCompare(b.matchId)),
    elapsedMs,
    etaMs,
    cost,
    budget: null,
    leaderboard: [...scores.entries()]
      .map(([agent, value]) => ({ agent, ...value }))
      .sort((a, b) => b.wins - a.wins || a.agent.localeCompare(b.agent)),
    errors,
    concurrency: { active: active.size, total: scheduled.size },
  };
}
function score(
  scores: Map<string, { wins: number; losses: number; draws: number }>,
  agent: string,
): { wins: number; losses: number; draws: number } {
  const value = scores.get(agent) ?? { wins: 0, losses: 0, draws: 0 };
  scores.set(agent, value);
  return value;
}
export function shouldUseDashboard(
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
  environment = process.env,
): boolean {
  return Boolean(stdout.isTTY && stderr.isTTY && environment.CI !== "true");
}
export function renderDashboard(
  view: DashboardView,
  width = process.stderr.columns ?? 100,
): string {
  const short = (value: string) =>
    value.length > Math.max(12, width - 24)
      ? `${value.slice(0, Math.max(9, width - 27))}...`
      : value;
  const duration = (ms: number | null) =>
    ms === null
      ? "--"
      : `${Math.floor(ms / 60000)}m${Math.floor(ms / 1000) % 60}s`;
  const lines = [
    `Tournament live  ${view.completed}/${view.total} complete  active ${view.concurrency.active}  elapsed ${duration(view.elapsedMs)}  ETA ${duration(view.etaMs)}`,
    `Cost $${view.cost.toFixed(4)}${view.budget === null ? " (no budget)" : ` / $${view.budget.toFixed(4)}`}`,
    `Retries ${view.errors.retries}  Invalid ${view.errors.invalid}  Timeouts ${view.errors.timeouts}  Failures ${view.errors.failures}`,
    `Leaderboard  ${view.leaderboard.map((row) => `${short(row.agent)} ${row.wins}-${row.losses}-${row.draws}`).join(" | ") || "waiting for completed games"}`,
    `Active  ${view.active.map((row) => `${short(row.matchId)} seed ${row.seed ?? "?"} ${short(row.seats)} turn ${row.turn ?? "?"} ${row.latest}`).join("; ") || "none"}`,
  ];
  return lines.join("\n");
}
export class TerminalDashboard {
  private timer: NodeJS.Timeout | undefined;
  private active = false;
  constructor(
    private readonly eventsPath: string,
    private readonly output: NodeJS.WriteStream = process.stderr,
    private readonly intervalMs = 250,
  ) {}
  start(): void {
    if (this.active) return;
    this.active = true;
    this.output.write("\x1b[?25l");
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.intervalMs);
    void this.refresh();
  }
  async refresh(): Promise<void> {
    if (!this.active) return;
    const view = dashboardView(await readEventLog(this.eventsPath));
    this.output.write(
      "\x1b[H\x1b[2J" + renderDashboard(view, this.output.columns ?? 100),
    );
  }
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.output.write("\x1b[?25h\n");
  }
}
export class LineProgressLogger {
  private last = -1;
  constructor(
    private readonly eventsPath: string,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {}
  async refresh(): Promise<void> {
    const view = dashboardView(await readEventLog(this.eventsPath));
    if (view.completed !== this.last) {
      this.last = view.completed;
      this.output.write(
        `[tournament] ${view.completed}/${view.total} complete, active=${view.concurrency.active}, cost=$${view.cost.toFixed(4)}\n`,
      );
    }
  }
}
