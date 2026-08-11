# Daintree Portal software specification

**Status:** Implementation-ready product and technical specification

**Version:** 1.0

**Date:** 10 August 2026

**Target:** Daintree 0.30.x, Electron 42, Chromium 148, xterm 6.1 beta

**Primary platforms:** Daintree host on macOS, Windows, and Linux; Portal client on iOS/iPadOS and Android **Product owner decision:** Daintree Portal is a thin, paired mobile window into a running Daintree desktop host. The host owns every repository, worktree, panel, PTY, agent process, credential, and durable session.

## 1. Executive summary

Daintree Portal lets a user pick up their phone or tablet, discover named Daintree hosts on the local network, connect to one deliberately paired host, navigate the same project hierarchy they know from desktop Daintree, inspect worktrees and their open agents, launch a new agent in a chosen worktree, observe its console, and send it prompts. A remotely launched agent is an ordinary persistent Daintree panel backed by the host's real PTY. When the user returns to the desktop, that exact panel and conversation are already there.

Portal is not remote desktop, repository synchronization, a mobile coding environment, or a second agent runtime. The mobile client performs no repository operations locally. It sends authenticated intents and renders explicitly projected host state.

The first release is local-network and private-VPN software. It does not expose the existing MCP server, bind a public unauthenticated listener, configure router port forwarding, or provide a Daintree-operated internet relay.

## 2. Product intent

### 2.1 Primary scenario

A user wakes with an idea and has only their phone in hand. They open Daintree Portal, choose the advertised host named “Mac Mini,” select a familiar Daintree project, open one of its worktrees, launch Claude or Codex with an optional opening prompt, watch the agent begin working, and continue the conversation. Later, at the Mac Mini or another desktop window connected to that host, they see and resume the same console.

### 2.2 Product promise

> Your Daintree agents remain on your computer, but they are reachable when you are not sitting in front of it.

### 2.3 Success definition

Portal succeeds when a previously paired user can move from app launch to sending a prompt to the correct existing or newly launched agent in under 20 seconds, can identify the host/project/worktree/agent target before sending, and finds the same panel intact on desktop afterward.

## 3. Naming and terminology

| Term | Meaning |
| --- | --- |
| Daintree host | A running desktop Daintree instance that owns projects, worktrees, panels, PTYs, agents, credentials, and persistence |
| Portal client | The paired mobile or tablet application |
| Host identity | The cryptographic identity and user-visible name of one Daintree host installation |
| Device identity | The cryptographic identity of one Portal installation |
| Remote session | One authenticated connection between one device and one host |
| Run | One persistent agent panel and its current PTY generation |
| Project projection | The sanitized project/worktree/panel data sent to Portal, never a serialized renderer store |
| Console subscription | A snapshot-plus-events observation stream for one run |
| Atomic prompt | One string submitted once to an agent through the host PTY's submission path |

The mobile product is user-facing **Daintree Portal**. The existing desktop feature currently called Portal must be renamed user-facing to **Web** before Portal public beta. New remote code uses `remote*`, `remoteGateway*`, or `portalRemote*` namespaces and must never reuse the existing `portalStore`, `PortalManager`, or `portal.*` action namespace. The legacy internal names may be migrated separately after the user-facing rename.

## 4. Goals

- Discover enabled Daintree hosts and their user-assigned names on the local network
- Pair a device deliberately and remember the authenticated host
- Reproduce the recognizable Daintree project selector using the host's project identity, icon, status, and frecency order
- List a selected project's worktrees without exposing absolute paths
- List persistent agent panels grouped under their owning worktree
- Open an existing agent and observe its current console
- Launch a supported agent in a selected worktree with an optional opening prompt
- Submit subsequent prompts atomically to an explicitly selected agent
- Make every remote-created panel visible and resumable in desktop Daintree
- Recover cleanly from mobile backgrounding, network interruption, host sleep, renderer eviction, and PTY-host restart
- Keep all remote authority explicit, revocable, rate-limited, audited, and disabled by default

## 5. Non-goals for version 1

- Editing repository files on the mobile device
- Running repositories, agents, shells, Git, Docker, or plugins on the mobile device
- Pixel streaming or remote control of the desktop window
- Reproducing the draggable desktop panel grid on a phone
- Raw terminal keystrokes, arbitrary shell control, terminal resize, mouse reporting, clipboard bridging, or fleet broadcast
- Creating, deleting, or renaming projects or worktrees
- Commit, push, merge, worktree delete, recipe execution, destructive actions, or general `ActionService` dispatch
- Rendering arbitrary plugin-contributed React interfaces
- A native structured Daintree Assistant conversation; the assistant-native-host runtime remains deferred
- Waking an arbitrary powered-off or sleeping host
- Direct public-internet exposure, router port forwarding, or a Daintree relay service
- Remote SSH workspace execution as proposed in GitHub issue #11158

## 6. User experience specification

### 6.1 First launch

1. Portal opens to **Find a Daintree host**.
2. The client asks for local-network permission at the moment discovery begins, with copy explaining that it finds the user's computers running Daintree.
3. Discovered hosts appear as rows containing host name, platform, availability, pairing state, and protocol compatibility.
4. A **Connect manually** action accepts a host name or IP and port for routed private networks where mDNS is unavailable.
5. Selecting an unpaired host starts pairing; selecting a paired host connects.

### 6.2 Pairing

1. Desktop Daintree must have Remote access enabled and a pairing window open.
2. The desktop displays a QR code and a short verification code for five minutes.
3. Portal scans the QR code, verifies the host certificate fingerprint, presents the same short code, and asks the user to confirm it on the desktop.
4. Desktop Daintree names the device, shows the concrete requested capabilities, and asks **Pair device?**.
5. Approval creates the durable device record and closes the one-time pairing secret immediately.
6. Rejection, timeout, host navigation away, or renderer loss fails closed and leaves no usable credential.

