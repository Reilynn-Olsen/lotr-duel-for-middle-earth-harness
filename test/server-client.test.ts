import assert from "node:assert/strict";
import test from "node:test";
import {
  ProtocolError,
  RulesServerClient,
  ServerAbortError,
  ServerExitError,
  ServerRejectedRequestError,
  ServerTimeoutError,
} from "../src/server/client.js";

function client(mode: string, timeoutMs = 200): RulesServerClient {
  return new RulesServerClient(
    `node test/fixtures/fake-server.mjs ${mode}`,
    process.cwd(),
    timeoutMs,
  );
}

test("exchanges multiple sequential JSONL requests", async () => {
  const server = client("valid");
  try {
    assert.equal((await server.hello()).type, "hello");
    const game = await server.request({ type: "new", seed: 1 });
    assert.equal(game.gameId, "game-1");
    assert.equal(
      (
        await server.request({
          type: "state",
          gameId: game.gameId!,
          faction: "sauron",
        })
      ).legalActions[0]?.actionId,
      "action-1",
    );
  } finally {
    await server.close();
  }
});
test("rejects malformed JSON and schema-invalid messages", async () => {
  for (const mode of ["malformed", "invalid"]) {
    const server = client(mode);
    try {
      await assert.rejects(server.hello(), ProtocolError);
    } finally {
      await server.close();
    }
  }
});
test("rejects incompatible protocol versions", async () => {
  const server = client("incompatible");
  try {
    await assert.rejects(server.hello(), ProtocolError);
  } finally {
    await server.close();
  }
});
test("rejects unknown and duplicate request IDs", async () => {
  const unknown = client("unknown");
  try {
    await assert.rejects(unknown.hello(), ProtocolError);
  } finally {
    await unknown.close();
  }
  const duplicate = client("duplicate");
  try {
    await duplicate.hello();
    await assert.rejects(duplicate.hello(), ProtocolError);
  } finally {
    await duplicate.close();
  }
});
test("surfaces stale action turn and state hash rejections", async () => {
  const server = client("stale");
  try {
    const game = await server.request({ type: "new", seed: 1 });
    await assert.rejects(
      server.request({
        type: "choose",
        gameId: game.gameId,
        stateRevision: game.stateRevision,
        turn: game.turn,
        stateHash: "b".repeat(64),
        faction: "sauron",
        actionId: "action-1",
      }),
      ServerRejectedRequestError,
    );
  } finally {
    await server.close();
  }
});
test("rejects pending requests on server exit", async () => {
  const server = client("exit");
  try {
    await assert.rejects(server.hello(), ServerExitError);
  } finally {
    await server.close();
  }
});
test("rejects a server termination during an action request", async () => {
  const server = client("exit-choose");
  try {
    const game = await server.request({ type: "new", seed: 1 });
    await assert.rejects(
      server.request({
        type: "choose",
        gameId: game.gameId,
        stateRevision: game.stateRevision,
        turn: game.turn,
        stateHash: "a".repeat(64),
        faction: "sauron",
        actionId: "action-1",
      }),
      ServerExitError,
    );
  } finally {
    await server.close();
  }
});
test("supports request timeout and cancellation", async () => {
  const server = client("silent", 30);
  try {
    await assert.rejects(server.hello(), ServerTimeoutError);
    const controller = new AbortController();
    const request = server.request({ type: "hello" }, controller.signal);
    controller.abort();
    await assert.rejects(request, ServerAbortError);
  } finally {
    await server.close();
  }
});
