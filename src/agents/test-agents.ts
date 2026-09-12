import {
  Agent,
  AgentAbortError,
  AgentContext,
  AgentDecision,
  AgentFailureError,
  AgentMetadata,
  throwIfAborted,
  validateAgentDecision,
} from "./types.js";

export interface SeededRng {
  next(): number;
}
function decision(
  context: AgentContext,
  metadata: AgentMetadata,
  actionId: string,
  attempts = 1,
): AgentDecision {
  return validateAgentDecision(context, {
    actionId,
    agent: metadata,
    latencyMs: 0,
    attempts,
  });
}

export class FirstLegalAgent implements Agent {
  readonly metadata: AgentMetadata;
  constructor(id = "first-legal", version = "1") {
    this.metadata = { id, version, provider: "local", model: "first-legal" };
  }
  async choose(context: AgentContext): Promise<AgentDecision> {
    throwIfAborted(context.signal);
    const actionId = context.legalActions[0]?.actionId;
    if (!actionId) throw new AgentFailureError("no legal actions were offered");
    return decision(context, this.metadata, actionId);
  }
}

export class RandomAgent implements Agent {
  readonly metadata: AgentMetadata;
  constructor(
    private readonly rng: SeededRng,
    id = "random",
    version = "1",
  ) {
    this.metadata = { id, version, provider: "local", model: "random" };
  }
  async choose(context: AgentContext): Promise<AgentDecision> {
    throwIfAborted(context.signal);
    if (context.legalActions.length === 0)
      throw new AgentFailureError("no legal actions were offered");
    const index = Math.floor(this.rng.next() * context.legalActions.length);
    const actionId = context.legalActions[index]?.actionId;
    if (!actionId)
      throw new AgentFailureError("injected RNG returned an invalid value");
    return decision(context, this.metadata, actionId);
  }
}

export class ScriptedAgent implements Agent {
  readonly metadata: AgentMetadata;
  private index = 0;
  constructor(
    id: string,
    private readonly actions: readonly string[],
    version = "1",
  ) {
    this.metadata = { id, version, provider: "local", model: "scripted" };
  }
  async choose(context: AgentContext): Promise<AgentDecision> {
    throwIfAborted(context.signal);
    const actionId = this.actions[this.index++];
    if (!actionId) throw new AgentFailureError("script exhausted");
    return decision(context, this.metadata, actionId);
  }
}