### 6.3 Host picker

The host picker lists paired hosts first, ordered by recent use. Each row shows the user-assigned host name, platform icon, state (`Available`, `Connecting`, `Sleeping or unavailable`, `Update required`), and last successful connection. An unpaired advertised host is visually distinct and never exposes project metadata.

### 6.4 Project selector

After connection, Portal opens a mobile adaptation of Daintree's project switcher. It uses the same project names, sanitized project icons, status vocabulary, and frecency order as desktop Daintree. It must feel recognizably Daintree rather than like a generic server file list.

The selector contains:

- Current and recently used projects in host-provided frecency order
- Project name and sanitized icon
- Project status: active, background, closed, or missing
- Aggregated agent attention: waiting, working, completed, or none
- Search by project name
- A clear stale indicator when the host cannot currently refresh project or agent state

Absolute paths, forge credentials, repository remotes, environment variables, issue counts, and unrelated project settings are not sent.

### 6.5 Project screen

Selecting a project opens a screen grouped by worktree. The header identifies the host and project. Each worktree group shows its display name, branch, whether it is the main worktree, and agent count. Missing or unavailable worktrees remain visible with a clear unavailable state if they contain persisted panels.

Each agent row shows:

- Agent name and icon
- User-pinned panel title or safely composed observed title
- State: starting, working, waiting, completed, exited, unavailable, or restored
- Waiting reason where known
- Age of the current state
- Whether the run was opened remotely
- A short recent-output preview when available

The screen has one primary **Launch agent** action. Empty worktrees show **Launch an agent** within the worktree only when there is no competing project-level primary action.

### 6.6 Launch agent flow

1. The user invokes **Launch agent** from the project or a worktree.
2. Portal asks for the target worktree if it was not implied.
3. Portal lists only agents currently launchable on that host, including plugin-contributed agents whose remote representation is supported.
4. The user may select an existing host-side preset, model override, panel name, and optional opening prompt. No environment-variable editor or raw launch flags are exposed in version 1.
5. The confirmation screen names the host, project, worktree, agent, preset/model, and whether an opening prompt will be sent.
6. The user selects **Launch agent**.
7. The host creates a normal persistent Daintree panel with `focusPolicy: "preserve"`, `spawnedBy: "remote"`, and a caller-supplied `requestedId`.
8. Portal navigates to the new run immediately and shows `Starting…` until the PTY and agent state become available.
9. If the CLI is unavailable, Portal shows the host diagnostic result and does not claim an agent was launched.

Launching an agent is part of the default Companion capability. It does not require confirmation on every use after pairing, because the launch screen itself is an explicit user gesture with an exact target. The host enforces configurable per-device and global concurrent-agent limits.

### 6.7 Agent console screen

The agent screen contains:

- Persistent host/project/worktree/agent identity in the navigation title or subtitle
- A read-only console occupying the main area
- Connection and freshness state that does not obscure existing content
- A prompt composer anchored below the console
- A **Send** action disabled until non-whitespace content exists and the run is eligible
- An optional **Stop response** action only after its separate semantics and authority are implemented; it is not required for version 1

The console initially receives a serialized snapshot and then ordered live output. It supports ANSI color, Unicode, emoji, wide characters, wrapping, cursor movement needed by supported agent CLIs, and selectable text. Raw input, alternate-screen interaction, mouse tracking, and terminal resize are disabled. If the chosen Flutter terminal cannot replay the exact Daintree snapshot corpus correctly, the production client embeds the exact pinned xterm.js version in a hardened local WebView for the console only; the rest of the app remains native Flutter.

### 6.8 Prompt submission

The composer submits the full draft as one atomic prompt. Interior newlines are preserved and one terminal submission is generated. The client clears the draft only after receiving a committed response from the host. If the connection is lost with the result unknown, the draft remains visible as **Checking whether this was sent…** until idempotency reconciliation resolves it.

The UI must never offer a blind **Retry** for an unknown mutation result. It queries the original request ID and either confirms the committed submission or allows a new send after the host proves it did not commit.

### 6.9 Desktop convergence

A remotely launched panel is created inside the selected project's ordinary panel store and persistence path. It is not a hidden remote-only terminal. If the selected project is not currently visible, the host materializes or revives its project view in the background without switching the foreground desktop project or stealing focus. When the desktop user later selects that project and worktree, the panel appears in its normal location with the same panel ID, PTY, scrollback, title, agent state, and captured agent session ID.

While a device is observing or prompting a panel, desktop Daintree may show a neutral T1 remote-presence indicator naming the device. It must not toast ordinary remote activity. The local desktop user can disable Remote access or disconnect the device immediately.

### 6.10 Offline and host-unavailable behavior

Portal retains the last rendered screen while reconnecting and labels it stale. It never turns a failed or partial read into an empty project, worktree, or agent list. If the host is unreachable, copy states that Daintree must be running and the computer awake. Cached content is read-only until a fresh authenticated session is established.

## 7. Functional requirements

### 7.1 Host lifecycle

