# Daintree Decisions

An agent that hits a decision it shouldn't make alone calls one MCP tool, `ask_human`, gets an immediate "queued" reply and ends its turn. Minutes or days later the user answers on their phone, and Daintree types a delimited, labelled answer into the exact terminal that asked, once that terminal is idle, resuming the agent session first if the pane is gone (#15996). The relay, the phone app and the wire protocol live in [daintreehq/decisions](https://github.com/daintreehq/decisions): a Cloudflare Worker, a Durable Object and an R2 bucket the user deploys into their own Cloudflare account. Questions, answers and screenshots are end-to-end encrypted between the user's computer and phone.

This doc is the contract for the Daintree side, written before any of it is built (#15997): where the service runs, how agents reach it, what is stored where, how an answer reaches a terminal, resume, Remote Hosts, and what Decisions costs when it is off. The lazy service, its entry module and its status read exist (#16001); every other new name below is marked with the child issue that adds it. Each child keeps this doc current as it lands. The relay [protocol](https://github.com/daintreehq/decisions/blob/08acc16585b78157c77af10a92e6a51aea2d37d4/docs/protocol.md) is normative for everything that crosses the network. The design started from the Decisions repository's [integration spec](https://github.com/daintreehq/decisions/blob/08acc16585b78157c77af10a92e6a51aea2d37d4/docs/daintree-integration-spec.md), which was checked against an older clone of this repository; where the two differ, this doc is what gets built here, and [Where this differs from the integration spec](#where-this-differs-from-the-integration-spec) lists each difference.

## Boundaries

- **One global setting.** Decisions is one switch for the user, in Settings → Integrations → Decisions, off by default. There is no per-project opt-in: turning the switch on, after consent that names it, is the opt-in that adds the Decisions server to every supported launch, a global opt-in as [Hard Line 2](../feature-curation.md#the-hard-lines) records. Remote Hosts are enrolled as devices of the same owner, automatically when they connect: they are never configured separately, and never get their own relay, relay URL or switch.
- **Supported agents are the ones with launch-time MCP.** An agent gets `ask_human` only through the additive launch-time MCP path (`capabilities.launchMcp`). Agents without it are listed as not supported, and Settings offers no manual setup line for them, because the standalone `decisions mcp` server has no pane identity and no way to type into a Daintree terminal, so a question asked through it could never be answered back into that terminal.
- **User-owned agent config is never modified.** Panes get the Decisions server beside the user's own servers, through the launch-time path only. Workflows that use the design-review gate are documented for users to add to their own skills; Daintree installs nothing into `~/.claude`, `~/.codex` or similar.
- **Observations, not interpretations.** UI and MCP results say what was observed ("Question q-42 is waiting for an answer"), never "agent is blocked".
- **Agents can't forge or downgrade.** Requirement levels come from trusted gates Daintree registers, pane identity comes from the bearer and never from tool arguments, and a proxy answer never satisfies `human-required`.
- **Hosted Features rules apply** ([feature-curation.md](../feature-curation.md#hosted-features)): off until enabled, consent that names what is sent and where, and gone entirely when off.
- **Out of scope:** a Daintree-operated server of any kind, replacing Canopy or [Answer from another device](../feature-curation.md#agents-and-attention), and a REST-only relay deploy with no Node toolchain.

## Code map

Existing seams the integration extends:

| Part | Existing code |
| --- | --- |
| Loopback MCP listener, request checks, route branches | `electron/services/mcp-server/httpLifecycle.ts` (`HttpLifecycle.handleRequest`, `setPluginRouteHandler`) |
| Orchestration auth the route must not reach | `electron/services/mcp-server/tierAuth.ts` (`isAuthorized`) |
| Pane bearers, pane configs, token resolvers | `electron/services/McpPaneConfigService.ts`; `wirePaneTokenResolvers` in `electron/ipc/handlers/terminal/lifecycle.ts` |
| Pane-bearer revocation | `McpServerService.revokePaneBearer` in `electron/services/McpServerService.ts` |
| Launch-time MCP formats and rendering | `shared/config/launchMcp.ts`, `electron/services/launchMcp/renderLaunchMcp.ts` |
| Reserved server keys | `RESERVED_PLUGIN_SERVER_KEYS` in `electron/services/pluginAgentMcp/serverKeys.ts` |
| Terminal wake engine | `TerminalNotifyService` in `electron/services/mcp-server/terminalNotify.ts`; `shared/utils/terminalWakeGate.ts`; `electron/services/mcp-server/approvalWake.ts`; `electron/services/mcp-server/noticeFormat.ts` |
| Guarded PTY submission | `PtyClient.submit` in `electron/services/PtyClient.ts`; `electron/services/pty/TerminalInputController.ts`, `electron/services/pty/WriteQueue.ts` |
| Spawn generation | `PtyClient.getLiveGeneration`, `PtyClient.isLiveGeneration`; `electron/services/pty/lifecycleLedger.ts` |
| Agent sessions and resume | `resume` blocks in `shared/config/agents/*.ts`, `buildResumeCommand` in `shared/types/agentSettings.ts`, `electron/services/pty/agentSessionHistory.ts`, `electron/services/pty/sessionIdCapture.ts`, `src/services/agentResume.ts`, `electron/services/viewless/viewlessAgents.ts` |
| Opt-in lazy service precedent | `electron/services/deviceAnswer/index.ts`, started from `electron/window/globalServicesInit.ts` |
| Settings store, ownership, migrations | `electron/store.ts`, `shared/config/settingOwnership.ts`, `electron/storeOwnership.ts`, `electron/services/migrations/` |
| App database | `electron/services/persistence/db.ts`, `electron/services/persistence/migrations/`, `electron/services/diskPressureState.ts` |
| OS keychain sealing precedent | `electron/services/plugin/secretCipher.ts`, `electron/services/plugin/linuxKeyringBackend.ts` |
| Secret redaction | `electron/services/redactSecrets.ts` |
| Settings tab registry | `src/components/Settings/settingsTabRegistry.tsx` (the `mcp` entry is the model) |
| Pane push-event precedent | `terminal:notify-state`: produced in `McpServerService.ts`, registered in `electron/ipc/handlers/events.ts`, `shared/types/ipc/maps.ts`, `electron/preload.cts`, `electron/ipc/channelLocality.ts`; read by `usePaneNotifyState` in `src/components/Terminal/TerminalNotifyChip.tsx` |
| Remote Host link CALL precedent | `electron/remote/deviceAnswer/linkMethods.ts`, `host.ts`, `client.ts` |

New code and extensions of existing modules. Decisions' own modules and the library packages are imported lazily; the setting declaration and the integration seams extend modules that are already loaded:

| Part | New code | Child |
| --- | --- | --- |
| The `decisions` setting, sanitiser, ownership entry | `electron/store.ts`, `shared/config/settingOwnership.ts` | #15998 |
| Listener and wakes held open with the MCP server off | `McpServerService.ts`, `httpLifecycle.ts`, `terminalNotify.ts` | #15999 |
| Main-process launch of a saved session as a new pane | general, beside `electron/services/viewless/viewlessAgents.ts` | #16000 |
| Service entry: `getDecisionsService()`, `startDecisionsIfEnabled()`, `setDecisionsEnabled()`, `stopDecisions()`, `DecisionsService`; the library binding; the `decisions:get-status` read | `electron/services/decisions/index.ts`, `DecisionsService.ts`, `libraries.ts`; `decisionsNamespace` in `electron/ipc/handlers/deviceAnswer.ts`; `loadDecisionsModule` in `electron/window/serviceRefs.ts` | #16001 |
| `LocalStore` over the app database, its opener, `eraseDecisionsData` | `electron/services/decisions/daintreeLocalStore.ts`, `openLocalStore.ts`; `0022_decisions_store.sql` | #16002 |
| `KeyStore` sealed with `safeStorage` | `electron/services/decisions/keyStore.ts` | #16003 |
| Settings page | `src/components/Settings/` (Integrations → Decisions) | #16004 |
| Relay URL check, claim or restore, recovery kit | `electron/services/decisions/` | #16005, #16006, #16007 |
| Relay socket lifecycle | `DecisionsService.ts` | #16008 |
| Pairing, revoke and rotate | `electron/services/decisions/`, Settings → Devices | #16009, #16010 |
| `/mcp/decisions` route, `setDecisionsRouteHandler`, `PaneAuthenticator` | `httpLifecycle.ts`, `electron/services/decisions/paneAuthenticator.ts` | #16011 |
| Launch-config entry and Decisions-only bearer | `McpPaneConfigService.ts`, `lifecycle.ts` | #16012 |
| Trusted gates and question defaults | `electron/services/decisions/workflowGates.ts` | #16013 |
| Worktree-confined attachments, durable spool | `electron/services/decisions/attachmentResolver.ts` | #16014 |
| `decision` wake kind, `createDecisionWake`, answer formatter, `TerminalSink` | `terminalNotify.ts`, `noticeFormat.ts`, `electron/services/decisions/daintreeTerminalSink.ts` | #16015 |
| `terminal:decision-state` push and current-state read | IPC registration as for `terminal:notify-state` | #16016 |
| Durable delivery scheduler and crash reconciliation | `electron/services/decisions/` | #16017 |
| Pane chip (renderer) | beside `TerminalNotifyChip` | #16018 |
| `AgentResumeAdapter` for Claude and Codex | `electron/services/decisions/daintreeResumeAdapter.ts` | #16019 |
| Needs-attention list (renderer) | reachable from the chip and Settings | #16020 |
| Host enrollment CALL, Host-resident service | `electron/remote/decisions/linkMethods.ts` and its host and client halves | #16021, #16022 |
| Deploy offer | `electron/services/decisions/deploy.ts` | #16023 |
| Full-loop check, export and delete, decision model, mark | `electron/services/decisions/`, Settings | #16024–#16028 |
| User guide | `docs/decisions.md` | #16029 |

### Libraries

The protocol, crypto, client and decision-model code is published from daintreehq/decisions as `@daintreehq/decisions-protocol`, `@daintreehq/decisions-crypto`, `@daintreehq/decisions-client` and `@daintreehq/decisions-model` and Daintree pins their first release, 0.1.0 (daintreehq/decisions#13). They are `dependencies`, bundled into the main build rather than shipped in the ASAR's `node_modules` (#16001). `electron/services/decisions/libraries.ts` binds all four, so their code lands in the service's lazy chunk and nowhere else; later children take what they need from that binding or import it beside the service. The relay socket uses the `ws` package main already depends on.

The client library owns signing, encryption, the relay client and socket protocol, the durable queues, the delivery state machine, the MCP handler and the decision model. Daintree supplies its host seams by implementing the library's interfaces: `LocalStore` (#16002), `KeyStore` (#16003), `PaneAuthenticator` (#16011), `TerminalSink` (#16015), `AgentResumeAdapter` (#16019) and a populated `PolicyRegistry` (#16013), with `ProxyEngine` from the model package (#16026). These are library contracts, checked against the pinned release, not Daintree symbols.

## Where it runs

Decisions runs in the main process of the machine that owns the pane: this machine's main for local panes, and the Host's own main process for panes on an enrolled Remote Host (#16022), where the agent, its MCP listener, its bearer and its PTY already live ([remote-hosts.md](./remote-hosts.md)). The renderer only reads state and writes the setting over IPC. Nothing runs in a project view, and nothing needs a window open.

The service follows the `deviceAnswer` precedent: a memoised lazy singleton, `getDecisionsService()` in `electron/services/decisions/index.ts`, and a boot step, `startDecisionsIfEnabled()`, run from a deferred task in `globalServicesInit.ts` that returns early unless `store.get("decisions")?.enabled` is true (#16001). It also starts and stops when the setting changes at runtime, and its shutdown is part of app shutdown. The service exposes its state as observed (off, not connected, connecting, connected, revoked), readable over IPC.

As built (#16001): `DecisionsService` runs one enabled lifetime from `start(settings)` to `stop()`, one transition at a time, and `dispose()` at quit is final. Each child acquires its resources in `start` and releases them in `stop`. Status listeners subscribe with `onStatusChanged`; they outlive a stop, not a dispose. Until a relay identity and socket exist (#16006, #16008), on reads as `not-connected`. Every runtime change to the switch goes through `setDecisionsEnabled`, which writes the setting through `writeDecisionsSettings`, keeping every other field, then starts or stops the service to match; a direct `store.set` would leave the service out of step, and nothing watches the store. The renderer reads `window.electron.decisions.getStatus()` (`decisions:get-status`, `shell` locality), which answers `off` from the store while the switch is off and asks the service otherwise. There is no status push yet; the child that first needs live status adds one. Decisions' entry module is loaded only through `loadDecisionsModule` in `serviceRefs.ts`, which every loader calls after reading the switch as on. Quit seals it in the same synchronous step that halts deferred startup, then stops a load already under way before any terminal is captured, so quitting with Decisions off imports none of it.

**With the MCP server off** (#15999). Turning the MCP server setting off today disposes every queued wake and closes the listener (`McpServerService.setEnabled`), and `TerminalNotifyService.enqueueWake` refuses any wake with `notices-off` while the service is disabled. A user who wants phone answers but not the agent control surface would get neither. #15999 lets a feature hold the listener open and keep the wake engine accepting its own wakes while the server setting is off. In that state `/mcp` and `/mcp/plugin/` stay refused and the existing notice kinds stay off, exactly as with the server off today; the port and the Host and Origin checks are the same ones, not a second listener. With no feature holding it, turning the server off behaves exactly as now.

## What being off costs

With the setting off from startup, Decisions costs one setting read in a deferred boot task and one registered IPC read, and nothing else:

- **No Decisions module is imported.** The boot step reads the setting before importing anything under `electron/services/decisions/` or any `@daintreehq/decisions-*` package. This is stricter than `deviceAnswer`, whose deferred task imports its small index module before checking. The eager import walk (`scripts/check-import-budget.mjs`) must not grow; it runs on demand, not in CI, so `scripts/decisions-lazy-boundary.test.ts` is the gate: it builds main as production does and fails if its startup graph reaches any module under `electron/services/decisions/` or any `@daintreehq/decisions-*` package (the import budget's `FORBIDDEN_EAGER_PATTERNS` carries the same rule), if Decisions code lands in a chunk main loads at startup, or if any module of its own joins the startup graph. Its status read is declared in `electron/ipc/handlers/deviceAnswer.ts`, a handler module startup loads anyway, so Decisions adds no module there; a later IPC op joins the same `decisionsNamespace`. The boot task's own test proves the off task reads only the setting, evaluates no Decisions module and leaves no new active resource.
- **No resources.** No listener hold, no `/mcp/decisions` handler (the path answers 404 while the MCP server keeps the listener up, and nothing listens otherwise), no socket, timer, file handle, `powerMonitor` subscriber or IPC push, and no renderer subscription or chip.
- **No change to launches.** Every agent launch is byte-for-byte what it is today (#16012).
- **Turning it off at runtime** closes the socket, clears the timers, empties the route seam, releases the listener hold and stops delivery. Modules already evaluated stay in memory (ES modules can't be unloaded) but hold nothing. Panes launched while it was on keep their config entry until they relaunch, and their calls get 404 or find no listener. Stored data stays on disk (#16002) until the user deletes it (#16025).

Rollback for every child is the switch: with `decisions.enabled` false at startup the seams are empty and no Decisions module is imported.

## The setting

One `decisions` object in the electron-store schema (`electron/store.ts`, beside `deviceAnswer`), with `enabled` defaulting to false (#15998). It also holds the relay origin, the installation, device and host ids, and the non-secret preferences later children need (`autoEnrollHosts` among them, #16021), shaped so a field can be added later without another breaking migration. Loading sanitises it field by field, as `deviceAnswerSettings.ts` does for `deviceAnswer`, and never crashes: a value that isn't a usable object falls back to off. A store migration is added only if one is needed, self-contained and idempotent, after the latest in `electron/services/migrations/` (042 at the time of writing).

Every field is owned by the machine the user sets it on: `device` in `shared/config/settingOwnership.ts`, as `deviceAnswer` is, enforced at compile time through `electron/storeOwnership.ts`. A window bound to a Remote Host therefore never routes it to the Host, and its IPC channels are `shell` in `channelLocality.ts`, like the device-answer channels. No secret is ever stored in this object: not the claim secret, keys, tokens or the recovery passphrase.

## Asking: `/mcp/decisions`

### The route

Agents reach Decisions through three MCP tools served by the library's handler on its own route (#16011). It doesn't go on the control surface (`/mcp`): that is gated by a per-project tier that defaults to off, and putting `ask_human` there would tie a human-in-the-loop feature to granting agents the whole control surface. Plugin endpoints are the wrong trust model and can't type into a terminal.

`HttpLifecycle.handleRequest` today rejects repeated security headers (400), then a `Host` other than `127.0.0.1:<port>` or `localhost:<port>` (403), then a mismatched `Origin` (403), then branches `/mcp/plugin/` off to the plugin route handler before `isAuthorized` runs. The Decisions branch sits right after the plugin branch, for the path prefix `/mcp/decisions`, also before `isAuthorized`, and answers 404 when no handler is installed. Its seam is `setDecisionsRouteHandler` on `HttpLifecycle`, beside `setPluginRouteHandler`, installed by the Decisions service only while it is enabled.

### Authentication and identity

The route accepts only a valid Decisions pane bearer. API-key and help tokens are refused (an API-key client has no pane of its own), as are plugin grants and missing or foreign tokens. One consequence: the help panel's Assistant, which holds a help token, isn't offered `ask_human`. `isAuthorized` accepts any token in the pane-token map (`tierAuth.ts`), so the Decisions credential minted for a tier-off pane must never be one that `isAuthorized` would accept on `/mcp` (#16012).

The pane's identity is derived server-side from the bearer, never from tool arguments: the pane id (`getPaneIdForToken`), its ownership principal (`getOwnershipPrincipalForToken`) and its launch workspace binding (`getPaneWorkspaceBindingForToken`), plus the terminal's live generation, agent incarnation, agent session, project and worktree. A `PaneWorkspaceBinding` carries the workspace id and action context, not a worktree root, so the worktree root is recorded from the pane's launch facts.

A session is bound to the credential that opened it, as core sessions are (`bindSessionCredential` with `sessionCredentialDigest`; the plugin route keeps its own credential index to the same effect). Pane sessions are never idle-reaped (#13635). `revokePaneBearer`, called when a pane's terminal exits or relaunches, already revokes what the principal owns and closes its sessions; #16011 extends it to close that pane's Decisions sessions too. The pane's open questions stay deliverable to that pane only.

### Tools

`ask_human`, `get_decision` and `cancel_question`, with the library's input schemas (`AskHumanInput`: question, context, options, attachments, `requested_requirement`, `workflow_gate_id`, `expires_at`, `correlation_id`). Each tool description is under 400 bytes; `mcpWireBudget.test.ts` measures only the action manifest, so #16011 adds its own measurement of these three. They are not actions and sit on no MCP tier, so they don't touch the external-tier budget (`tierAuth.test.ts`).

`ask_human` writes the question and its origin to the local store before any network I/O, then returns at once with `Asked as q-<alias>. End your turn now (or continue with unrelated work); the answer will arrive as a message in this terminal.` The question is published to the relay when connected. The alias `q-N` is a cosmetic per-installation counter; wire ids are full unguessable identifiers. The call returns once the question is committed locally, without waiting on the relay or the human, so a CLI's tool timeout is never the answer's deadline. `get_decision` and `cancel_question` see only the calling pane's questions. A pane holds at most 10 open questions, under a per-pane rate limit.

The server key `daintree-decisions` joins `RESERVED_PLUGIN_SERVER_KEYS` so a plugin can't claim it; it fits the 25-character key limit, and Claude Code names the tool `mcp__daintree-decisions__ask_human`.

## Supported agents

Panes get MCP servers through the additive launch-time path: `preparePaneConfig` in `McpPaneConfigService`, called from the agent launch in `electron/ipc/handlers/terminal/lifecycle.ts` and rendered per CLI by `renderLaunchMcp`. A format that needs a file gets one written 0600 under `userData/mcp-pane-configs`; PTY exit revokes the bearer and deletes the file, best effort. Bearers travel in that file or the PTY env, never in argv.

Today a pane gets no config at all when its project's tier is off and no plugin is granted: `preparePaneConfig` refuses that case, and tier off mints no bearer. Off is the default tier, so most panes would never see `ask_human`. With Decisions on, #16012 gives every launch of an agent with launch-time MCP a `daintree-decisions` entry and its own bearer, whatever the tier. That bearer authorises `/mcp/decisions` only, never the control surface or a plugin route. With the tier off, the pane still gets no `daintree` control-surface entry. With Decisions off, launches are unchanged.

| Agent id | Format | How it reaches the CLI |
| --- | --- | --- |
| `claude` | `claude-mcp-config` | `--mcp-config <file>` |
| `codex` | `codex-config-overrides` | `-c mcp_servers.<key>.…`, bearer from the PTY env |
| `gemini` | `gemini-system-defaults` | settings file named by `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` |
| `qwen` | `qwen-mcp-config` | `--mcp-config <file>` (`httpUrl`) |
| `opencode` | `opencode-config-content` | `OPENCODE_CONFIG_CONTENT` |
| `copilot` | `copilot-additional-mcp-config` | `--additional-mcp-config @<file>` |
| `amp` | `amp-mcp-config` | `--mcp-config <file>`, bare server map |
| `mistral` (Mistral Vibe) | `vibe-mcp-servers-env` | `VIBE_MCP_SERVERS`, bearer from the env |

A plugin-contributed agent that declares `launchMcp` (`shared/types/plugin.ts`) renders through the same formats and is covered by the same rule. The built-in agents with no `launchMcp` are not supported: `cursor`, `grok`, `kimi`, `antigravity`, `crush`, `kiro`, `goose`, `aider` and `interpreter` (Open Interpreter). The Decisions page lists which installed agents get `ask_human` and which aren't supported yet, with no manual setup line. Supporting one of them means giving it a launch-time format in the agent registry, which is its own change.

## Origin and routing

Before anything touches the network, the bridge records the question's origin in the local store:

| Field | Where it comes from | Note |
| --- | --- | --- |
| `host_id` | Decisions' own id for this machine, minted at claim or enrollment, mapped to Daintree's `HostId` | `LOCAL_HOST_ID` (`"local"`) is unique only per machine |
| `pane_id` | the terminal id |  |
| `terminal_generation` | the spawn's `launchGeneration` (`PtyClient.getLiveGeneration`, checked with `isLiveGeneration`) | from a per-process ledger: monotonic within a run of the app, not durable across restarts |
| `ownership_principal` | `getOwnershipPrincipalForToken` | a fresh UUID on every launch; anything keyed by it ends with the run, as `TerminalNotifyService.revokeOwner` relies on |
| `agent_incarnation` | `agentIncarnation` on the panel | an observation, not proof of process identity |
| `agent_session_id` | `agentSessionId` | Claude's is assigned at launch (`--session-id`); others are learned passively, from output and teardown (`sessionIdCapture.ts`, `agentEndCapture.ts`), from a resumed run's argv (`agentRunArgv.ts`) or, for Codex, live attribution (`CodexLiveSessionAttribution.ts`). It may be unknown when the question is asked, and can be stale: Claude's own `/clear` and `/resume` switch conversations without telling Daintree |
| `project_id`, `worktree_id`, worktree root | the pane's launch | local only, never sent to the relay |
| `project_label`, `machine_label` | the project's and machine's display names | inside the encrypted content only; the phone shows them on every question |

On the wire, `origin_ref` is a salted hash of `(host_id, pane_id)`, used only for per-pane quotas.

**Routing rules.** An answer is typed only if host, pane, generation, ownership principal, observed agent incarnation, recorded agent session and worktree all still match the origin. That is a match against what Daintree observed, not proof of which conversation the CLI has open. Otherwise it goes to resume when that is available, or to needs-attention, and is never typed into a guessed same-named pane or project. Every spawn mints a new generation and principal, so an answer for a question asked before a relaunch or an app restart never matches the new run directly; resume can find the restored pane still running the same session and re-target the delivery to it, with the correlation to the original question recorded (#16017, #16019). Each answer carries its own question id and revision, and answers for one pane are delivered in question order.

## Policy and attachments

**Trusted gates** (#16013). Daintree populates the library's `PolicyRegistry`; an agent can't register, edit or loosen a gate. With no trusted gate a question is `human-required`, and an agent's `requested_requirement` can only make it stricter. An unknown `workflow_gate_id` is treated as no gate. The first gate is `design-review/final`: `human-required`, `approve`/`reject` choices, bound to the screenshots attached, with `get_decision` reporting `reviewed_digests_match`. The proxy allowlist, which lets non-gated questions accept proxy answers, is off by default. Default expiry allows "never", and an expired question never authorises anything; its notice says so. How a workflow uses the gate is documented for users (#16029); `scripts/design-review-shots.mjs` is only a capture utility and implements no gate.

**Attachments** (#16014). An attachment's `local_resource_id` comes from the agent and is untrusted. It resolves relative to the pane's launch worktree with `realpath`, and anything outside the worktree, including through a symlink, is refused. Only PNG, JPEG and WebP, checked by magic bytes; SVG is refused. Limits: 20 MiB per file, 8 files and 64 MiB per question. Uploads are encrypted and spooled durably (the library's default spool is in memory), so they survive a restart before they finish, and the spool is cleaned once uploaded or cancelled. Refusals tell the agent what was wrong without echoing file contents.

## The relay connection

- **URL check** (#16005). Settings takes a relay URL, normalises it (https only, no path) and checks it from main through the unsigned `/health` and `GET /api/v1/info`, reporting what it observed: unreachable, not a Decisions relay, protocol incompatible (with both ranges), unclaimed, claimed, or claim secret not configured. Once connected it compares the relay's `worker_version` and protocol range with Daintree's and prompts when they diverge. Daintree never updates the Worker. No request goes from the renderer.
- **Claim or restore** (#16006, #16007). A fresh relay is claimed once with its claim secret, held in memory only, and this machine becomes the `owner-desktop`. A relay already claimed elsewhere is joined by restoring the identity from a recovery kit. Setup completes only after a recovery kit is saved and verified.
- **The socket** (#16008). One outbound WebSocket to the relay's Durable Object, which uses Cloudflare's hibernation API so an idle connection costs almost nothing: no inbound port and no polling. The lifecycle is the protocol's: a single-use ticket, then `hello`, `sync` and `caught_up`; each event is verified, persisted and only then acknowledged, with the cursor advanced over contiguous sequence numbers; the text frame `ping` every four minutes and no application-level heartbeat. Close code 4409 (another process using this identity) backs off and warns; 4401 (this device revoked) stops for good and shows "revoked", with no reconnect loop; anything else reconnects with jittered exponential backoff from 1 s to 5 min. It reconnects on app start, on `powerMonitor` resume, on a network change and on re-enable, always resyncing from the stored cursor. The socket URL carries the ticket and is never logged.
- **Phones** (#16009, #16010). Devices → "Pair a phone" shows a QR code for a one-time invitation; both screens then show the same six digits, and the user confirms they match. Revoking a device rotates the epoch key, so the relay holds new grants for every remaining device, and content the phone already downloaded can't be recalled.

## Delivering an answer

### The `decision` wake

Answers are typed through the same wake engine as Daintree's own notices, which waits for the terminal to settle, spaces lines per pane, and aborts if the pane is withdrawn or re-owned (#16015). `LaneWake.kind` has five kinds today (`notice`, `retired`, `lost`, `watch`, `approval`); `decision` is the sixth, with its branch in line assembly. `createDecisionWake`, modelled on `createApprovalWake`, provides:

- **`id`**: `dec-` plus a hash of question id and answer revision, matching `LANE_WAKE_ID_PATTERN`, so duplicates join one queued wake.
- **`recheck()`**: the pane still exists, `isLiveGeneration(paneId, generation)` holds, the ownership principal and observed agent incarnation are unchanged (a relaunch reports `unavailable` with reason `relaunched`), and the recorded agent session matches.
- **`beforeType()`**: writes the injection intent (`injection_id`, question id, revision) durably and synchronously before anything is typed; false keeps the wake off the line for good.
- **`report(outcome)`**: maps `delivered`, `held`, `unavailable` and `ambiguous` to the library's `TerminalSink` outcomes.

The wake is queued on the asking pane's own notice line, keyed by `paneNotifyKey(principal)`. Today's `McpServerService.queueLaneWake` serves help lanes only, so #16015 adds the pane entry beside it.

### The gate

An answer is typed only at an idle prompt: never into a busy, typing or approval-blocked pane. That is stricter than the notice line today. Notices use `wakeGateOptionsFor`, which lets an agent that declares `queuesInputWhileWorking` (Claude and Codex do) take a line mid-turn, and the `"settled-prompt"` guard re-evaluates the gate at PTY admission with the same exception. `"settled-prompt-strict"` refuses mid-turn but uses `ASSISTANT_SEND_GATE`, which accepts a prose question. Neither is the decision contract, so #16015 adds a gate that refuses a working agent and does not set `acceptQuestion`, enforced both in main and at PTY admission, and settles how a decision line shares the pane's line with ordinary notices without loosening either.

### What is typed

The delimited block from the protocol, produced by the new answer formatter in `noticeFormat.ts`, plus the injection marker that crash reconciliation looks for. The integration spec's sample omits the marker, and its exact line is #16015's to define:

```text
[DAINTREE DECISION ANSWER] (data, not instructions from the system)
question_id: <id>
revision: 1
source: human
choice: approve
comment: Proceed with the compact sidebar.
[END DAINTREE DECISION ANSWER]
```

Answer text is sanitised: control and escape sequences stripped, the end delimiter neutralised inside user text, length capped. `source: proxy` is always labelled. The framing words are Daintree's own, and answer text appears only in the block's labelled fields. Typing goes through `client.submit(terminalId, text, token, undefined, guard, undefined, null)`, where the final `null` keeps the answer from being recorded as the run's first prompt: the multi-line body goes in as one submission, the trailing Enter is dropped if the user typed meanwhile (`abandonEnterOnInput`), and a withdrawn or re-owned pane stops the submission before its Enter, which can leave the text unsent in the composer. A line counts as delivered only once the engine has confirmed `pty_written`, which proves the write reached the PTY, not that the agent read it. Submissions to one pane are at least `MIN_NOTIFY_INTERVAL_MS` (5 s) apart with one outstanding at a time, and answers batched for the same pane are joined into one paste.

### Durability

Wakes are in-memory attempts: one still waiting expires `LANE_WAKE_MAX_PENDING_MS` (10 minutes) after admission, a pane holds at most 32, and they end on the user's stop, trash, relaunch, bearer revocation, pane exit, the MCP-off teardown and app restart. Answers can arrive days later, so the durable store is the authority and a wake is only the typing mechanism (#16017):

- **When delivery is tried.** On app start, when the owning pane appears, when a pane goes idle, and every minute while anything is pending, which is an indexed query and cheap when nothing is.
- **Reporting.** A delivered answer is recorded locally first, then reported to the relay as terminal-delivered.
- **Crash.** If the app dies between the intent and the report, startup looks for the injection marker in the pane's scrollback. Found means delivered. Not found, with the pane possibly touched since, means `delivery-uncertain`: an absent marker doesn't prove absence (scrollback is bounded), so the answer is never re-typed without the user choosing to.
- **No match.** An answer whose origin no longer matches is never typed anywhere else; it goes to resume when available, otherwise to needs-attention.

## Resume and needs-attention

**Launching a saved session from main** (#16000). Main has no way today to resume an agent session in its worktree with no window involved. `agentSessionHistory.resume` is a renderer action built on `resumeSessionIntoPanel` in `src/services/agentResume.ts`; `spawnHostAssistant` resumes, but only the Assistant, with no worktree and no saved layout; `runAgentLaunch` takes a worktree but can't resume. #16000 adds a general main-process capability: launch a saved session by agent kind and session id as a new pane in a given project and worktree, through the normal launch path so the pane gets its usual launch-time MCP config, a fresh bearer and a fresh generation; save it in the project's layout so it appears when the project is opened; return the pane's identity and let the caller wait, with a timeout, for an idle prompt; refuse with a reason when the worktree is gone, the agent has no resume support or no session id is known; and return the existing pane when one already has that session open, as `findLiveResumePanelId` does in the renderer. Nothing in it is Decisions-specific.

**Resuming to deliver** (#16019). Claude (`--resume <id>`) and Codex (`resume <id> -C .`) only. Resume runs when the origin Host is this machine and reachable, the worktree still exists at the recorded path, the agent has a resume block, and a session id is known. It launches through #16000, waits for an idle prompt within a bounded time, records the new pane, generation and session as the delivery target, then delivers. Claude's sessions are stored per folder and don't survive a move; Codex resumes by session id from any folder. Many other registry entries have a `resume` block, but a block isn't proof of exact-session resume (kinds include rolling history and project-scoped resume, and Gemini's CLI is retired), so every other agent reports unsupported, with a reason, until its resume is proven against the installed CLI.

**Needs attention** (#16020). Answers that can't be delivered on their own (relaunched, worktree removed, resume failed, delivery uncertain) are listed with their alias, origin, reason and an answer preview. **Copy answer** copies the delimited block. **Try resume** runs #16019 and reports what happened. **Choose destination** lets the user pick another live pane, behind a confirmation that names both panes, and records the reassignment in the audit trail. A `delivery-uncertain` answer says "This answer may or may not have been delivered" and offers Copy.

## Remote Hosts

An agent on a Remote Host keeps its MCP listener, bearer, notices and terminal on that Host, and the Host keeps running agents while the owner's machine sleeps. Forwarding questions from the Host through the owner's machine would fail exactly then, so each Host is its own relay device of the same owner (#16021, #16022). The user's effort is the same as with a single hub: setup happens once, on the owner's machine, and every Host the owner connects to is enrolled with no step on either side.

- **Roles.** The machine where the user ran setup is the `owner-desktop`: it claims the relay, holds the epoch keys and approves phones. Every enrolled Host is a `desktop-host`.
- **Enrollment.** A connected Host is enrolled over the already authenticated link with a new session CALL, `decisions.enrollHost` (in `electron/remote/decisions/linkMethods.ts`, with a zod schema checked on the Host and a validated result on the Shell, like `electron/remote/deviceAnswer/linkMethods.ts`). The Host generates its keys and returns only the public halves; the owner signs a device certificate and an epoch grant sealed to the Host's exchange key and registers them with the relay; the Host stores its identity sealed by its own keychain. Private keys never cross the link. A Host too old to know the method answers unsupported, and Devices says it needs updating. (`ClientEndpoint.request` in `electron/ipc/endpoint.ts` is the Host-to-renderer reverse request, not the Shell-to-Host CALL path; enrollment uses session CALLs as the device-answer client does.)
- **Automatic by default.** Only the `owner-desktop` enrolls, since only it holds the signing key; a second Shell that connects to a Host enrolls nothing. While Decisions is connected on the owner, it enrolls each Host that isn't enrolled yet when that Host's link comes up, and every already connected Host once setup completes. One Host's enrollment failing never holds up another's, and a failure is shown in Devices and tried again on the Host's next connection, never in a loop. Each enrolled Host can decrypt every question and answer, as every device can, which is acceptable without asking per Host because a Remote Host already runs the owner's agents, holds their code and shows their terminals. The consent on first enable says connected Hosts are enrolled. A device-owned `autoEnrollHosts` field in the `decisions` setting, defaulting to true (a sanitiser default, no migration), turns this off for a user who connects to machines they don't own; with it off, Devices offers **Enroll** per connected Host instead.
- **Revoke is the undo.** Enrolled Hosts are listed in Devices beside phones. Revoking one uses device revoke with key rotation, and the owner records the Host's id in its local store (#16002) so it is never enrolled automatically again; **Enroll** in Devices enrolls it again and clears the record.
- **An identity, not settings.** The Host has no relay URL field or switch of its own; the relay origin comes with the identity it was given. It runs Decisions for its own panes whenever the owner has Decisions on. When the owner disables Decisions or revokes the Host, the Host stops, removes its delivery credentials and shows the reason; a revocation reaches a Host the Shell isn't connected to through the relay (4401), and how a disable reaches one is #16022's to settle.
- **Its own work only.** A Host acts only on questions it created and ignores events targeted at other devices. It receives the same ciphertext as every device, which is acceptable because every device belongs to one owner. A Host that was offline catches up through `sync`; pending answers wait in the relay meanwhile.
- **Topology.** macOS and Linux Hosts are reached over ssh; Windows is a Shell only, driving Linux Hosts inside WSL distros, and a WSL Host enrolls the same way. A WSL distro stops about 15 s after its last `wsl.exe` client exits, and its keeper (`wslKeepalive.ts`) lives only as long as Daintree on Windows, and closing the last window quits Daintree on Windows (it can't be a Host), so a WSL Host's agents and its Decisions service can stop once Daintree on Windows is closed.
- **Shell view.** The Shell's Decisions page shows each enrolled Host's connection state as observed. Pane state (`terminal:decision-state`) has `host` locality, so a window on a Host reads its own panes' state from that Host.

## What is stored where

| What | Where | Child |
| --- | --- | --- |
| The `decisions` setting: enabled, relay origin, ids, non-secret preferences | electron-store, `device`-owned | #15998 |
| Owner signing key, epoch keys, device keys | one file, `userData/decisions/keys.bin` (0600, in a 0700 directory), sealed with `safeStorage`; kept when Decisions is turned off | #16003 |
| Questions and their origins, outbox, inbound event log and cursor, injection intents, audit trail | the app database (better-sqlite3), the `decisions_*` tables from migration 0022 | #16002 |
| Encrypted attachments waiting to upload | a file spool under the user-data directory, removed once uploaded or cancelled | #16014 |
| A pane's `daintree-decisions` entry and bearer | the existing pane config (`userData/mcp-pane-configs`, 0600) or the PTY env; the bearer is revoked on PTY exit and the file deleted, best effort | #16012 |
| Decision-model history | the model's own local store, only with learning on | #16026, #16027 |
| On a Host: its sealed identity and its own store | the Host's own user-data directory | #16021, #16022 |
| On the owner: the ids of Hosts the user revoked, so they aren't enrolled automatically again | the owner's local store | #16021 |
| Never on disk, in logs, the audit trail or telemetry | claim secret, recovery passphrase, Cloudflare token, socket ticket URL | #16003, #16006, #16007, #16023 |

**The local store.** As built (#16002): `DaintreeLocalStore` implements the library's `LocalStore` over the shared app-database connection, in six raw-SQL tables (`decisions_meta`, `decisions_questions`, `decisions_outbox`, `decisions_inbound_events`, `decisions_injection_intents`, `decisions_audit`) from `0022_decisions_store.sql`, used through `sqlite.prepare` as `0017_assistant_sender_credentials.sql` is. Question content arrives sealed (`content_sealed`, the published envelope) and answer entries are sealed one by one inside `answers_json`, so no row holds question or answer text in clear; the library's legacy plaintext column has no counterpart here, and the store refuses a non-null `legacy_content_json`. The origin keeps its optional project and machine labels. None of it goes in logs or anything that leaves the machine; the audit trail carries ids, requirement level, gate, provenance, outcome and timestamps only, in Decisions' own table rather than an MCP audit ring.

- **Batching.** Calls queue in the order made and run together on the next turn of the event loop, in one transaction, each inside its own savepoint, at most 256 to a transaction: a call that fails on its own (a duplicate question) rolls back alone, and no call resolves before the transaction holding it has committed, so a question is on disk before `ask_human` publishes it and an intent is on disk before a terminal is touched. Concurrent calls and bursts share one commit. The library's socket handler awaits each frame's writes in turn before acknowledging it (stored, then acked), so successive frames can't share a commit without acknowledging what isn't on disk; merging them would need a bulk-ingest change in the library. A read with nothing queued ahead of it runs at once.
- **Durability.** A transaction with writes in it commits with `synchronous = FULL`, as the library requires, and the connection goes back to the app's `NORMAL` straight after, so other writers keep their cheaper commits. State survives a restart, undelivered answers included.
- **Disk pressure.** While `getWritesSuppressed()` is on, every write is refused with `DecisionsStoreUnavailableError` (`disk-pressure`), audit records included, never dropped: a question is either committed or its caller is told it wasn't. The first refused write, or any storage error on a read or a write, stops that store writing for the rest of its lifetime (`isFaulted()`); reads keep working, and the next enabled lifetime opens a fresh store. This matters because the library's inbox marks an event processed after a failed apply: once an answer's question can't be read or its write is refused, the mark must be refused too, or the answer would be lost. Recovering without a restart or a toggle, and making the bridge stop on a storage error instead of marking the event processed, belong to the children that drive the bridge (#16008, #16017).
- **Lifetime.** `DecisionsService.start` opens the store through `openDecisionsLocalStore` (lazily, and never once the lifetime has been disposed, so quitting can't reopen the database), and `getStore()` hands it to later children; `stop` and `dispose` close it, committing what was queued. Closing never closes the shared connection, and shutdown stops Decisions long before `closeSharedDb`. Disabling Decisions leaves the data in place. `eraseDecisionsData(sqlite)` deletes every Decisions row in one transaction and nothing else. Nothing calls it yet: it is there for Data → delete (#16025), which must run it with the store closed (calls still queued would write rows back) and decide what to do about backups and freed pages, since the store has no `compact()` (there is no pre-sealing plaintext to purge).
- **Tests.** `daintreeLocalStore.contract.test.ts` ports the library's store contract at v0.1.0 (its `LocalStore contract` and `atomic intent settlement` blocks, which the package doesn't export) and runs it against this store; an upgrade of the pinned release re-ports it from the new tag.

**Keys.** Core Daintree has no encrypted secret store: `SecureStorage` is plain text by design. The plugin secret cipher and the Decisions `SealedKeyStore` (`keyStore.ts`, #16003) both seal through `osKeychain.ts`: the async `safeStorage` API, a 60 s deadline, and one process-wide record of a keychain that gave no key this session. The plugin cipher refuses Linux's `basic_text` backend with no override. The key store refuses it with a reason (`weak-storage-unconfirmed`) until setup calls `confirmWeakStorage()` after the user accepts the weaker storage; the file records that protection, so later saves on that machine keep working, and the next save once a keyring answers seals it properly. A real keyring that answers with the fixed-key fallback is a keychain failure, never weak storage. Only a missing file is "no keys", read without asking the keychain; a keychain that can't open existing keys is reported as `locked`, `unavailable` or `timeout`, and a file it can't explain as `unreadable` or `unsupported-format`. `save` opens the existing keys before replacing them (a recovery import's overwrite included), so none of those ever overwrites them; only an explicit `clear()` removes the file. `check()` tells setup what sealing would use before it saves anything. The service makes the store on first use in an enabled lifetime, so turning Decisions on asks no keychain, and closes it on stop. Claim secrets, recovery passphrases and Cloudflare tokens are matched by `redactSecrets.ts` (screens that leave the machine) and the shared `secretScrubber.ts` (logs, telemetry, the MCP audit summary), and `passphrase` joins the sensitive key names in the logger and the MCP argument summary, as a backstop: nothing writes them anywhere in the first place.

## What leaves the machine

This is what the consent shown on first enable names (#16004), and what [feature-curation.md](../feature-curation.md#hosted-features) records:

- **To the user's own relay**, in their Cloudflare account: the question, its context and options, attached screenshots and the answers, all end-to-end encrypted between the user's computer and phone; signed protocol events and delivery acknowledgements; and routing metadata the relay can read (ids, timestamps, requirement level, sizes).
- **To each enrolled Remote Host**: an epoch grant sealed to the Host's own key and registered with the relay, which lets it decrypt every question and answer so it can serve its own panes. Hosts are enrolled automatically when they connect unless the user turns that off (#16021).
- **Push endpoints.** Each paired phone registers its own with the relay, which sends Web Push to the phone app (a PWA the same Worker serves). A push says only that a question needs input, never the question.
- **Voice dictation**, if the user turns it on in the phone app, is not end-to-end encrypted. Daintree sends nothing for it.
- **The decision model** runs on the desktop. History goes to an external model provider only through an adapter the user chose, under its own consent (#16027).

Question content comes only from what an agent puts in a question; Decisions never reads a terminal to send it. Answers, signed events, delivery acknowledgements and routing metadata cross the network as listed above, and decision history reaches a model provider only under its own consent. No Daintree-operated server is involved at any point.

## The renderer

- **Settings → Integrations → Decisions** (#16004), a global tab on every platform and in settings search, modelled on the `mcp` entry in `settingsTabRegistry.tsx`. It isn't inside Hosts, where Answer from another device lives, because Decisions isn't a Remote Hosts feature. One enable switch; turning it on the first time shows the consent above; behind it, Connection, Devices, Questions, Policy, Voice (an explanation only), Decision model and Data, each its own component so each child adds to its own section.
- **`terminal:decision-state`** (#16016), a per-pane push modelled on `terminal:notify-state` and registered everywhere a push event must be, with `host` locality. It carries open questions (alias, asked at, expiry), answers waiting for delivery and answers needing attention with a reason code, and no question or answer text. The renderer can also read a pane's current state on mount. Nothing is emitted or subscribed while Decisions is off.
- **The pane chip** (#16018) beside `TerminalNotifyChip`, saying what was observed: "Question q-42 is waiting for an answer", "Answer received, delivering when this terminal is idle", "Answer needs attention", with a count for several questions. Needs-attention surfaces in Canopy's needs-you tier (`CANOPY_NEEDS_YOU_PRIORITY`); routine states never raise toasts ([notification-system.md](./notification-system.md)). The chip, tab and list use the Decisions mark (#16028).

## Setup, data and the decision model

- **Deploy** (#16023). Settings offers both routes to a relay: the Deploy to Cloudflare button, opened in the browser, or the published `decisions deploy` run in a clearly labelled terminal pane the user watches. Daintree doesn't collect or store a Cloudflare token, and never updates a deployed Worker.
- **Full-loop check** (#16024). Setup is complete only when relay health, the claim, an encrypted attachment round trip, a socket connect, the push configuration and a test question to paired phones have all passed, with the test answer delivered into a labelled diagnostic pane that runs no agent, and the recovery kit is verified. It reruns later as a doctor.
- **Data** (#16025). Export writes the decision history archive to a file the user picks. Delete relay data removes the relay's stored content after a typed confirmation that says what stays (the Worker, and anything already on paired devices). Delete local data removes this machine's store and keys and leaves the relay untouched.
- **Decision model** (#16026, #16027). Off by default, with its own consent and an evaluation report shown before the proxy may answer anything. It answers only questions whose level and gate allow it, never `human-required`, design-review gates or anything on its hard-block list, and its answers are labelled `source: proxy` in the typed block, the audit trail and on the phone.

## Where this differs from the integration spec

The integration spec was checked against an older clone. Where it and this doc disagree, this doc reflects the code and the programme's decisions:

- **Package scope.** `@daintreehq/decisions-*`, not `@daintree/decisions-*` (daintreehq/decisions#13).
- **Scope of the setting.** No per-project enablement or per-project opt-in, and no Host-scoped settings: one global switch, and Hosts get an identity (#15996).
- **Unsupported agents.** No manual `decisions mcp` setup line in Settings (#15996).
- **Request order.** Repeated security headers are rejected before the Host and Origin checks. `setPluginRouteHandler` is a method of `HttpLifecycle`, called from `McpServerService.ts`; `revokePaneBearer` is on `McpServerService`.
- **Session binding.** Core sessions bind with `bindSessionCredential`; the plugin route has its own credential index rather than calling it.
- **Bearers.** Tier off mints no bearer today, and every pane token passes `isAuthorized`; the Decisions-only bearer is new (#16012), injected for every supported launch rather than "panes whose project has Decisions enabled".
- **The wake gate.** `decision` is the sixth `LaneWake` kind, not the fifth, and reusing `"settled-prompt"` unchanged would type into a working Claude or Codex pane; #16015 adds the stricter gate.
- **Workspace binding and generations.** `PaneWorkspaceBinding` holds no worktree root, and spawn generations come from a per-process ledger, so neither is a durable identity on its own.
- **Local plaintext.** The spec says question text isn't stored in plaintext beyond the decision model's history. The pinned release goes further: it seals question content and each answer entry before handing a row to the store, so the local store holds no question or answer text in clear (#16002).
- **The typed block.** The spec's sample block has no injection marker, though its crash reconciliation searches scrollback for one.
- **Store and migration names.** `settingOwnership.ts` is `shared/config/settingOwnership.ts`. `0020_decisions.sql` and `043-decisions-settings.ts` were the next free numbers when the spec was written, not reserved names: the store's tables landed as `0022_decisions_store.sql`, and the settings migration exists only if one is needed.
- **Timeouts.** `MCP_CONFIRMABLE_CALL_MAX_MS` is the confirmable-call deadline (640 s), not plain dispatch (30 s). Neither matters, since `ask_human` returns at once.
- **Remote Hosts.** `ClientEndpoint.request` is the Host-to-renderer reverse request; enrollment is a session CALL. The spec has the Shell initiate enrollment without saying when; here the owner enrolls each connected Host automatically unless the user turned that off (#16021).
- **Import budget.** `scripts/check-import-budget.mjs` is a local check, not a CI gate.
- **Open items in the spec's §14.** The route is its own (#16011), not a core action. Each Host enrolls as its own device (#16021) rather than forwarding through the owner. The curation decision is recorded in [feature-curation.md](../feature-curation.md#decision-log) (#15997). The libraries publish under the `@daintreehq` npm scope. No agent gains launch-time MCP in this programme. Push through the user's own relay answers the push question #14023 left open: Daintree operates no relay.

## Verification

Each child ships CI-safe tests with no real relay. Together they cover: the route refusing missing, API-key, help, plugin and foreign tokens, DNS-rebinding and bad-Origin requests; a question defaulting to `human-required` and an agent unable to downgrade it; the origin persisted before network I/O; the wake deduping, rechecking generation and principal, reserving before typing, and never typing into a busy, typing or approval-blocked pane; ordering and spacing; restart re-arming undelivered answers; crash reconciliation by marker or `delivery-uncertain` without re-typing; the resume adapter's success, missing session, deleted worktree and timeout; Host enrollment over a fake link; 4401 stopping delivery; and the off state proving no import, listener, timer or socket.

Some guarantees can only be proven with a real phone and real CLIs, against a real relay (#16030): delivery to the correct terminal across an app restart, a lost connection and a busy pane; several questions in one pane arriving in order; proxy flows with the design-review gate refusing a proxy; attachments and a design-review approval bound to the reviewed screenshots; WSL and ssh Hosts answering for their own panes; Claude Code and Codex resume against the installed versions; answers surviving a 48-hour desktop outage; no measurable overhead when off; and a revoked phone seeing no new questions.
