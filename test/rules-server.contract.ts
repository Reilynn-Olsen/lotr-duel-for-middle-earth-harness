import assert from "node:assert/strict";
import test from "node:test";
import { StateResponse } from "../src/protocol.js";
import { RulesServerClient } from "../src/server/client.js";

const command = process.env.RULES_SERVER_COMMAND;
const cwd = process.env.RULES_SERVER_CWD;

test(
  "rules_server JSONL protocol contract",
  { skip: !command || !cwd },
  async () => {
    const server = new RulesServerClient(command!, cwd!, 10_000);
    try {
      const hello = await server.hello();
      assert.equal(hello.protocolVersion, 1);
      assert.ok(hello.capabilities.includes("opaque_action_ids"));
      const created = await server.request({ type: "new", seed: 42 });
      assert.ok(created.gameId);
      assert.equal(created.stateRevision, 0);
      assert.equal(created.turn, 0);
      const states: Array<readonly ["fellowship" | "sauron", StateResponse]> =
        [];
      for (const faction of ["fellowship", "sauron"] as const)
        states.push([
          faction,
          await server.request({
            type: "state",
            gameId: created.gameId,
            faction,
          }),
        ]);
      const [faction, state] = states.find(
        ([, state]) => state.legalActions.length > 0,
      )!;
      assert.ok(state.legalActions[0]?.actionId);
      assert.match(state.stateHash!, /^[a-f0-9]{64}$/);
      const chosen = await server.request({
        type: "choose",
        gameId: created.gameId!,
        stateRevision: state.stateRevision!,
        turn: state.turn!,
        stateHash: state.stateHash!,
        faction,
        actionId: state.legalActions[0]!.actionId,
      });
      assert.equal(chosen.stateRevision, 1);
      await assert.rejects(
        server.request({
          type: "choose",
          gameId: created.gameId!,
          stateRevision: 0,
          turn: state.turn!,
          stateHash: state.stateHash!,
          faction,
          actionId: state.legalActions[0]!.actionId,
        }),
        /stateRevision/,
      );
    } finally {
      await server.close();
    }
  },
);