- **HOST-001:** Remote access is disabled by default.
- **HOST-002:** Enabling Remote access starts the gateway only after host identity and secure storage are ready.
- **HOST-003:** Disabling Remote access closes discovery, listeners, active sessions, pending pairings, console subscriptions, and uncommitted requests.
- **HOST-004:** The listener binds only to explicitly selected local interfaces or loopback behind an explicitly configured private reverse proxy.
- **HOST-005:** The host exposes a user-editable display name defaulting to the operating-system computer name plus “Daintree”.
- **HOST-006:** A **Disconnect all devices** action closes all sessions without deleting pairings; **Revoke all devices** is a separately confirmed operation.
- **HOST-007:** Remote access can continue while the Daintree window is hidden, provided the Electron process remains running.
- **HOST-008:** Version 1 does not install or operate a separate daemon and cannot survive a full app quit.

### 7.2 Discovery

- **DISC-001:** The host advertises DNS-SD service type `_daintree-portal._tcp` while Remote access and LAN discovery are enabled.
- **DISC-002:** Advertisement fields are limited to host display name, stable public host ID, protocol minimum/maximum, app version, platform, port, and a short certificate-fingerprint prefix.
- **DISC-003:** Advertisement never includes project names, paths, user names, device names, pairing state, capabilities, tokens, or secrets.
- **DISC-004:** Discovery is convenience only; trust comes from certificate pinning and device authentication.
- **DISC-005:** Portal supports manual endpoint entry for private VPNs and routed networks.

### 7.3 Projects and worktrees

- **PROJ-001:** The project list derives from `ProjectStore.getAllProjects()` and preserves the host's frecency order.
- **PROJ-002:** The remote project DTO contains only opaque ID, display name, sanitized icon payload or icon token, reconciled status, attention summary, and ordering metadata.
- **PROJ-003:** Selecting a closed/background project may start or revive its workspace host and background project view without changing the visible desktop project.
- **PROJ-004:** Worktrees derive from the selected project's readiness-gated `WorkspaceClient.getAllStatesForProjectAsync()` result.
- **PROJ-005:** A timeout or unknown workspace-host state is represented as unavailable, not as an authoritative empty list.
- **PROJ-006:** Worktree DTOs exclude absolute paths and include only opaque ID, name, branch, main/current flags, availability, and revision.

### 7.4 Agent inventory

- **AGENT-001:** The host combines `FleetSnapshotService` live runtime facts with a narrow persistent-panel projection from the selected project renderer.
- **AGENT-002:** The persistent projection includes only panels that represent user-visible agents and have `excludeFromPersistence !== true`.
- **AGENT-003:** Assistant-internal, diagnostic, ephemeral, trashed, hidden tooling, browser, dev-preview, review, and unsupported plugin panels are excluded.
- **AGENT-004:** Agent rows are bound to project ID, worktree ID, panel ID, PTY launch generation, and projection revision.
- **AGENT-005:** A stale panel ID or generation mismatch fails closed for output, launch correlation, and prompt submission.
- **AGENT-006:** The client can distinguish running, restored-without-live-PTY, exited, and resumable historical sessions.

### 7.5 Agent launch

- **LAUNCH-001:** The client fetches the host's live launchable-agent catalog before rendering choices.
- **LAUNCH-002:** The launch request requires explicit project ID, worktree ID, agent ID, requested panel ID, and idempotency key.
- **LAUNCH-003:** Optional launch fields are opening prompt, preset ID, model ID, and user-visible panel name.
- **LAUNCH-004:** The host resolves project and worktree ownership again immediately before dispatch.
- **LAUNCH-005:** The host dispatches through the target project's renderer using the existing `agent.launch` pipeline with `focusPolicy: "preserve"`, `spawnedBy: "remote"`, `excludeFromPersistence: false`, and the requested ID.
- **LAUNCH-006:** The bridge must target a specific project view and generation; it never falls back to the active or most-recently-focused renderer.
- **LAUNCH-007:** If the view is evicted during launch, the request fails with a retriable binding error only if the host proves no panel was created; otherwise idempotency lookup returns the created panel.
- **LAUNCH-008:** A successful response includes panel ID, launch generation, project ID, worktree ID, agent ID, placement, and spawn status.
- **LAUNCH-009:** Launch rate and concurrency limits are enforced before dispatch and rechecked after asynchronous view preparation.

### 7.6 Console observation

- **CONSOLE-001:** Opening an agent creates one on-demand console subscription; background agent consoles are not streamed.
- **CONSOLE-002:** Subscription begins with `SerializedTerminalSnapshot` plus terminal dimensions, PTY generation, stream ID, and `throughSeq`.
- **CONSOLE-003:** Live output events carry monotonically increasing sequence numbers and byte counts.
- **CONSOLE-004:** The PTY host must provide an atomic snapshot/subscription barrier: the snapshot declares the final output sequence it contains, and every later event has a greater sequence. Portal must not infer this from timing around `setIpcDataMirror`.
- **CONSOLE-005:** Gaps trigger `resyncRequired`; the client requests a new snapshot and never silently stitches discontinuous output.
- **CONSOLE-006:** Each subscription has bounded unacknowledged bytes and a bounded queue. On overflow the host drops the stream, not accepted prompts, and requires resynchronization.
- **CONSOLE-007:** Console subscriptions end on screen exit, app background, session close, device revoke, panel exit/removal, PTY generation change, or host shutdown.
- **CONSOLE-008:** Output payloads are capped before allocation and decoding.

### 7.7 Prompt submission

- **PROMPT-001:** A prompt request requires explicit project ID, worktree ID, panel ID, launch generation, prompt text, and idempotency key.
- **PROMPT-002:** Prompt text must be non-empty after trimming, retain interior whitespace/newlines, and be capped at 64 KiB UTF-8 for version 1.
- **PROMPT-003:** Before calling `PtyClient.submit`, the host verifies device capability, current session, project/worktree/panel/generation ownership, persistent agent kind, live PTY, and non-trashed status.
- **PROMPT-004:** The host records the idempotency key and request digest before acknowledging commitment.
- **PROMPT-005:** Repeating a committed idempotency key with the same digest returns the original result; repeating it with a different digest is rejected as a conflict.
- **PROMPT-006:** A successful response means queued once to the PTY host, not read, executed, or completed by the agent.
- **PROMPT-007:** Audit records store device, target IDs, timestamp, outcome, character/byte length, and content digest; prompt content is not stored in the remote audit log.

