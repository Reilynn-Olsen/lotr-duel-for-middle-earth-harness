import { z } from "zod";
import {
  Agent,
  AgentContext,
  AgentDecision,
  AgentMetadata,
  AgentUsage,
  AgentFailureError,
  redactSecrets,
} from "./types.js";
import {
  ExecutionDependencies,
  ExecutionOptions,
  LlmExecutionAgent,
  ProviderClient,
  ProviderResult,
  RetryableProviderError,
} from "./execution.js";

const CompletionSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z
              .object({ content: z.string().nullable().optional() })
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
        total_cost: z.number().nonnegative().optional(),
      })
      .optional(),
  })
  .passthrough();
export interface OpenRouterAgentOptions {
  model: string;
  apiKey: string;
  endpoint: string;
  execution: ExecutionOptions;
  maxTokens?: number;
  reasoningEffort?: "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
  metadata?: Partial<Pick<AgentMetadata, "id" | "version">>;
  fetch?: typeof fetch;
  dependencies?: ExecutionDependencies;
}

class OpenRouterClient implements ProviderClient {
  constructor(
    private readonly options: OpenRouterAgentOptions,
    private readonly fetcher: typeof fetch,
  ) {}
  async invoke(
    context: AgentContext,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    const response = await this.fetcher(this.options.endpoint, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0.2,
        ...(this.options.maxTokens === undefined
          ? {}
          : { max_tokens: this.options.maxTokens }),
        ...(this.options.reasoningEffort === undefined
          ? {}
          : { reasoning_effort: this.options.reasoningEffort }),
        messages: [
          {
            role: "system",
            content:
              'Choose exactly one offered action ID. Reply only as JSON: {"actionId":"..."}.',
          },
          {
            role: "user",
            content: JSON.stringify({
              observation: context.observation,
              legalActions: context.legalActions,
              gameId: context.gameId,
              matchId: context.matchId,
              seat: context.seat,
              turn: context.turn,
            }),
          },
        ],
      }),
    });
    if (!response.ok) {
      const message = `OpenRouter ${response.status}: ${redactSecrets(await response.text(), [this.options.apiKey])}`;
      if (response.status === 429 || response.status >= 500)
        throw new RetryableProviderError(
          message,
          retryAfterMs(response.headers.get("retry-after")),
        );
      throw new AgentFailureError(message);
    }
    const payload = CompletionSchema.parse(await response.json());
    const usage: AgentUsage | undefined = payload.usage
      ? {
          promptTokens: payload.usage.prompt_tokens,
          completionTokens: payload.usage.completion_tokens,
          totalTokens: payload.usage.total_tokens,
        }
      : undefined;
    return {
      output: payload.choices?.[0]?.message?.content?.trim() ?? "",
      usage,
      providerCost: payload.usage?.total_cost,
    };
  }
}

export class OpenRouterAgent implements Agent {
  readonly metadata: AgentMetadata;
  private readonly execution: LlmExecutionAgent;
  constructor(options: OpenRouterAgentOptions) {
    this.metadata = {
      id: options.metadata?.id ?? `openrouter:${options.model}`,
      version: options.metadata?.version ?? "1",
      provider: "openrouter",
      model: options.model,
    };
    this.execution = new LlmExecutionAgent(
      this.metadata,
      options.model,
      new OpenRouterClient(options, options.fetch ?? fetch),
      options.execution,
      options.dependencies,
    );
  }
  choose(context: AgentContext): Promise<AgentDecision> {
    return this.execution.choose(context);
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
