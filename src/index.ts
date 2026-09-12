import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import "dotenv/config";
import { OpenRouterAgent } from "./agents/openrouter.js";
import { BudgetLedger } from "./agents/execution.js";
import { FirstLegalAgent, RandomAgent } from "./agents/test-agents.js";
import {
  EventLog,
  projectEvents,
  readEventLog,
  writeAtomic,
  writeAtomicText,
} from "./run/events.js";
import {
  LineProgressLogger,
  shouldUseDashboard,
  TerminalDashboard,
} from "./run/dashboard.js";
import { summarize } from "./results/report.js";
import { evaluateEvents, evaluationCsv } from "./results/statistics.js";
import { benchmarkReport } from "./results/benchmark-report.js";
import {
  GameResult,
  ReplayAction,
  runGame,
} from "./tournaments/game-runner.js";
import { executeTournament, planTournament } from "./tournaments/scheduler.js";
import {
  RunLock,
  commitCheckpoint,
  recoverRun,
} from "./tournaments/checkpoint.js";

interface Options {
  firstModel: string;
  secondModel: string;
  masterSeed: number;
  gamesPerPairing: number;
  maxActions: number;
  concurrency: number;
  matchTimeoutMs: number;
  serverCommand: string;
  serverCwd: string;
  serverTimeoutMs: number;
  agentTimeoutMs: number;
  retries: number;
  output: string;
  resume: boolean;
  allowNonSemanticMetadataOverride: boolean;
  dashboard: boolean;
  seatSwapped: boolean;
}
function usage(exitCode = 1): never {
  console.error(`Usage:
  npm run harness -- tournament --config benchmark.yaml
  npm run harness -- tournament --model random [--opponent-model random] [--master-seed 42] [--games-per-pairing 1] [--no-seat-swaps] [--output runs/demo]
  npm run harness -- tournament --resume runs/demo
  npm run harness -- replay runs/demo
  npm run harness -- report runs/demo

Options: --server-command, --server-cwd, --concurrency, --match-timeout-ms,
--max-actions, --no-dashboard, --allow-nonsemantic-metadata-override`);
  process.exit(exitCode);
}
function options(args: string[]): Options {
  const values = new Map<string, string>();
  let resume = false;
  let allowNonSemanticMetadataOverride = false;
  let dashboard = true;
  let seatSwapped = true;
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i]!;
    if (key === "--help" || key === "-h") usage(0);
    if (key === "--no-seat-swaps") {
      seatSwapped = false;
      continue;
    }
    if (key === "--no-dashboard") {
      dashboard = false;
      continue;
    }
    if (key === "--allow-nonsemantic-metadata-override") {
      allowNonSemanticMetadataOverride = true;
      continue;
    }
    if (key === "--resume") {
      resume = true;
      const directory = args[i + 1];
      if (directory && !directory.startsWith("--")) {
        values.set("--output", directory);
        i += 1;
      }
      continue;
    }
    const value = args[++i];
    if (!key.startsWith("--") || !value) usage();
    values.set(key, value);
  }
  const model = values.get("--model");
  if (!model) usage();
  const legacySeeds = (values.get("--seeds") ?? values.get("--seed") ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number);
  const number = (name: string, fallback: number) =>
    Number(values.get(name) ?? fallback);
  const parsed = {
    firstModel: model,
    secondModel: values.get("--opponent-model") ?? model,
    masterSeed: number("--master-seed", legacySeeds[0] ?? 0),
    gamesPerPairing: number("--games-per-pairing", legacySeeds.length || 1),
    maxActions: number("--max-actions", 500),
    concurrency: number("--concurrency", 1),
    matchTimeoutMs: number("--match-timeout-ms", 0),
    serverCommand:
      values.get("--server-command") ??
      "cargo run --bin rules_server -- --jsonl",
    serverCwd: resolve(values.get("--server-cwd") ?? process.cwd()),
    serverTimeoutMs: number("--server-timeout-ms", 15_000),
    agentTimeoutMs: number("--agent-timeout-ms", 60_000),
    retries: number("--retries", 2),
    output: resolve(values.get("--output") ?? "runs/latest"),
    resume,
    allowNonSemanticMetadataOverride,
    dashboard,
    seatSwapped,
  };
  if (
    !Number.isSafeInteger(parsed.masterSeed) ||
    !Number.isInteger(parsed.gamesPerPairing) ||
    !Number.isInteger(parsed.maxActions) ||
    !Number.isInteger(parsed.concurrency) ||
    !Number.isInteger(parsed.matchTimeoutMs) ||
    !Number.isInteger(parsed.serverTimeoutMs) ||
    !Number.isInteger(parsed.agentTimeoutMs) ||
    !Number.isInteger(parsed.retries) ||
    parsed.gamesPerPairing < 1 ||
    Object.values(parsed).some(
      (value) =>
        typeof value === "number" && (!Number.isFinite(value) || value < 0),
    )
  )
    usage();
  return parsed;
}
async function replayActions(
  path: string,
): Promise<Map<string, ReplayAction[]>> {
  try {
    const events = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            matchId?: string;
            gameId: string;
            seat?: ReplayAction["faction"];
            actionId?: string;
          },
      );
    const actions = new Map<string, ReplayAction[]>();
    for (const event of events)
      if (
        event.type === "state_transition" &&
        event.matchId &&
        event.seat &&
        event.actionId
      )
        actions.set(event.matchId, [
          ...(actions.get(event.matchId) ?? []),
          { faction: event.seat, actionId: event.actionId },
        ]);
    return actions;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}
