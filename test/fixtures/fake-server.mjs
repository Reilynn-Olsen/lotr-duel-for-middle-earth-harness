import readline from "node:readline";

const mode = process.argv[2] ?? "valid";
let revision = 0;
const response = (request, overrides = {}) => ({
  protocolVersion: 1,
  requestId: request.requestId,
  type: request.type,
  gameId: request.type === "hello" ? null : "game-1",
  engineVersion: "test",
  stateRevision: request.type === "hello" ? null : revision,
  turn: request.type === "hello" ? null : revision,
  stateHash:
    request.type === "hello" || request.type === "new" ? null : "a".repeat(64),
  outcome: request.type === "hello" ? null : "in_progress",
  winner: null,
  observation:
    request.type === "hello" || request.type === "new" ? null : "public",
  legalActions:
    request.type === "state"
      ? [{ actionId: "action-1", description: "Take the test action." }]
      : [],
  capabilities:
    request.type === "hello" ? ["opaque_action_ids", "state_revision"] : [],
  error: null,
  ...overrides,
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (mode === "exit") process.exit(9);
  if (mode === "exit-choose" && request.type === "choose") process.exit(9);
  if (mode === "silent") return;
  if (mode === "malformed") return process.stdout.write("not json\n");
  if (mode === "invalid")
    return process.stdout.write(
      `${JSON.stringify({ requestId: request.requestId })}\n`,
    );
  if (mode === "incompatible")
    return process.stdout.write(
      `${JSON.stringify(response(request, { protocolVersion: 2 }))}\n`,
    );
  if (mode === "unknown")
    return process.stdout.write(
      `${JSON.stringify(response(request, { requestId: "unknown" }))}\n`,
    );
  if (mode === "stale" && request.type === "choose")
    return process.stdout.write(
      `${JSON.stringify(response(request, { type: "error", error: "stale turn or stateHash", observation: null, legalActions: [], stateRevision: request.stateRevision, turn: request.turn, stateHash: request.stateHash }))}\n`,
    );
  const value = response(request);
  process.stdout.write(`${JSON.stringify(value)}\n`);
  if (mode === "duplicate") process.stdout.write(`${JSON.stringify(value)}\n`);
  if (request.type === "choose") revision += 1;
});