### 7.8 Persistence and continuity

- **PERSIST-001:** Remote launches use normal panel persistence and must survive project-view eviction, window reload, and normal Daintree restart under the same rules as desktop launches.
- **PERSIST-002:** Portal does not maintain a second conversation database or authoritative local transcript.
- **PERSIST-003:** While the PTY is live, the host process and PTY are the conversation source of truth.
- **PERSIST-004:** Terminal restore snapshots, panel metadata, captured `agentSessionId`, and the agent-session journal remain the host recovery mechanisms.
- **PERSIST-005:** Portal surfaces agent-specific resume support honestly; it never promises universal conversation recovery.
- **PERSIST-006:** Cached mobile state is convenience only and is discarded or replaced on a protocol revision conflict.

## 8. Host architecture

### 8.1 Service topology

```text
Portal mobile client
        │ WSS, pinned host certificate, authenticated device session
        ▼
RemoteGatewayService (global Main service)
  ├─ RemoteListener
  ├─ RemoteDiscoveryService
  ├─ RemoteIdentityService
  ├─ RemotePairingService
  ├─ RemoteSessionRegistry
  ├─ RemoteCapabilityService
  ├─ RemoteProtocolRouter
  ├─ RemoteIdempotencyStore
  ├─ RemoteAuditService
  ├─ RemoteProjectProjectionService
  ├─ RemoteProjectViewBroker
  ├─ RemoteTerminalBroker
  └─ RemoteAgentBroker
        │
        ├─ ProjectStore / WorkspaceClient / FleetSnapshotService
        ├─ WindowRegistry / ProjectViewManager / renderer bridge
        ├─ ActionService agent.launch
        └─ PtyClient snapshot / subscribe / submit
```

`RemoteGatewayService` is initialized as a global service after the shared database, secure storage, `ProjectStore`, `PtyClient`, `WorkspaceClient`, and window registry are available. It is stopped before PTY and workspace teardown so sessions cannot submit into a draining host.

### 8.2 Main-owned versus renderer-owned state

Main directly owns host identity, projects, worktree host access, PTY runtime state, agent fleet state, transport, sessions, audit, and policy. Renderer project views continue to own panel layout, persistent panel metadata, launch UX logic, presets, and `ActionService` dispatch. Portal receives a narrow semantic projection assembled by Main; it never requests arbitrary store names or serializes Zustand state.

### 8.3 Remote project-view broker

`RemoteProjectViewBroker` adds an explicit `ensureBackgroundView(projectId)` capability to the multi-window architecture. It selects one eligible local window context as the owner, creates or revives the target project's `WebContentsView` without making it visible, waits for hydration and remote-bridge registration, returns a binding `{ webContentsId, projectId, generation }`, and holds a short reference while a remote request is in flight.

The broker obeys these invariants:

- It never changes `ProjectStore.currentProjectId`, desktop focus, visible view, or project history solely because Portal selected a project.
- It never dispatches to a different active renderer when the requested binding disappears.
- It rechecks binding generation after every `await`.
- It participates in LRU accounting and may be denied under critical memory pressure.
- It releases the reference after the request or subscription no longer needs renderer-owned state.
- If no desktop window context can host a view, project browsing from Main remains available but renderer-dependent launch returns `HOST_UI_UNAVAILABLE` with recovery copy asking the user to open a Daintree window.

### 8.4 Renderer remote bridge

Each project renderer registers a typed remote bridge bound to project ID, `webContentsId`, and generation. Version 1 methods are:

- `remote:getPanelProjection`
- `remote:getLaunchableAgents`
- `remote:launchAgent`

The bridge does not expose generic `dispatch(actionId, args)`. `remote:launchAgent` internally dispatches `agent.launch` after validating the exact remote schema and stamps host-controlled provenance/focus/persistence fields so the client cannot override them.

### 8.5 Proposed code locations

```text
shared/types/remote/
  protocol.ts
  discovery.ts
  identity.ts
  projects.ts
  agents.ts
  console.ts
  errors.ts

electron/services/remote/
  RemoteGatewayService.ts
  RemoteListener.ts
  RemoteDiscoveryService.ts
  RemoteIdentityService.ts
  RemotePairingService.ts
  RemoteSessionRegistry.ts
  RemoteProtocolRouter.ts
  RemoteIdempotencyStore.ts
  RemoteAuditService.ts
  RemoteProjectProjectionService.ts
  RemoteProjectViewBroker.ts
  RemoteTerminalBroker.ts
  RemoteAgentBroker.ts

electron/ipc/handlers/
  remote.ts
  remote.preload.ts

src/hooks/
  useRemoteProjectionBridge.ts

src/components/Settings/
  RemoteAccessSettingsTab.tsx

src/components/Remote/
  RemotePresenceIndicator.tsx
  RemotePairingDialog.tsx
  RemoteDeviceList.tsx
```

New IPC follows the generated `defineIpcNamespace` pattern and is included in the IPC code-generation checks. Direct `window.electron.*` calls that change remote security settings are routed through explicit settings UI and audited.

## 9. Wire protocol

### 9.1 Transport