async function storedGames(output: string): Promise<GameResult[]> {
  try {
    return await Promise.all(
      (await readdir(`${output}/games`))
        .filter((file) => file.endsWith(".json"))
        .map(
          async (file) =>
            JSON.parse(
              await readFile(`${output}/games/${file}`, "utf8"),
            ) as GameResult,
        ),
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
const configFlags: Record<string, string> = {
  model: "--model",
  firstModel: "--model",
  opponentModel: "--opponent-model",
  secondModel: "--opponent-model",
  masterSeed: "--master-seed",
  gamesPerPairing: "--games-per-pairing",
  maxActions: "--max-actions",
  concurrency: "--concurrency",
  matchTimeoutMs: "--match-timeout-ms",
  serverCommand: "--server-command",
  serverCwd: "--server-cwd",
  serverTimeoutMs: "--server-timeout-ms",
  agentTimeoutMs: "--agent-timeout-ms",
  retries: "--retries",
  output: "--output",
};
function flagsFor(values: Record<string, unknown>): string[] {
  return Object.entries(values).flatMap(([key, value]) =>
    configFlags[key] && value !== undefined
      ? [configFlags[key]!, String(value)]
      : [],
  );
}
async function withConfig(args: string[]): Promise<string[]> {
  const index = args.indexOf("--config");
  if (index < 0) return args;
  const path = args[index + 1];
  if (!path)
    throw new Error("--config requires a JSON or simple YAML file path");
  const source = await readFile(path, "utf8");
  let values: Record<string, unknown>;
  try {
    values = JSON.parse(source) as Record<string, unknown>;
  } catch {
    values = Object.fromEntries(
      source
        .split("\n")
        .map((line) => line.replace(/#.*/, "").trim())
        .filter(Boolean)
        .map((line) => {
          const match = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(line);
          if (!match)
            throw new Error(`unsupported YAML configuration line: ${line}`);
          return [match[1], match[2]!.replace(/^['"]|['"]$/g, "")];
        }),
    );
  }
  return [
    ...flagsFor(values),
    ...args.slice(0, index),
    ...args.slice(index + 2),
  ];
}
async function withResumeConfiguration(args: string[]): Promise<string[]> {
  const index = args.indexOf("--resume");
  const directory = index < 0 ? undefined : args[index + 1];
  if (!directory || directory.startsWith("--") || args.includes("--model"))
    return args;
  try {
    const saved = JSON.parse(
      await readFile(`${directory}/config.json`, "utf8"),
    ) as Record<string, unknown>;
    return [
      ...flagsFor(saved),
      ...(saved.seatSwapped === false ? ["--no-seat-swaps"] : []),
      ...args,
    ];
  } catch (error) {
    throw new Error(
      `cannot load saved run configuration from ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
async function generateReport(directory: string): Promise<void> {
  const output = resolve(directory);
  const [config, evaluation, events, games] = await Promise.all([
    readFile(`${output}/config.json`, "utf8").then(
      (value) => JSON.parse(value) as Record<string, unknown>,
    ),
    readFile(`${output}/evaluation.json`, "utf8").then((value) =>
      JSON.parse(value),
    ),
    readEventLog(`${output}/events.jsonl`),
    storedGames(output),
  ]);
  await writeAtomicText(
    `${output}/report.html`,
    benchmarkReport({
      title: String(
        (config.tournament as { id?: string } | undefined)?.id ??
          "Tournament benchmark",
      ),
      config,
      evaluation: evaluation as ReturnType<typeof evaluateEvents>,
      events,
      games,
    }),
  );
  console.log(`Report: ${output}/report.html`);
}
async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2);
  if (cliArgs[0] === "report") {
    const directory = cliArgs[1];
    if (!directory)
      throw new Error("Usage: npm run harness -- report <run-directory>");
    await generateReport(directory);
    return;
  }
  const tournamentArgs =
    cliArgs[0] === "replay"
      ? ["--resume", ...(cliArgs.slice(1) ?? [])]
      : cliArgs[0] === "tournament"
        ? cliArgs.slice(1)
        : cliArgs;
  const configArgs = await withConfig(
    await withResumeConfiguration(tournamentArgs),
  );
  const config = options(configArgs);
  const apiKey = process.env.OPENROUTER_API_KEY;
  const endpoint =
    process.env.OPENROUTER_ENDPOINT ??
    "https://openrouter.ai/api/v1/chat/completions";
  const maxTokens = process.env.OPENROUTER_MAX_TOKENS
    ? Number(process.env.OPENROUTER_MAX_TOKENS)
    : undefined;
  if (
    maxTokens !== undefined &&
    (!Number.isInteger(maxTokens) || maxTokens < 1)
  )
    throw new Error("OPENROUTER_MAX_TOKENS must be a positive integer");
  const reasoningEffortValue = process.env.OPENROUTER_REASONING_EFFORT;
  if (
    reasoningEffortValue !== undefined &&
    !["xhigh", "high", "medium", "low", "minimal", "none"].includes(
      reasoningEffortValue,
    )
  )
    throw new Error(
      "OPENROUTER_REASONING_EFFORT must be xhigh, high, medium, low, minimal, or none",
    );
  const reasoningEffort = reasoningEffortValue as
    | "xhigh"
    | "high"
    | "medium"
    | "low"
    | "minimal"
    | "none"
    | undefined;
  const ledger = new BudgetLedger();
  const budgets = {
    perDecisionUsd: process.env.AGENT_DECISION_BUDGET_USD
      ? Number(process.env.AGENT_DECISION_BUDGET_USD)
      : undefined,
    perGameUsd: process.env.AGENT_GAME_BUDGET_USD
      ? Number(process.env.AGENT_GAME_BUDGET_USD)
      : undefined,
    perRunUsd: process.env.AGENT_RUN_BUDGET_USD
      ? Number(process.env.AGENT_RUN_BUDGET_USD)
      : undefined,
  };
  const execution = {
    attemptTimeoutMs: config.agentTimeoutMs,
    maxAttempts: config.retries + 1,
    backoff: { baseMs: 250, maxMs: 5_000, jitter: 0.2 },
    limits: {
      providerConcurrency: Number(
        process.env.OPENROUTER_CONCURRENCY ?? config.concurrency,
      ),
      modelConcurrency: Number(
        process.env.OPENROUTER_MODEL_CONCURRENCY ?? config.concurrency,
      ),
      rate: {
        requestsPerMinute: process.env.OPENROUTER_RPM
          ? Number(process.env.OPENROUTER_RPM)
          : undefined,
        tokensPerMinute: process.env.OPENROUTER_TPM
          ? Number(process.env.OPENROUTER_TPM)
          : undefined,
      },
      maxInputTokens: process.env.AGENT_MAX_INPUT_TOKENS
        ? Number(process.env.AGENT_MAX_INPUT_TOKENS)
        : undefined,
    },
    pricing: {
      version: process.env.OPENROUTER_PRICING_VERSION ?? "provider-reported-v1",
    },
    budgets: Object.values(budgets).some((value) => value !== undefined)
      ? budgets
      : undefined,
    ledger,
    terminalPolicy: (process.env.AGENT_TERMINAL_POLICY ?? "forfeit") as
      | "forfeit"
      | "abort_match"
      | "fallback",
    debugRawOutput: process.env.AGENT_DEBUG_RAW_OUTPUT === "1",
    secrets: [apiKey ?? ""],
  } as const;
  const seededRng = (seed: number) => ({
    next: () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    },
  });
  const local = (model: string, id: string, seed: number) =>
    model === "first-legal"
      ? new FirstLegalAgent(id)
      : model === "random"
        ? new RandomAgent(seededRng(seed), id)
        : undefined;
  const first =
    local(config.firstModel, config.firstModel, config.masterSeed) ??
    new OpenRouterAgent({
      model: config.firstModel,
      apiKey: apiKey ?? "",
      endpoint,
      execution,
      maxTokens,
      reasoningEffort,
      metadata: { id: `openrouter:${config.firstModel}` },
    });
  const second =
    local(
      config.secondModel,
      `${config.secondModel}-opponent`,
      config.masterSeed + 1,
    ) ??
    new OpenRouterAgent({
      model: config.secondModel,
      apiKey: apiKey ?? "",
      endpoint,
      execution,
      maxTokens,
      reasoningEffort,
      metadata: { id: `openrouter:${config.secondModel}-opponent` },
    });
  if (
    (!apiKey && !local(config.firstModel, "", 0)) ||
    (!apiKey && !local(config.secondModel, "", 0))
  )
    throw new Error("OPENROUTER_API_KEY is required for OpenRouter agents");
  const plan = planTournament(
    {
      id: `head-to-head-${config.masterSeed}`,
      format: "head_to_head",
      masterSeed: config.masterSeed,
      gamesPerPairing: config.gamesPerPairing,
      seatSwapped: config.seatSwapped,
    },
    [first, second],
    {
      maxActions: config.maxActions,
      serverCommand: config.serverCommand,
      serverCwd: config.serverCwd,
      serverTimeoutMs: config.serverTimeoutMs,
    },
  );
  await mkdir(config.output, { recursive: true });
  const lock = config.resume ? await RunLock.acquire(config.output) : undefined;
  let dashboard: TerminalDashboard | undefined;
  let lineTimer: NodeJS.Timeout | undefined;
  try {
    await writeAtomic(`${config.output}/config.json`, {
      ...config,
      tournament: plan.config,
      gameSeeds: plan.gameSeeds,
      matches: plan.matches.map((match) => ({
        id: match.id,
        pairedSeedId: match.pairedSeedId,
        seed: match.seed,
        fellowship: match.fellowship.metadata,
        sauron: match.sauron.metadata,
      })),
    });
    const events = new EventLog(`${config.output}/events.jsonl`, {
      includeRawOutput: process.env.AGENT_DEBUG_RAW_OUTPUT === "1",
      secrets: [apiKey ?? ""],
    });
    if (!config.resume) {
      await events.append({
        type: "run_created",
        runId: plan.config.id,
        harnessRevision: process.env.HARNESS_REVISION ?? "development",
        protocolVersion: 1,
      });
      await events.append({
        type: "run_configuration_resolved",
        runId: plan.config.id,
        protocolVersion: 1,
        configuration: {
          ...config,
          tournament: plan.config,
          gameSeeds: plan.gameSeeds,
          pricing: execution.pricing,
          modelParameters: {
            endpoint,
            firstModel: config.firstModel,
            secondModel: config.secondModel,
          },
        },
      });
      for (const match of plan.matches)
        await events.append({
          type: "match_scheduled",
          runId: plan.config.id,
          matchId: match.id,
          gameId: match.id,
          seed: match.seed,
          pairedSeedId: match.pairedSeedId,
          fellowshipAgentId: match.fellowship.metadata.id,
          sauronAgentId: match.sauron.metadata.id,
          setupFactors: { seed: String(match.seed) },
          status: "scheduled",
        });
    }
    const recovered = config.resume
      ? await recoverRun(
          plan,
          events.path,
          `${config.output}/checkpoint.json`,
          {
            allowNonSemanticMetadataOverride:
              config.allowNonSemanticMetadataOverride,
          },
        )
      : undefined;
    if (recovered)
      for (const entry of recovered.matches.filter(
        (entry) => entry.status === "incomplete",
      ))
        await events.append({
          type: "game_interrupted",
          runId: plan.config.id,
          matchId: entry.match.id,
          gameId: entry.match.id,
          seed: entry.match.seed,
          status: "interrupted",
          errorClass: "Interrupted",
        });
    const replay = config.resume
      ? await replayActions(events.path)
      : new Map<string, ReplayAction[]>();
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    if (config.dashboard) {
      if (shouldUseDashboard(process.stdout, process.stderr)) {
        dashboard = new TerminalDashboard(events.path);
        dashboard.start();
      } else {
        const logger = new LineProgressLogger(events.path);
        await logger.refresh();
        lineTimer = setInterval(() => {
          void logger.refresh();
        }, 1_000);
      }
    }
    const runnable = recovered
      ? recovered.matches
          .filter(
            (entry) =>
              entry.status === "not_started" || entry.status === "incomplete",
          )
          .map((entry) => ({
            ...entry.match,
            attemptId: entry.attemptId,
            replay: replay.get(entry.match.id),
          }))
      : plan.matches.map((match) => ({
          ...match,
          replay: replay.get(match.id),
        }));
    const executions = await executeTournament(
      { ...plan, matches: runnable },
      {
        concurrency: config.concurrency,
        matchTimeoutMs: config.matchTimeoutMs || undefined,
        signal: controller.signal,
      },
      async (match, signal) => {
        const result = await runGame({ ...match, signal }, events);
        await commitCheckpoint(
          `${config.output}/checkpoint.json`,
          plan,
          await readEventLog(events.path),
        );
        return result;
      },
    );
    const newResults: GameResult[] = executions.map(
      (entry) =>
        entry.result ?? {
          id: entry.match.id,
          seed: entry.match.seed,
          fellowship: entry.match.fellowship.metadata.id,
          sauron: entry.match.sauron.metadata.id,
          outcome: "failed",
          winner: null,
          actions: 0,
          engineVersion: null,
          error: entry.error ?? entry.status,
          totalCost: 0,
          durationMs: 0,
        },
    );
    const results: GameResult[] = [
      ...(await storedGames(config.output)),
      ...newResults,
    ].filter(
      (result, index, values) =>
        values.findIndex((candidate) => candidate.id === result.id) === index,
    );
    for (const entry of executions)
      if (entry.result)
        await writeAtomic(
          `${config.output}/games/${entry.match.id}.json`,
          entry.result,
        );
    await writeAtomic(
      `${config.output}/tournament-results.json`,
      executions.map((entry) => ({
        id: entry.match.id,
        pairedSeedId: entry.match.pairedSeedId,
        status: entry.status,
        error: entry.error,
        result: entry.result,
      })),
    );
    for (const entry of executions)
      await events.append({
        type: "match_completed",
        runId: plan.config.id,
        matchId: entry.match.id,
        gameId: entry.match.id,
        seed: entry.match.seed,
        pairedSeedId: entry.match.pairedSeedId,
        status: entry.status,
        error: entry.error,
      });
    await events.append({
      type: controller.signal.aborted ? "run_cancelled" : "run_completed",
      runId: plan.config.id,
      status: controller.signal.aborted ? "cancelled" : "completed",
    });
    const summary = summarize(results);
    await writeAtomic(`${config.output}/summary.json`, summary);
    const auditEvents = await readEventLog(events.path);
    await writeAtomic(
      `${config.output}/event-projection.json`,
      projectEvents(auditEvents),
    );
    const evaluation = evaluateEvents(auditEvents);
    await writeAtomic(`${config.output}/evaluation.json`, evaluation);
    for (const [name, csv] of Object.entries(evaluationCsv(evaluation)))
      await writeAtomicText(`${config.output}/evaluation-${name}.csv`, csv);
    await writeAtomicText(
      `${config.output}/report.html`,
      benchmarkReport({
        title: plan.config.id,
        evaluation,
        config: { ...config, tournament: plan.config },
        games: results,
        events: auditEvents,
      }),
    );
    console.log(`Report: ${config.output}/report.html`);
  } finally {
    if (lineTimer) clearInterval(lineTimer);
    dashboard?.stop();
    await lock?.release();
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
