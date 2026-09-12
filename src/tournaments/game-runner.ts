import {
  Agent,
  AgentContext,
  InvalidAgentDecisionError,
  redactSecrets,
  validateAgentDecision,
} from "../agents/types.js";
import { createHash } from "node:crypto";
import { AgentTerminalError } from "../agents/execution.js";
import {
  Faction,
  Outcome,
  ServerResponse,
  StateResponse,
} from "../protocol.js";
import { RulesServerClient } from "../server/client.js";
import { EventLog } from "../run/events.js";

export interface ReplayAction {
  faction: Faction;
  actionId: string;
}
export interface GameSpec {
  id: string;
  seed: number;
  fellowship: Agent;
  sauron: Agent;
  serverCommand: string;
  serverCwd: string;
  maxActions: number;
  serverTimeoutMs: number;
  replay?: ReplayAction[];
  signal?: AbortSignal;
  attemptId?: string;
}
export interface GameResult {
  id: string;
  seed: number;
  fellowship: string;
  sauron: string;
  outcome: Outcome | "failed";
  winner: Faction | null;
  actions: number;
  engineVersion: string | null;
  error?: string;
  totalCost: number;
  durationMs: number;
}

export async function runGame(
  spec: GameSpec,
  events: EventLog,
): Promise<GameResult> {
  const started = Date.now();
  const server = new RulesServerClient(
    spec.serverCommand,
    spec.serverCwd,
    spec.serverTimeoutMs,
  );
  let actions = 0;
  let engineVersion: string | null = null;
  let totalCost = 0;
  const base = {
    runId:
      (spec as GameSpec & { tournamentId?: string }).tournamentId ?? spec.id,
    matchId: spec.id,
    gameId: spec.attemptId ?? spec.id,
    seed: spec.seed,
    protocolVersion: 1,
  };
  const signal = spec.signal ?? new AbortController().signal;
  try {
    const hello = await server.hello();
    engineVersion = hello.engineVersion;
    if (
      !hello.capabilities.includes("opaque_action_ids") ||
      !hello.capabilities.includes("state_revision")
    )
      throw new Error(
        "rules_server does not support required JSONL capabilities",
      );
    const created = await server.request({ type: "new", seed: spec.seed });
    if (!created.gameId) throw new Error("new response has no gameId");
    await events.append({
      type: "game_started",
      ...base,
      serverRevision: engineVersion,
      afterStateHash: undefined,
    });
    let current: Exclude<ServerResponse, { type: "hello" | "error" }> = created;
    for (const replay of spec.replay ?? []) {
      const state = await server.request({
        type: "state",
        gameId: created.gameId,
        faction: replay.faction,
      });
      if (
        !state.legalActions.some(
          (action) => action.actionId === replay.actionId,
        )
      )
        throw new Error(
          `cannot replay action ${replay.actionId}; server action IDs or rules changed`,
        );
      current = await server.request({
        type: "choose",
        gameId: created.gameId,
        stateRevision: state.stateRevision!,
        turn: state.turn!,
        stateHash: state.stateHash!,
        faction: replay.faction,
        actionId: replay.actionId,
      });
      actions += 1;
    }
    while (current.outcome === "in_progress" && actions < spec.maxActions) {
      const states: Array<[Faction, StateResponse]> = [];
      for (const faction of ["fellowship", "sauron"] as const)
        states.push([
          faction,
          await server.request({
            type: "state",
            gameId: created.gameId,
            faction,
          }),
        ]);
      const actionable = states.filter(
        ([, state]) => state.legalActions.length > 0,
      );
      if (actionable.length !== 1)
        throw new Error(
          `expected exactly one actionable faction, received ${actionable.length}`,
        );
      const [faction, state] = actionable[0]!;
      const agent = faction === "fellowship" ? spec.fellowship : spec.sauron;
      const promptHash = createHash("sha256")
        .update(
          JSON.stringify({
            observation: state.observation,
            legalActions: state.legalActions,
          }),
        )
        .digest("hex");
      await events.append({
        type: "decision_requested",
        ...base,
        agentId: agent.metadata.id,
        agentVersion: agent.metadata.version,
        seat: faction,
        turn: state.turn,
        beforeStateHash: state.stateHash,
        promptHash,
        modelParameters: {
          provider: agent.metadata.provider,
          model: agent.metadata.model ?? "",
        },
      });
      const context: AgentContext = {
        observation: state.observation,
        legalActions: state.legalActions,
        gameId: created.gameId,
        matchId: spec.id,
        seat: faction,
        turn: state.turn,
        signal,
      };
      const result = validateAgentDecision(
        context,
        await agent.choose(context),
        agent.metadata,
      );
      totalCost += result.estimatedCost ?? 0;
      for (const attempt of result.attemptLog ?? [])
        await events.append({
          type:
            attempt.status === "success"
              ? "agent_attempt_completed"
              : "agent_attempt_failed",
          ...base,
          agentId: result.agent.id,
          agentVersion: result.agent.version,
          seat: faction,
          turn: state.turn,
          latencyMs: attempt.latencyMs,
          usage: attempt.usage,
          estimatedCost: attempt.cost?.amount,
          errorClass: attempt.status,
          error: attempt.error,
        });
      await events.append({
        type: "decision_accepted",
        ...base,
        agentId: result.agent.id,
        agentVersion: result.agent.version,
        seat: faction,
        turn: state.turn,
        beforeStateHash: state.stateHash,
        actionId: result.actionId,
        latencyMs: result.latencyMs,
        usage: result.usage,
        estimatedCost: result.estimatedCost,
        pricing: result.cost
          ? { version: result.cost.pricingVersion, source: result.cost.source }
          : undefined,
        rawOutput: result.rawOutput,
      });
      current = await server.request({
        type: "choose",
        gameId: created.gameId,
        stateRevision: state.stateRevision,
        turn: state.turn,
        stateHash: state.stateHash,
        faction,
        actionId: result.actionId,
      });
      actions += 1;
      await events.append({
        type: "state_transition",
        ...base,
        seat: faction,
        turn: current.turn,
        beforeStateHash: state.stateHash,
        afterStateHash: current.stateHash,
        actionId: result.actionId,
      });
      await events.append({
        type: "checkpoint_committed",
        ...base,
        seat: faction,
        turn: current.turn,
        afterStateHash: current.stateHash,
        checkpoint: `action-${actions}`,
      });
    }
    const outcome: Outcome | "failed" =
      current.outcome === "in_progress" ? "failed" : current.outcome!;
    const error =
      outcome === "failed"
        ? `exceeded maxActions ${spec.maxActions}`
        : undefined;
    const finished: GameResult = {
      id: spec.id,
      seed: spec.seed,
      fellowship: spec.fellowship.metadata.id,
      sauron: spec.sauron.metadata.id,
      outcome,
      winner: current.winner,
      actions,
      engineVersion,
      error,
      totalCost,
      durationMs: Date.now() - started,
    };
    await events.append({
      type: "game_completed",
      ...base,
      outcome: finished.outcome,
      winner: finished.winner,
      actions: finished.actions,
      estimatedCost: finished.totalCost,
    });
    return finished;
  } catch (error) {
    if (error instanceof AgentTerminalError)
      for (const attempt of error.attempts)
        await events.append({
          type: "agent_attempt_failed",
          ...base,
          latencyMs: attempt.latencyMs,
          usage: attempt.usage,
          estimatedCost: attempt.cost?.amount,
          errorClass: attempt.status,
          error: attempt.error,
        });
    if (error instanceof InvalidAgentDecisionError)
      await events.append({
        type: "decision_rejected",
        ...base,
        errorClass: error.name,
        error: error.message,
      });
    const result: GameResult = {
      id: spec.id,
      seed: spec.seed,
      fellowship: spec.fellowship.metadata.id,
      sauron: spec.sauron.metadata.id,
      outcome: "failed",
      winner: null,
      actions,
      engineVersion,
      error: redactSecrets(
        error instanceof Error ? error.message : String(error),
      ),
      totalCost,
      durationMs: Date.now() - started,
    };
    await events.append({
      type:
        error instanceof AgentTerminalError && error.policy === "forfeit"
          ? "game_forfeited"
          : "game_failed",
      ...base,
      outcome: result.outcome,
      winner: result.winner,
      actions: result.actions,
      estimatedCost: result.totalCost,
      errorClass: error instanceof Error ? error.name : "Error",
      error: result.error,
    });
    return result;
  } finally {
    await server.close();
  }
}