Version 1 uses TLS 1.3 WebSocket (`wss://`) over a selected LAN or private-VPN interface. `ws` is already present in Daintree, but the remote listener is a separate lifecycle from the loopback MCP HTTP server. WebSocket compression is disabled by default. The protocol implements its own bounded queues and acknowledgements.

### 9.2 Envelope

```ts
interface RemoteEnvelope<T = unknown> {
  protocolVersion: 1;
  sessionId: string;
  kind: "request" | "response" | "event" | "ack";
  type: string;
  requestId?: string;
  streamId?: string;
  seq?: number;
  ack?: number;
  revision?: number;
  payload?: T;
}
```

Every decoded envelope and payload is validated with a strict Zod schema. Unknown fields on security-sensitive commands are rejected. Frames larger than the configured maximum are closed before JSON parsing. Binary frames may be introduced later for terminal output without changing semantic message types.

### 9.3 Connection handshake

1. TLS validates the pinned host certificate fingerprint.
2. Client sends `session.hello` with supported protocol range, app version, device ID, random challenge, and signature.
3. Host verifies the paired device key, revocation state, protocol range, and rate limit.
4. Host responds with its signed challenge, chosen protocol version, session ID, capabilities, app version, and resume acceptance.
5. Client verifies the host signature already bound during pairing.
6. Both sides exchange `session.ready`; product data is rejected before ready.

### 9.4 Core messages

| Message | Direction | Purpose |
| --- | --- | --- |
| `hosts.pair.begin` | Client → host | Redeem one-time pairing bootstrap |
| `hosts.pair.verify` | Client ↔ host | Bind device key and human verification |
| `projects.list` | Client → host | Read sanitized project selector snapshot |
| `projects.updated` | Host → client | Project/attention revision changed |
| `project.open` | Client → host | Prepare selected project's worktree/panel projection |
| `project.snapshot` | Host → client | Worktrees and grouped persistent agents |
| `project.updated` | Host → client | Snapshot invalidated or delta available |
| `agents.launchable` | Client → host | Read supported launch catalog for target project/worktree |
| `agent.launch` | Client → host | Launch one persistent agent panel |
| `agent.launchResult` | Host → client | Correlate requested and actual run |
| `console.subscribe` | Client → host | Open snapshot/event stream for one run |
| `console.snapshot` | Host → client | Initial state through a declared sequence |
| `console.output` | Host → client | Ordered live output bytes |
| `console.resyncRequired` | Host → client | Gap or generation change invalidated stream |
| `console.unsubscribe` | Client → host | Release stream |
| `prompt.submit` | Client → host | Submit one atomic prompt |
| `prompt.result` | Host → client | Committed/rejected/unknown reconciliation result |
| `request.status` | Client → host | Reconcile an idempotent mutation after reconnect |
| `session.ping` / `session.pong` | Both | Detect half-open connections |
| `session.revoked` | Host → client | Device or session authority ended |

### 9.5 Snapshot and revision rules

- Project lists and project snapshots carry monotonically increasing revisions scoped to the host session.
- A client applies a delta only to the exact base revision it names.
- Revision mismatch requests a complete snapshot.
- Console sequence is scoped to terminal ID plus launch generation plus stream ID.
- Session resume never implies console-stream resume; uncertain console streams receive a fresh snapshot.
- Mutations use idempotency keys independent of WebSocket request IDs.

## 10. Representative DTOs

```ts
interface RemoteProjectSummary {
  id: string;
  name: string;
  icon?: { kind: "emoji" | "sanitized-svg"; value: string };
  status: "active" | "background" | "closed" | "missing";
  attention: { waiting: number; working: number; completed: number };
  order: number;
}

interface RemoteWorktreeSummary {
  id: string;
  name: string;
  branch?: string;
  isMain: boolean;
  isCurrent: boolean;
  availability: "available" | "loading" | "missing" | "unknown";
}

interface RemoteAgentRun {
  panelId: string;
  launchGeneration: number;
  projectId: string;
  worktreeId: string;
  agentId: string;
  displayName: string;
  title: string;
  state: "starting" | "working" | "waiting" | "completed" | "exited" | "restored" | "unavailable";
  waitingReason?: string;
  stateSince?: number;
  spawnedAt?: number;
  spawnedRemotely: boolean;
  resumable: boolean;
}

interface RemoteProjectSnapshot {
  project: RemoteProjectSummary;
  worktrees: RemoteWorktreeSummary[];
  agents: RemoteAgentRun[];
  revision: number;
  degraded: boolean;
  lastSuccessfulAt: number | null;
}

interface RemoteLaunchAgentRequest {
  projectId: string;
  worktreeId: string;
  agentId: string;
  requestedPanelId: string;
  idempotencyKey: string;
  prompt?: string;
  presetId?: string | null;
  modelId?: string;
  name?: string;
}

interface RemoteSubmitPromptRequest {
  projectId: string;
  worktreeId: string;
  panelId: string;
  launchGeneration: number;
  idempotencyKey: string;
  text: string;
}
```

No remote DTO contains `cwd`, project path, worktree path, environment, command, launch flags, raw settings, bearer token, stored secret, repository remote, hidden panel data, clipboard data, or diagnostics.

## 11. Security model

### 11.1 Trust classification

Portal is remote code-affecting authority. Launching an agent consumes host resources and grants the agent its normal repository permissions. Sending a prompt can cause file changes, commands, network access, commits, or other actions according to the agent's own permissions. A paired phone is therefore a privileged device, not a harmless notification client.

### 11.2 Host identity and TLS

