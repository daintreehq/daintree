# Assistant native-host boundary

Status: **contract defined and the process wrapper landed; nothing spawns it yet.** This doc specifies the boundary between the `daintree-assistant` runtime and Daintree's main/renderer surfaces (#10649). The protocol types live in [`shared/types/ipc/assistantHost.ts`](../../shared/types/ipc/assistantHost.ts); their Zod validators live in the assistant-native-host section of [`electron/schemas/ipc.ts`](../../electron/schemas/ipc.ts). Since the contract landed, two more pieces have: `AssistantHostProcess` (`electron/services/assistant-host/AssistantHostProcess.ts`) — the `utilityProcess.fork()` wrapper that hands over the descriptor on `parentPort`, validates every inbound message against the shared schema before forwarding, and resolves `waitForReady()` on `host:ready` — and `resolveAssistantHostEntry` (`resolveHostEntry.ts`), which locates the package's `dist/host.js` by working outward from the CLI bin path, since the package is installed independently of Daintree and can't be `require.resolve()`d from the app's module graph. Neither has a caller: no IPC channel is registered and no session constructs the host. For the broader process topology this plugs into, see [process-and-window-model.md](./process-and-window-model.md); for the MCP event surfaces it reuses, see [mcp-server.md](./mcp-server.md).

## Why this exists

Today the assistant runs as a CLI/Ink child process spawned through `terminal.spawn` and wrapped in an xterm pane (`HelpPanel`). Conversation content — user prompts, model text, tool arguments and results — is only ever terminal bytes; the single structured signals are the MCP-server events in `mcpServer.ts` (tool-call started/settled, turn-outcome alerts, the figure rail), already pushed to the pinned renderer. To render conversation, tool calls, and approvals as native React — and reuse Daintree's own confirmation, grant, audit, and notification surfaces rather than rebuilding them — the runtime needs a structured boundary instead of a terminal. This doc is that boundary.

The boundary is defined now and wired later. Two prerequisites named in #10649 are unbuilt: the workflow ledger, and the `@daintreehq/daintree-assistant` package emitting the structured turn events below. Landing the contract first lets the host plug in without a protocol redesign, and keeps the CLI/Ink path as the default and the fallback throughout.

## Runtime shape (decision)

When the runtime is wired, the host is an Electron `utilityProcess.fork()` child — not a managed CLI, not an in-process embed, not a localhost sidecar. Rationale:

- Three existing precedents (`pty-host`, `workspace-host`, the plugin dev worker) already use `utilityProcess.fork()` with `parentPort` for structured IPC and a `MessageChannelMain` port handed to the renderer. The assistant host follows the same pattern rather than inventing a fourth.
- A utility process gives a clean Node environment with no Chromium, carries structured JSON over the V8 structured clone (no PTY byte encoding), and is crash-supervised via `utilityProcess.on("exit")`.
- In-process embedding is rejected — an assistant-SDK crash would take down the main process. A localhost HTTP/WebSocket sidecar is rejected — it adds port binding, collision risk, and socket overhead that a `MessagePort` does not.

The CLI/Ink form stays available for development via the existing `daintree-assistant` agent id and its env-only MCP injection (`tier: "experimental"`). The native host is a separate code branch, never a replacement for that path.

## Message protocol

Two discriminated unions, both versioned by `ASSISTANT_HOST_PROTOCOL_VERSION`. The host announces the version it speaks in `host:ready`; Daintree refuses a mismatch rather than guessing at an unknown shape. The main process validates every inbound host message against `AssistantHostEventSchema` before forwarding to the renderer — a malformed or unknown-`type` message is dropped, never partially applied.

### Host → Daintree (`AssistantHostEvent`)

| Type | Meaning |
| --- | --- |
| `host:ready` | Booted, MCP-connected, ready for commands; carries the protocol version and any adopted resume handle. |
| `turn:start` | A conversation turn began (`user` or `assistant`). |
| `turn:token` | An incremental text chunk for an in-flight `assistant` turn. |
| `turn:end` | A turn completed, with an optional audit-aligned `TurnOutcomeClass`. |
| `tool:started` | A tool dispatch entered the call path; mirrors `McpToolCallStartedPayload` plus a stable `toolCallId`. |
| `tool:settled` | A tool dispatch settled, with audit-aligned `result`/`severity`. |
| `approval:requested` | The runtime is awaiting a `danger: "confirm"` decision; Daintree surfaces its own `ConfirmDialog`. |
| `approval:decided` | A prior approval resolved (`approved`/`rejected`/`timeout`). |
| `host:error` | A non-fatal error to surface, with a stable `code`. |
| `host:shutdown` | The host is winding down (`hibernate`/`revoke`/`error`/`exit`), with a resume handle when hibernating. |

### Daintree → host (`AssistantHostCommand`)

| Type              | Meaning                                            |
| ----------------- | -------------------------------------------------- |
| `prompt`          | Submit a user prompt to start a turn.              |
| `approval:decide` | Answer an outstanding `approval:requested`.        |
| `interrupt`       | Stop the in-flight turn.                           |
| `hibernate`       | Capture a resume handle and wind the runtime down. |
| `shutdown`        | Tear the runtime down for good.                    |

The fork-time `AssistantHostSessionDescriptor` is handed over once at spawn, not as a command, so every command is a post-handshake control signal.

## Invariants

These are the load-bearing rules every future wiring step must preserve. They encode hard-won lessons; breaking one reintroduces a known incident class.

1. **Every event and command carries `sessionId`, and delivery is pinned, never broadcast** (#7003). The main process resolves the session's minting `WebContents` and sends only there, failing closed if the view is gone. The schemas reject any message missing `sessionId` so a message that cannot be pinned cannot exist.
2. **Secrets travel via env, not messages.** The descriptor carries no bearer token and no MCP URL — those reach the host through `DAINTREE_MCP_URL` / `DAINTREE_MCP_TOKEN` / `DAINTREE_WINDOW_ID`, mirroring the existing env-only injection. `AssistantHostSessionDescriptorSchema` is `.strict()` and rejects a descriptor that smuggles a `token` or `mcpUrl` field, so a leaked port message can never carry the secret.
3. **One backend per project** (#7522). When the runtime is wired, provisioning must displace both PTY-backed and host-backed sessions for the same project inside the existing provision lock, with a `markHostForSession` analog to `markTerminalForToken`, re-checking ownership after every `await` in teardown.
4. **Outcome vocabularies stay audit-aligned.** `result`/`severity`/`decision`/`outcome` reuse the `mcpServer.ts` vocabularies (`McpAuditResult`, `McpAuditSeverity`, `McpConfirmationDecision`, `TurnOutcomeClass`) so the native timeline and the persisted audit log cannot drift.
5. **The host bootstrap installs its error guard before any dynamic import** (#8833). The `utilityProcess` entry must call the bootstrap error guard synchronously before `await import(...)`; Electron 42 only warns on unhandled utility-process rejections, so a failed import otherwise hangs the readiness wait silently.

## What is not in scope yet

- **Nothing constructs `AssistantHostProcess`.** No session provisions a host, no IPC channel is registered, and no renderer surface subscribes. The wrapper and the entry resolver exist; the wiring does not.
- No conversation transcript renders natively until the `@daintreehq/daintree-assistant` package emits `turn:start`/`turn:token`/`turn:end`. Until then the xterm pane remains the conversation surface, and the CLI/Ink path stays both the default and the fallback.
- Workflow-ledger events are additive: when the ledger lands, its records layer onto this timeline without changing the event shapes above.
