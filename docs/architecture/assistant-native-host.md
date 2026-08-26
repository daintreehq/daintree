# Assistant native-host boundary

Status: wired, protocol 3. This doc specifies the boundary between the `daintree-assistant` engine and Daintree's main/renderer surfaces (#10649). The protocol types live in [`shared/types/ipc/assistantHost.ts`](../../shared/types/ipc/assistantHost.ts) and their Zod validators in the assistant-native-host section of [`electron/schemas/ipc.ts`](../../electron/schemas/ipc.ts) — **those are the source of truth for the event set**, not the summary tables below. The engine's own side of the boundary is `daintreehq/assistant` `internal/host/`, documented there in [`DAINTREE_HOST.md`](https://github.com/daintreehq/assistant/blob/main/docs/DAINTREE_HOST.md); a change to the contract belongs in both repos. For the strategy this came out of, see [native-assistant-transition.md](./native-assistant-transition.md); for the process topology it plugs into, [process-and-window-model.md](./process-and-window-model.md); for the MCP event surfaces it reuses, [mcp-server.md](./mcp-server.md).

## Who owns what

The single most important thing in this document, because it is what every other decision here follows from. Four projects, four jobs, no overlap:

| Concern | Owner |
| --- | --- |
| Desktop sign-in, sign-out, refresh token, account status, backend selection | The assistant CLI — including the copy embedded in Daintree |
| Browser sign-in, OAuth consent, account page, checkout, billing portal, grant revocation | The website |
| Token verification, authorization, entitlement enforcement, paid-work attribution | The assistant backend |
| Starting the engine and rendering its events and command results | Daintree |
| Subscription truth | The website's server, exposed only through a bearer-only machine endpoint |

Daintree is a **host and a renderer**. It owns no credential, no OAuth state, no account truth, no plan truth, and no backend selection. Those moved into the session: `/login`, `/logout`, `/account` and `/backend` are engine commands, advertised in the engine's `host:ready` catalog and dispatched down the ordinary command path. There is no Daintree Settings sign-in for this flow and none is planned — a second credential surface would be a second authority on billing that the backend never agreed to, and the first thing it would get wrong is telling a paying customer they have not paid.

The staging topology is `assistant.daintree.org` (backend) in front of `staging.daintree.org` (website). Which one a session is talking to is the engine's decision, reported back on `host:ready` and shown in the panel masthead — Daintree never infers it from a hostname and never sets it.

## Runtime shape

The engine is a **`child_process.spawn` of a Go binary** speaking NDJSON over stdio — not a `utilityProcess.fork`, not an in-process embed, not a localhost sidecar.

An earlier version of this document specified `utilityProcess.fork()`, matching the three existing precedents (`pty-host`, `workspace-host`, the plugin dev worker). That was written when the runtime was an npm package with a JavaScript entry point. `utilityProcess.fork` runs a Node script and cannot execute a Go binary, and its structured-clone transport is not the NDJSON the engine speaks. Holding the fork decision while the engine moved is a large part of how Daintree sat at protocol v1 while the engine reached v3. The reasoning is restated at the top of [`AssistantHostProcess.ts`](../../electron/services/assistant-host/AssistantHostProcess.ts) so the next person to reach for `utilityProcess` finds it there.

The binary is vendored as the `vendor/daintree-assistant` submodule and built into `resources/assistant/` by `scripts/build-assistant.mjs`, stamped with the pinned SHA. `resolveAssistantBinary.ts` finds it, in order: `DAINTREE_ASSISTANT_BIN` (local engine development), the bundled copy under `process.resourcesPath`, then the repo's build output. There is deliberately **no `PATH` fallback** — a separately installed engine is free to be any version, which is the skew this whole scheme exists to prevent.

## Message protocol

Two discriminated unions, both versioned by `ASSISTANT_HOST_PROTOCOL_VERSION` (3). The engine announces the version it speaks in `host:ready`; Daintree **refuses a mismatch** rather than guessing at an unknown shape, with a message naming the fix. `electron/services/assistant-host/__tests__/engineConformance.test.ts` boots the real vendored binary and validates its actual bytes against the same Zod schema the main process uses in production, so a rename, a retype or a protocol bump fails in a unit run rather than at a user's first turn.

Engine → Daintree (`AssistantHostEvent`) covers readiness, turn lifecycle and streamed tokens, tool dispatch and settlement, approvals, questions, operations snapshots, MCP status, cost, command results, errors and shutdown. Daintree → engine (`AssistantHostCommand`) covers `prompt`, `command` (any slash line), `approval:decide`, `question:answer`, `operations`, `interrupt`, `interject:retract`, `hibernate` and `shutdown`. Read the schema for the current field-level shapes.

The fork-time `AssistantHostSessionDescriptor` is handed over once on the first stdin line, not as a command, so every command is a post-handshake control signal.

## Invariants

Load-bearing rules. Each encodes a lesson; breaking one reintroduces a known incident class.

1. **Every event and command carries `sessionId`, and delivery is pinned, never broadcast** (#7003). The main process resolves the session's minting `WebContents` and sends only there, failing closed if the view is gone. The schemas reject any message missing `sessionId`, so a message that cannot be pinned cannot exist.
2. **Secrets travel via env, not messages** — and the env is filtered in both directions. The descriptor carries no bearer and no MCP URL; those reach the engine through `DAINTREE_MCP_URL` / `DAINTREE_MCP_TOKEN` / `DAINTREE_WINDOW_ID`, and `AssistantHostSessionDescriptorSchema` is `.strict()` so a leaked port message cannot carry one. Going the other way, [`assistantChildEnv.ts`](../../electron/services/assistant-host/assistantChildEnv.ts) **strips the engine's whole trusted-env surface** from what is inherited — the endpoint, the switch that authorizes a plaintext endpoint, the bearer, the tier, the auto-approve flag, the state directory and the routing policy. The engine reads those through a door marked "the embedding host may set this, a bound repository may not"; a shell variable exported months ago is no more entitled to it than a bound repository is.
3. **One backend per project** (#7522). Provisioning displaces both PTY-backed and host-backed sessions for the same project inside the existing provision lock, re-checking ownership after every `await` in teardown.
4. **Outcome vocabularies stay audit-aligned.** `result` / `severity` / `decision` / `outcome` reuse the `mcpServer.ts` vocabularies (`McpAuditResult`, `McpAuditSeverity`, `McpConfirmationDecision`, `TurnOutcomeClass`) so the native timeline and the persisted audit log cannot drift.
5. **The host bootstrap installs its error guard before any dynamic import** (#8833). Electron 42 only warns on unhandled utility-process rejections, so a failed import otherwise hangs the readiness wait silently.
6. **Daintree never reads account or plan state out of prose, and never pre-empts the engine.** Sign-in, plan and refusal all arrive as typed events — a `command:result` for a command, a failed phase plus a `host:error` for a turn the engine would not run. The panel boots the engine without pre-reading account state and caches none of it. A dependency that could not answer renders as unverified and retryable, never as signed-out or unsubscribed.
7. **Every packaged app carries an engine built from exactly the pinned submodule commit.** `scripts/afterPack.cjs` matches the packaged binary's embedded version against the checked-out gitlink and fails the pack on a stale, dirty or unstamped one. It is enforced there because afterPack is the one hook every packaging path already runs — the `package:*` scripts, `package-local-dmg.mjs` and all three release workflows.

## Deliberately out of scope for Daintree

Payment, subscription storage, quota calculation, Supabase integration, OAuth URL construction, loopback callback handling, and any settings-based login. Each would duplicate an authority that lives in one of the other three projects and reopen the boundary this design closed. Daintree may perform the mechanical act of opening an engine-approved external URL; it does not decide which URL is safe.