On first enable, Daintree generates a long-lived host signing key and a TLS certificate. Private material is encrypted with Electron `safeStorage` where available; if secure encryption is unavailable, Remote access cannot be enabled silently and the settings UI must explain the degraded storage tier before explicit opt-in. The pairing QR contains the full TLS certificate fingerprint, host public identity, endpoint hints, protocol range, and a high-entropy one-time secret. Paired clients pin the host identity and reject certificate substitution.

### 11.3 Device identity

Portal generates a non-exportable device key where the platform supports Keychain/Keystore-backed keys. The host stores only the public key, display name, platform, creation time, last-seen time, capabilities, and revocation metadata. A device authenticates every new session with challenge-response; no long-lived bearer appears in a URL.

### 11.4 Capabilities

Version 1 has these capabilities:

| Capability | Authority | Default Companion profile |
| --- | --- | --- |
| Observe projects | Read sanitized projects, worktrees, agent state, and console output | On |
| Launch agents | Create normal persistent agent panels in explicitly selected worktrees | On |
| Prompt agents | Submit atomic prompts to explicitly selected live agent panels | On |
| View session history | See resumable-session metadata without transcript text | Off |
| Administer host | Change listener, pairing, devices, or security settings | Never remotely granted |

Raw terminal control, workspace mutations, shared-state mutations, and host administration do not exist in the version 1 remote protocol. Unknown capabilities and message types are denied.

### 11.5 Pairing and revocation

- Pairing windows expire after five minutes and allow a bounded number of attempts.
- One-time secrets are held in memory, never logged or advertised, and destroyed after success, rejection, timeout, or host shutdown.
- Verification codes are comparison values derived from the authenticated exchange, not credentials.
- Revocation closes every live session for the device before the durable record is marked revoked.
- Session command handlers re-read revocation and capability state; authorization is not upgrade-time only.
- Pairing, capability changes, and revocation are local desktop operations in version 1.

### 11.6 Limits

- Maximum concurrent devices: 5 by default
- Maximum sessions per device: 2
- Maximum active console subscriptions per session: 2
- Maximum prompt size: 64 KiB UTF-8
- Maximum ordinary JSON frame: 256 KiB
- Maximum console snapshot: existing serialized-state limit, additionally capped for remote transfer at 5 MiB
- Maximum unacknowledged console bytes: 1 MiB per stream
- Maximum launch attempts: 10 per minute per device and subject to host concurrent-agent policy
- Authentication and protocol violations use exponential temporary bans keyed by device and source address; address alone is never identity

### 11.7 Audit

Audit connection start/end, pairing attempts and outcomes, capability changes, revocation, project selection, launch request/result, prompt submission result, console subscription start/end, authorization failure, rate limit, malformed frame, protocol mismatch, and resync. Audit records never store prompt content, terminal output, pairing secrets, private keys, bearer tokens, absolute paths, environment values, or clipboard content.

## 12. Persistence model

### 12.1 Host settings

Remote settings are app-global and persist:

- Enabled state
- Host display name
- Discovery enabled state
- Interface policy and configured port
- Paired-device public records and capabilities
- Revocations
- Audit retention preference

Host private keys and sensitive pairing material use the secure-storage abstraction. Structured device records, idempotency records, and audit entries use SQLite with explicit schema migrations and bounded retention.

### 12.2 Idempotency retention

Committed launch and prompt idempotency records persist for 24 hours or 10,000 records, whichever bound is reached first. Each record stores device ID, operation type, idempotency key, canonical argument digest, outcome, created resource ID when applicable, and commit timestamp. Content is not retained beyond its digest and size.

### 12.3 Conversation continuity

Portal never claims that Daintree stores every transcript in one database. Continuity uses the actual layered model:

1. While live, the host PTY and external agent process are authoritative.
2. Daintree persists the ordinary panel and terminal snapshot under existing rules.
3. Daintree captures supported agents' session IDs and journals closed resumable sessions.
4. Each agent CLI owns its actual conversation store and resume semantics.

The Portal UI distinguishes **Live**, **Restored console**, **Resumable session**, and **Unavailable**. It does not equate restored scrollback with a live or resumable agent process.

## 13. Desktop host UI

Add **Settings → Integrations → Remote access** with chrome rendered immediately from safe defaults and asynchronously populated state. It includes:

- Remote access enable toggle
- Host name field
- LAN discovery toggle
- Selected network interface policy
- Current endpoint and protocol version
- **Pair a device** action and pairing QR/dialog
- Paired devices list with platform, capabilities, last seen, active state, **Disconnect**, and **Revoke device**
- Active sessions summary
- Audit summary and **View remote activity**
- **Disconnect all devices**
- Private-VPN/manual connection guidance

The global command palette and native menu expose **Manage remote access…**. A quiet toolbar/status indicator appears only while Remote access is enabled or a client is connected. An active remote observer or prompt sender uses neutral T1 presence, not accent color and not a toast. Security failures requiring recovery use the existing runtime-signal and notification routing rules.

## 14. Mobile client architecture

The production client is Flutter for iOS/iPadOS and Android, with platform secure storage, camera/QR support, DNS-SD wrappers, WebSocket transport, adaptive navigation, and accessibility. Protocol models are generated from or checked against the shared versioned schema to prevent hand-maintained drift.

Recommended modules:

```text
lib/
  identity/
  discovery/
  pairing/
  transport/
  protocol/
  hosts/
  projects/
  worktrees/
  agents/
  console/
  settings/
```

The client store is normalized by host, project, worktree, and run IDs. It never treats cached state as live. High-frequency console chunks are accumulated outside broad application state so they do not rebuild the whole widget tree.

### 14.1 Adaptive navigation

Phone:

```text
Hosts → Projects → Project/worktrees → Agent console
```

Tablet:

