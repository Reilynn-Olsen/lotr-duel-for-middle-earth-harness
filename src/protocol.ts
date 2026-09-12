import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const FactionSchema = z.enum(["fellowship", "sauron"]);
export type Faction = z.infer<typeof FactionSchema>;
export const OutcomeSchema = z.enum([
  "in_progress",
  "winner",
  "shared_victory",
  "stalled",
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

const RequestBase = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.string().min(1),
  })
  .strict();
export const RequestSchema = z.discriminatedUnion("type", [
  RequestBase.extend({ type: z.literal("hello") }).strict(),
  RequestBase.extend({
    type: z.literal("new"),
    seed: z.number().int().nonnegative().optional(),
  }).strict(),
  RequestBase.extend({
    type: z.literal("state"),
    gameId: z.string().min(1),
    faction: FactionSchema,
  }).strict(),
  RequestBase.extend({
    type: z.literal("choose"),
    gameId: z.string().min(1),
    stateRevision: z.number().int().nonnegative(),
    turn: z.number().int().nonnegative(),
    stateHash: z.string().regex(/^[a-f0-9]{64}$/),
    faction: FactionSchema,
    actionId: z.string().min(1),
  }).strict(),
]);
export type ServerRequest = z.infer<typeof RequestSchema>;

const ResponseBase = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1),
  engineVersion: z.string().min(1),
});
const StateResponseFields = {
  gameId: z.string().min(1),
  stateRevision: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: OutcomeSchema,
  winner: FactionSchema.nullable(),
  observation: z.string(),
  legalActions: z.array(z.object({ actionId: z.string().min(1) }).strict()),
};

export const ServerResponseSchema = z.discriminatedUnion("type", [
  ResponseBase.extend({
    type: z.literal("hello"),
    gameId: z.null(),
    stateRevision: z.null(),
    turn: z.null(),
    stateHash: z.null(),
    outcome: z.null(),
    winner: z.null(),
    observation: z.null(),
    legalActions: z.array(z.never()),
    capabilities: z.array(z.string()),
    error: z.null(),
  }).strict(),
  // A new game has no viewer yet, so it cannot safely issue a viewer-scoped hash or observation.
  ResponseBase.extend({
    type: z.literal("new"),
    gameId: z.string().min(1),
    stateRevision: z.number().int().nonnegative(),
    turn: z.number().int().nonnegative(),
    stateHash: z.null(),
    outcome: OutcomeSchema,
    winner: FactionSchema.nullable(),
    observation: z.null(),
    legalActions: z.array(z.never()),
    capabilities: z.array(z.string()),
    error: z.null(),
  }).strict(),
  ResponseBase.extend({
    type: z.literal("state"),
    ...StateResponseFields,
    capabilities: z.array(z.string()),
    error: z.null(),
  }).strict(),
  ResponseBase.extend({
    type: z.literal("choose"),
    ...StateResponseFields,
    capabilities: z.array(z.string()),
    error: z.null(),
  }).strict(),
  ResponseBase.extend({
    type: z.literal("error"),
    gameId: z.string().min(1).nullable(),
    stateRevision: z.number().int().nonnegative().nullable(),
    turn: z.number().int().nonnegative().nullable(),
    stateHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    outcome: OutcomeSchema.nullable(),
    winner: FactionSchema.nullable(),
    observation: z.null(),
    legalActions: z.array(z.never()),
    capabilities: z.array(z.string()),
    error: z.string().min(1),
  }).strict(),
]);
export type ServerResponse = z.infer<typeof ServerResponseSchema>;
export type StateResponse = Extract<
  ServerResponse,
  { type: "state" | "choose" }
>;
export type ErrorResponse = Extract<ServerResponse, { type: "error" }>;
