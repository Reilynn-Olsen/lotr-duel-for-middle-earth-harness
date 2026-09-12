# Rules Server API

This harness communicates with the Lord of the Rings Duel rules engine through
its JSON Lines protocol. Start a local server with:

```sh
cargo run --bin rules_server -- --jsonl
```

Send one JSON request per line and read one JSON response per line. Requests and
responses use protocol version `1`. A harness game starts with `new`, retrieves
the viewer-scoped `state`, and applies an opaque legal `actionId` with `choose`.

Action IDs are valid only for the `gameId`, `stateRevision`, `turn`, and
`stateHash` from the state that issued them. Clients must not construct or infer
actions from the observation.

The rules-engine repository owns the complete protocol specification. Keep this
document aligned with the engine when upgrading the integration.