```text
Projects | Worktrees and agents | Agent console
```

The project selector and agent state vocabulary reuse Daintree concepts, icons, ordering, and semantic colors while respecting the mobile platform's navigation and accessibility conventions.

## 15. Error model

Stable protocol error codes include:

| Code | Meaning | Client recovery |
| --- | --- | --- |
| `AUTH_REQUIRED` | Session is not authenticated | Reconnect or re-pair |
| `DEVICE_REVOKED` | Host revoked this device | Remove credentials and return to hosts |
| `CAPABILITY_DENIED` | Device lacks required authority | Explain capability; no retry loop |
| `PROTOCOL_MISMATCH` | No compatible protocol version | Require app update |
| `HOST_UI_UNAVAILABLE` | No renderer can host a launch | Ask user to open a Daintree window |
| `PROJECT_NOT_FOUND` | Project ID is stale or removed | Refresh project list |
| `PROJECT_UNAVAILABLE` | Project/workspace host cannot load | Retry after host recovery |
| `WORKTREE_NOT_FOUND` | Worktree is stale, missing, or cross-project | Refresh project snapshot |
| `RUN_NOT_FOUND` | Panel no longer exists | Return to project snapshot |
| `RUN_GENERATION_CHANGED` | Panel ID now refers to another PTY generation | Refresh run and require explicit resend |
| `RUN_NOT_LIVE` | Restored/exited run cannot accept prompts | Offer supported resume path if available |
| `REQUEST_CONFLICT` | Idempotency key reused with different content | Generate a new request after user review |
| `REQUEST_STATUS_UNKNOWN` | Host cannot prove mutation outcome | Keep draft and require reconciliation |
| `RATE_LIMITED` | Device exceeded a bounded operation rate | Show retry-after time |
| `RESYNC_REQUIRED` | Stream sequence or revision is discontinuous | Fetch a fresh snapshot |

Errors use sentence-case titles and one actionable recovery. They never expose stack traces, filesystem paths, command lines, environment data, or raw IPC errors.

## 16. Performance requirements

- Previously paired host discovery appears within 2 seconds on a healthy LAN after permission is granted
- Authenticated reconnect reaches the project selector within 5 seconds p95
- Warm project snapshot renders within 1 second p95; cold background view preparation may take up to 5 seconds before an explicit loading state becomes a failure
- Prompt submission reaches the host PTY queue within 150 ms p95 on a healthy LAN
- New agent panel creation is acknowledged within 2 seconds p95 excluding the external CLI's own startup
- Console output presentation latency is under 250 ms p95 under ordinary agent output
- Gateway idle overhead is below 25 MiB RSS and 0.5% average CPU on the host
- One high-output terminal cannot grow an unbounded queue or delay authentication, prompt results, revocation, or heartbeats
- Project and agent snapshots suppress unchanged broadcasts

## 17. Accessibility and privacy requirements

- All mobile screens support dynamic type, screen readers, logical focus order, and minimum platform touch targets
- Agent state is communicated by text and semantics, never color alone
- Live console updates do not continuously steal screen-reader focus; users opt into announcements for waiting/completion transitions
- Host, project, worktree, and agent target are readable before every launch or prompt
- Local-network permission copy names the feature and purpose clearly
- Device names and last-seen metadata remain local to the host
- No analytics event contains prompt content, terminal output, project names, worktree names, or source paths

## 18. Testing strategy

### 18.1 Unit and contract tests

- Strict schema validation for every envelope and message
- Protocol version negotiation and mismatch handling
- DTO redaction proving paths, secrets, environment, hidden panels, and unrelated projects cannot serialize
- Project/worktree ownership and background-view generation pinning
- Launch and prompt idempotency, including same-key/same-digest and same-key/different-digest cases
- Capability, revocation, pairing timeout, delivery acknowledgement, and sender binding
- Console sequence, acknowledgement, queue cap, resync, and generation change
- Degraded fleet/workspace reads never becoming empty success

### 18.2 Integration tests

- Host discovery registration lifecycle
- Pairing over a real TLS listener with pinned certificate
- Project list from a seeded `ProjectStore`
- Project snapshot combining workspace-host, fleet, and renderer panel data
- Background project view creation without foreground switch or focus change
- Remote `agent.launch` creates one persistent panel with requested ID and remote provenance
- Remote prompt reaches `PtyClient.submit` once
- Desktop renderer later hydrates the same panel and PTY
- PTY-host restart invalidates console generation and recovers through snapshot
- Renderer eviction during projection and launch fails closed or reconciles committed work

### 18.3 Console corpus

Build a captured corpus from exact supported Claude, Codex, Gemini, and other agent sessions covering ANSI colors, Unicode, emoji, wide characters, wrapping, cursor movement, alternate-screen transitions, OSC titles/links, bracketed paste mode, progress spinners, markdown-like output, and large scrollback. Compare the mobile renderer to Daintree xterm screenshots and normalized buffer text. Flutter `xterm.dart` is accepted only if the corpus meets the agreed visual and buffer fidelity threshold; otherwise ship the pinned xterm.js WebView console.

### 18.4 Adversarial and fault tests

- Malicious LAN peer attempts pairing outside the window, replaying secrets, substituting a host, spoofing discovery, and flooding connections
- Revoke races with project read, launch, prompt, and console output
- Disconnect before mutation receipt, during host commit, and after commit but before response
- Fifty repeats at every mutation boundary yield zero duplicate panels and zero duplicate prompts
- Cross-project panel IDs, stale worktree IDs, stale renderer generations, stale PTY generations, and malicious requested panel IDs
- Oversized frames, deeply nested JSON, invalid UTF-8/binary payloads, rapid subscriptions, slow acknowledgements, and high-output terminals
- Mobile background/foreground, Wi-Fi handoff, host sleep/wake, host app hide/show, project-view eviction, PTY shard crash, workspace-host crash, and renderer crash

### 18.5 E2E acceptance scenarios

1. Discover “Mac Mini,” pair, select a project, open an existing agent, read its console, and send a prompt.
2. Select a background project and worktree, launch Codex with an opening idea, observe it start, return to desktop, select that project, and find the same panel and conversation.
3. Lose Wi-Fi after pressing Send, reconnect, and confirm the prompt was delivered exactly once.
4. Revoke the phone from desktop while it watches a console and verify that output and commands stop immediately.
5. Evict the selected project renderer under memory pressure and verify the fleet remains visible, then revive the view for launch without changing the visible desktop project.
6. Restart Daintree and verify a persistent remote-created panel restores under the same rules as a desktop-created panel, with resume state accurately represented.

## 19. Delivery plan

### Phase 0: Protocol and trust-boundary spike — 2–3 engineer-weeks

- Shared protocol and DTO schemas
- Main-owned project/fleet/worktree projection prototype
- TLS listener, host identity, manual endpoint, and one paired device
- Existing-agent console snapshot plus bounded live stream
- Atomic prompt submission with persisted idempotency
- Fault tests for reconnect, revoke, output flood, and cross-project IDs

**Gate:** One paired test client can inspect and prompt an existing agent with zero duplicate sends and zero sensitive-field leakage.

### Phase 1: Remote launch and desktop convergence — 3–5 engineer-weeks

- `RemoteProjectViewBroker`
- Typed renderer projection/launch bridge
- Remote provenance in `TerminalSpawnSource`
- Launchable-agent catalog and preset/model subset
- Persistent remote launch with requested panel ID and opening prompt
- Desktop convergence and normal restore behavior
- Multi-project/background-view adversarial tests

**Gate:** A phone-launched agent appears as the same persistent panel on desktop without foreground switching or focus theft.

### Phase 2: Mobile MVP and host management — 6–10 engineer-weeks

- Production Flutter phone/tablet client
- DNS-SD discovery and platform permission flows
- Host picker, pairing, project selector, project/worktree hierarchy, agent list, console, composer, and launch flow
- Desktop Remote access settings, device management, audit, and presence indicator
- Console renderer corpus decision and implementation
- iOS/iPadOS and Android accessibility, lifecycle, and network testing

**Gate:** All version 1 E2E acceptance scenarios pass on one iPhone, one iPad, and representative Android phone/tablet devices against macOS, Windows, and Linux hosts.

### Phase 3: Private-network polish — 3–5 engineer-weeks

- Multiple hosts and aliases
- Manual private-VPN endpoints and diagnostics
- Interface selection and firewall guidance
- Connection history, improved recovery, packaging, support diagnostics, privacy review, and external security assessment

Public rendezvous/relay, raw terminal control, richer remote actions, and a structured Assistant are separately specified future projects and are not scope-crept into these phases.

## 20. Migration and compatibility

- Add `"remote"` to `TerminalSpawnSource` and ensure all persistence, diagnostics, filtering, and UI switch statements handle it.
- Add remote schemas under `shared/types/remote/` without importing Electron or renderer types.
- Add database migrations for paired devices, idempotency, and remote audit; never overload MCP audit/session tables.
- Keep the existing MCP server loopback-only and unchanged in network exposure.
- Rename the existing user-facing Portal labels/actions/settings to Web before public beta, with action aliases if required for one release.
- Protocol compatibility is explicit through minimum/maximum negotiation; clients fail with update guidance rather than guessing.
- Host and client may differ in app version as long as they share a supported protocol version and required capability surface.

## 21. Definition of done

Daintree Portal version 1 is done only when:

- A user can discover and pair with a named Daintree host on a LAN
- The client reproduces the host's recognizable project selector ordering and identity without exposing paths
- Selecting a project shows authoritative or honestly degraded worktrees and persistent agents grouped correctly
- The user can launch a supported agent in an explicit worktree with an optional opening prompt
- The launch creates exactly one normal persistent Daintree panel and does not switch or steal focus on desktop
- The user can observe the console and submit subsequent prompts exactly once
- The same panel, PTY, output, state, and captured session identity are available on desktop
- Revocation is immediate and every remote command is capability-, session-, project-, worktree-, panel-, and generation-bound
- No remote payload or audit record leaks secrets, environment values, absolute paths, hidden panels, or unrelated project data
- Queue, frame, connection, launch, and prompt limits are enforced and tested
- The supported mobile/host matrix passes the acceptance scenarios
- Remote access remains disabled by default, the existing MCP server remains loopback-only, and no public-internet promise is implied

## 22. Future extensions

Future specifications may add raw terminal control leases, selected safe workspace actions, remote confirmation with transaction-bound previews, structured Daintree Assistant turns after the native host exists, opaque push notifications, Wake-on-LAN assistance, an Electron-to-Electron remote mode, and an end-to-end encrypted rendezvous/relay. Each extension must preserve the version 1 identity, ownership, idempotency, redaction, and local-precedence invariants and must receive its own threat model.

## 23. Final implementation directive

Build Daintree Portal as a secure remote surface over the Daintree host's existing project, worktree, panel, and PTY ownership. Do not build a mobile IDE, a second conversation store, a generic network-exposed action dispatcher, or a remote desktop. The core artifact is one host-owned agent panel that can be discovered, opened, observed, prompted, and later resumed from either mobile Portal or desktop Daintree without duplication or ambiguity.
