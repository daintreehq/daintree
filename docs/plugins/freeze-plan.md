# Plugin System 1.0 Freeze Plan

> **Status: planning. This is the big-picture reference for the work that takes the plugin system to a frozen 1.0 API.** It combines an external best-practice review (how VS Code, Obsidian, Zed, Raycast, Figma, and WebExtensions handle plugin APIs, security, versioning, and distribution) with a code-level freeze audit of our own plugin system (11 subsystems read in parallel, 16 high-severity findings adversarially verified against the source). Individual freeze issues should link back here for context and rationale. Author-facing reference docs live alongside this file; see the [plugins README](./README.md).

## Why this document exists

The app itself is 1.0-ready. The plugin API is not — and the schema says so out loud: two of the highest-value contribution points are literally named `experimental_views` and `experimental_mcpServers`, and the code is dotted with "Reserved for F29," "not yet wired," "will be ignored." "Experimental" and "frozen" are mutually exclusive. Freezing the plugin contract as-is would lock us into half-built promises and a trust model we can't change without breaking every installed plugin.

The plugin API is the one surface where breaking changes cost us third-party developers' trust permanently. So the question driving this plan is not "is the code good" (it is — channel isolation is strong, MCP consent is real, the install flow is atomic). The question is: **what would we regret being unable to change after 1.0?** Everything below is organized around that.

## The strategic position: decouple "ship 1.0" from "freeze the plugin API"

We do not have to couple the product's 1.0 to a full plugin-API freeze. Two viable shapes, both standard practice:

- **Preview channel (recommended).** Ship the product 1.0 now, declare the plugin API **`0.x` / preview**, versioned independently from the app. This is the VS Code "proposed API" model: stable on everything users touch, explicitly-unfrozen on the one surface that isn't ready. Plugins built against preview APIs are allowed but flagged, and the API graduates to stable per-contribution-point as each is finished and proven.
- **Frozen subset.** Freeze only the contribution points that have a sample, a test, **and** working runtime wiring — `toolbarButtons`, `menuItems` (if kept — see below), `commands`, `keybindings`, `contextMenus`, `settings`, `fileDecorationProviders`, `forgeProviders` — and keep everything `experimental_`/reserved explicitly out of the frozen set. Our existing `plugin-sdk.ts` allowlist boundary is the right mechanism to draw that line.

Either way, the prerequisite work is the same: settle the root decisions below, then finish-or-cut every half-wired field.

## Root decisions that gate everything

These are product/architecture calls a human must make **first** — most freeze work is blocked on them, and getting them wrong is the expensive kind of wrong. They are tracked as decision issues; nothing downstream should start until each is resolved.

| # | Decision | Why it gates the rest |
| --- | --- | --- |
| D1 | **Trust model: curated/signed ecosystem vs open unsigned sideload.** | Root of the whole tree. Determines whether we need signing + publisher identity, an install-time consent gate, and how hard `scopes` must be enforced. |
| D2 | **UI isolation model: do plugins run in a separate `WebContents` with isolated preloads, or share the single `app://daintree` origin?** | Decides whether DOM-level isolation exists, and whether the `PLUGIN_INVOKE` ownership fix needs a `WebContents→pluginId` registry or a preload-bound `pluginId`. |
| D3 | **Sandbox/execution path.** Production plugins currently `import()` in-process in main with full Node access. | The research is unambiguous: `utilityProcess` is the **only** isolation option that keeps the npm/Node ecosystem intact (WASM/Extism forces synchronous, no-event-loop rewrites; ShadowRealm breaks on object-by-reference; QuickJS needs virtualized `node:fs`). The async-RPC boundary this introduces **changes the shape of the host API** — so it must be decided before the host API is frozen. We already run _dev_ plugins via `utilityProcess.fork`, so we are partway there. |
| D4 | **`scopes` enforcement: implement runtime fs/network enforcement (IPC-proxied) vs freeze `scopes` as advisory-only with explicit, consistent docs.** | Decides whether `allowedPaths`/`allowedUrls` stay, get renamed, or are removed from the frozen manifest. |
| D5 | **Install-time capability consent: ship a pre-install consent dialog vs document post-install-only disclosure as the deliberate 1.0 contract.** | Affects the manifest and install flow that we'd be freezing. |
| D6 | **Frozen contribution surface.** Keep-or-cut for `menuItems` (wired into the native app menu via `electron/menu.ts`, but the menu is not rebuilt on dynamic plugin load/unload), sidebar views (rejected at runtime), and the two `experimental_` points (de-prefix vs keep behind an unstable flag). | Defines what "1.0 plugin API" literally contains. |
| D7 | **1.0 SDK surface.** Which packages/subpaths ship: `@daintreehq/plugin-sdk` core, `/react` (real hooks vs reserved-empty), `@daintreehq/plugin-testing` mock host, and the `plugin.json`/`.dntr` format version guarantees. | You cannot freeze an API no external author can build against. |
| D8 | **`ForgeProvider` credentialFields: freeze single-field-only vs support multi-field credentials** (pass the full record to `validateToken`/`setCredentials`). | Shapes a frozen provider interface. |
| D9 | **OS keychain for `type: "secret"` settings vs accept plaintext JSON as documented permanent 1.0 behavior** (#9167). **Resolved — keychain default with honest plaintext fallback:** `secret` settings are now encrypted at rest through the OS keychain (`safeStorage`: macOS Keychain / Windows DPAPI / Linux libsecret-kwallet) when one is available, transparently to the `host.settings.get/set` API; where no keychain exists they fall back to plaintext and the settings UI says so. | Either way it must be disclosed, not implied. |
| D10 | **Plugin agent detection: cut the `detection` field for 1.0 (minimal tier) vs ship the full-tracking tier.** **Resolved — cut (#10460):** the `detection` field is removed from the 1.0 plugin schema; plugin agents launch as named, untracked terminals and the live PTY matcher stays built-in-only. | Determines whether a heavily-validated manifest field stays or goes. |

## What the audit found: cross-cutting failure classes

The 23 individual findings cluster into a handful of systemic patterns. These are the themes worth internalizing — most issues are an instance of one of them.

1. **Schema validates fields the runtime ignores (frozen-promise violations).** The single largest freeze-risk class. `scopes.network.allowedUrls` enforcement, `ForgeProviderContribution.capabilities`, and `ViewContribution.location:"sidebar"` are all validated at manifest-parse time but unconsulted or outright rejected at runtime. A plugin author writes a manifest, it passes validation, and nothing happens. Freezing these means freezing promises we don't keep. (Plugin agent `detection` was the canonical example; it has since been cut from the schema — #10460. `scopes.fs.allowedPaths` is now **runtime-enforced for the new host-mediated `host.fs`/`host.git` surface** — realpath containment, traversal/symlink-escape rejected — so it is no longer purely advisory for that path; the residual gap is the in-process `node:fs` escape, which is a D3 sandbox concern, not a field-vs-runtime divergence.)
2. **Stale/contradictory schema-vs-implementation docs.** The `ForgeProvider` "reserved" comment, `SettingDefinition` "Reserved for F29," and `manifest.md` presenting `allowedPaths`/`allowedUrls` as enforcement all diverge from the actual code (the features are either done or never wired — the comments say the opposite). For a frozen API the schema doc must be authoritative.
3. **Built infrastructure with no caller (dead pipelines).** The MCP consent service + audit + rug-pull detection + tier-cap are fully implemented but **never invoked** — there is no `tools/call` dispatcher wiring them in. `usePluginMenuItems` has no non-test consumer. `PluginActionAuditService` never receives error records. The plumbing exists; the last wire is missing.
4. **Trust model is disclosure-first with no runtime sandbox — and under-disclosed.** No install-time consent gate, no signing/publisher identity, `scopes` implied as enforcement, `secret` settings' storage tier (keychain vs plaintext fallback) under-disclosed. The honest model ("trusted plugins only, runs as you do") is defensible, but it is currently implied rather than stated, and stated inconsistently across docs and UI.
5. **Observability gaps frozen into the contract.** Action-handler and IPC-handler errors never reach the audit pipeline (#9232); regular plugin action/IPC dispatch has no audit trail (only MCP does); dev-worker crashes don't surface as `loadError`. Adding these after a freeze changes what counts as a record.
6. **Type/runtime contract divergence in `PluginHostApi`.** Revoke-guarded vs post-activation methods share identical TypeScript signatures; the real contract lives only in JSDoc/docs, not in the frozen type. **Partly addressed:** the revoke-guarded registration methods are now factored into a `PluginActivationApi` sub-interface that `PluginHostApi extends`, so the activation-window split is encoded in the exported type (with `@throws` JSDoc per method), and every new post-activation primitive (`postToPanel`, `getWorktreeStatus`, `process.*`, `fs.*`, `git.*`) is deliberately placed on the non-revoke-guarded surface rather than `PluginActivationApi`. The remaining gap is the all-Promise audit (theme via the external review) — some host methods are still synchronous.
7. **Contribution points validated but never exercised end-to-end.** `panels`, `keybindings`, `contextMenus`, and `agents` have no sample plugin **and** no E2E test. Third-party authors have no reference implementation and the runtime wiring is unproven before freeze.
8. **The external authorship story doesn't exist yet.** `@daintreehq/plugin-sdk`, `@daintreehq/plugin-vite`, and the `daintree-plugin` CLI are unpublished/private with no publish workflow. The `dev` hot-reload command itself is shipped (`packages/daintree-plugin/src/commands/dev.ts`); what's missing is the publication path, not the tooling.

## External grounding: best practice, and where we stand

Condensed from a two-round review of how mature plugin systems are built. (A few specific 2025–2026 "incident" names surfaced ungrounded and are treated as illustrative, not load-bearing; the principles are well-established.)

- **Async-everything, or regret it.** Sublime's synchronous Python API and Eclipse's main-thread blocking are the canonical regrets. Rule for 1.0: every `PluginHostApi` method returns a Promise, even where it's synchronous today. → Audit `PluginHostApi` for any sync method before freeze (relates to theme 6).
- **Don't leak internal types or dependencies.** Obsidian's CodeMirror 5→6 upgrade broke its ecosystem because raw editor instances were exposed. We do the right thing here — the `plugin-sdk.ts` allowlist deliberately excludes internal types. Watch item: `experimental_views` must hand plugins _our_ abstraction, not raw renderer internals.
- **Capability manifest + just-in-time consent is the standard we're missing.** Best practice is declare-in-manifest **plus** a runtime consent prompt at first use, cached in secure storage. We have the first half (self-declared capabilities) but no consent gate — and we already have the perfect model to generalize: the MCP TOFU consent + rug-pull fingerprinting, today scoped only to MCP (relates to D5, theme 4).
- **Trust/signing has moved to publisher-side.** The field is shifting from registry signing to **Sigstore/cosign keyless signing** (OIDC identity → short-lived cert → Rekor transparency log), verified client-side so a compromised marketplace can't forge packages — plus a Raycast-style review pipeline (manual review on initial publish **and** on any update that changes the permission manifest). We have an integrity hash but zero authenticity verification (relates to D1, D10-adjacent).
- **Lazy, event-driven activation.** VS Code and WebExtensions MV3 both moved to activate-on-event, terminate-when-idle. Our `activationEvents` currently only allows `onStartupFinished` — the opposite. Expanding to real activation events is far easier now than retrofitting semantics onto a frozen field.
- **Where we're already ahead.** The MCP design (stdio-only, HTTP rejected at the schema boundary, consent + fingerprint pinning) closely matches the 2025–26 recommendations. That subsystem's work is _de-experimentalizing and wiring the dispatcher_, not redesigning.

**The through-line:** the internal audit and the external review agree on the same headline — **the sandbox/trust model (D1–D3) is the architectural decision to settle before freezing**, because consent, signing, and the async API shape all hang off it. Everything else is finish-the-wiring-or-cut-it.

## Freeze roadmap

Every issue candidate triaged into three tiers. "Blocks freeze" issues must land (or be consciously deferred via a decision) before the plugin API can be called 1.0/stable.

### Must resolve before freeze

| # | Issue | Type | Severity | Scope |
| --- | --- | --- | --- | --- |
| 1 | ~~Resolve plugin agent detection: wire it or cut it from the 1.0 schema (D10)~~ **Resolved — cut (#10460)** | decision | high | large |
| 2 | Close `ViewContribution.location:"sidebar"` gap (validated by schema, rejected at runtime) | decision | high | medium |
| 3 | Resolve plugin `menuItems`: render it somewhere or remove the contribution point | decision | high | medium |
| 4 | Wire the MCP `tools/call` dispatch path through consent + audit + rate limiting | feature | critical | large |
| 5 | De-experimentalize MCP servers and views, or gate them behind an unstable flag (D6) | decision | medium | small |
| 6 | Emit audit records for plugin action and IPC handler failures (#9232) | bug | high | medium |
| 7 | Enforce `pluginId`↔sender ownership at the `PLUGIN_INVOKE` boundary | security | high | medium |
| 8 | Reconcile `scopes` (`fs.allowedPaths`, `network.allowedUrls`) with the no-enforcement reality across schema, docs, UI (D4) — **`fs.allowedPaths` now runtime-enforced for `host.fs`/`host.git`; `network.allowedUrls` still advisory** | decision | high | medium |
| 9 | Make the disclosure-first trust model explicit and consistent (no sandbox, install-time consent, plaintext secrets) (D1/D5) | decision | high | medium |
| 10 | Define plugin signing / publisher identity stance before freezing the manifest format (D1) | decision | high | medium |
| 11 | Consolidate `HIGH_RISK_CAPABILITIES` and `CONFIRM_TRIGGERING_CAPABILITIES` into one source of truth | refactor | high | small |
| 12 | Resolve `ForgeProviderContribution.credentialFields` single-vs-multi-field contract and slot validation (D8) | decision | high | medium |
| 13 | ~~Document the `PluginHostApi` activation-window contract in the frozen type, not just JSDoc~~ **Done — `PluginActivationApi` sub-interface encodes the revoke-guarded split; new post-activation primitives placed on the non-guarded surface** | docs | medium | small |
| 14 | Document the in-process module-cache limitation (no hot-reload for production plugins) | bug | medium | small |
| 17 | Add sample plugins + E2E coverage for panels, keybindings, contextMenus, and agents | test | high | large |
| 18 | Publish the plugin SDK, CLI, and Vite preset to npm with a release workflow (D7) | feature | high | large |

### Should resolve before freeze

| # | Issue | Type | Severity | Scope |
| --- | --- | --- | --- | --- |
| 15 | Validate plugin view `componentPath` scheme at registration time | security | low | small |
| 16 | Fix stale schema/type comments to match implementation | docs | low | small |
| 19 | Resolve the `daintree-plugin dev` hot-reload command and dev-worker provider gaps | feature | medium | large |
| 20 | Add audit trail for plugin action/IPC dispatch and surface audit logs in Settings | feature | medium | medium |

### Can be post-1.0

| # | Issue | Type | Severity | Scope |
| --- | --- | --- | --- | --- |
| 21 | Harden plugin unload: settings-subscriber cleanup, dev-worker crash provenance, manifest immutability invariant | refactor | low | medium |
| 22 | Tighten file-decoration and manifest array-bound defenses | refactor | low | small |
| 23 | Add full-workflow E2E and broaden host-API edge-case test coverage | test | low | medium |

## Contribution-point freeze decisions

The per-point disposition the freeze hinges on (resolved by D6). "Wired" means validated **and** consumed at runtime with proven behavior.

| Contribution point | Runtime status | 1.0 disposition |
| --- | --- | --- |
| `commands` | Wired | Freeze |
| `toolbarButtons` | Wired, sample + E2E | Freeze |
| `keybindings` | Wired, no sample/E2E | Freeze after #17 |
| `contextMenus` | Wired, no sample/E2E | Freeze after #17 |
| `panels` | Wired, no sample/E2E | Freeze after #17 |
| `settings` | Wired (F29 enforcement is live; comment stale). `path`/`directory`/`file` field types + native chooser added; `secret` now keychain-backed (D9) | Freeze after #16 |
| `fileDecorationProviders` | Wired | Freeze |
| `forgeProviders` | Wired (comment falsely says "reserved") | Freeze after #12, #16 |
| `agents` | Launch wired; `detection` cut from schema (#10460) | Freeze |
| `menuItems` | Wired into the native app menu (`electron/menu.ts` `getPluginMenuItems`, locations `file`/`view`/`terminal`/`help`); **not rebuilt on dynamic load/unload** | Freeze or address rebuild gap (#3) |
| `views` | `panel` wired; `sidebar` rejected at validation | De-prefixed; `experimental_views` kept as deprecated alias (#10466) |
| `mcpServers` | Supervisor + consent + dispatcher wired | De-prefixed; `experimental_mcpServers` kept as deprecated alias (#10466) |

## Platform primitives added (additive cluster)

A cluster of **additive, frozen-safe** platform primitives landed to cover the standard plugin archetypes (panel app, settings-driven integration, file/git tool, process/task orchestrator) without touching any decision-gated surface (D1–D4) or the rule #4100 agent-config boundary. Every item below is purely additive to the existing API: new types on the non-revoke-guarded host surface, new optional manifest fields, new built-in actions — nothing existing changed shape, so the freeze posture is unaffected and these can graduate with the contribution points they extend.

What landed:

- **`host.postToPanel(channel, payload)`** — the post-activation push channel: stream live data from a plugin's `main` (timers, polls, subscriptions) into its panels over the same `plugin:{pluginId}:{channel}` transport as `broadcastToRenderer`, but callable for the plugin's whole lifetime. Paired with the real renderer SDK hooks.
- **Renderer SDK hooks `useHostChannel` / `usePluginEvent`** (`@daintreehq/plugin-sdk/react`) — the request/response (pull) and subscription (push) halves of the panel ↔ main channel, now real and exported (previously "Planned"). `useWorktree`/`useWorktrees`/`useSetting`/`useCommand` remain Planned (F15/F36).
- **`host.getWorktreeStatus(path)` + `PluginWorktreeSnapshot.status`** — a changed-file / git-status projection (`PluginWorktreeStatus`) sourced from the host's already-polled worktree changes (no new shell-out).
- **`path` / `directory` / `file` setting field types** + a native folder/file chooser (`mustExist`, `extensions`), so a settings-driven integration can capture a filesystem path.
- **`PanelViewProps.initialArgs` + `panel.openPluginPanel` + `file.openDiff` actions + mounted `file` context-menu surface** — a plugin panel can be spawned with an argument bag, a plugin can ask the app to open a file/diff, and the declarable `file` context-menu location is now mounted on the Review Hub's changed-file rows.
- **General file-tree decoration consumer** — decorations are no longer confined to the worktree diff/review surface; any path list can pull a declared decoration scope.
- **`secret`-setting OS-keychain tier** (D9) — `safeStorage`-backed encryption at rest with an honest plaintext fallback and a UI tier indicator, transparent to the `host.settings` API.
- **`host.process.spawn(command, opts)`** — a managed, supervised child-process surface (kill/restart/onExit/onCrash, per-plugin concurrency cap, lifecycle-tied teardown), gated on the declared `shell:exec` capability — the first runtime enforcement of a scope capability.
- **`host.fs` + `host.git`** — sanctioned, contained, audited filesystem and git surfaces. Every path argument is realpath-contained to `scopes.fs.allowedPaths` (traversal / symlink-escape rejected); reads/writes gate on the matching `fs:*` / `git:*` capability; `git.commit` enforces the #7880/D2 change-preview safeguard (no silent derived commit message, real staged diff returned). This makes `scopes.fs.allowedPaths` runtime-enforced for the host-mediated path.

**Deliberately NOT added — 4 decision-gated primitives deferred** (blocked on D1–D4 and the #4100 agent-config boundary; out of scope for an additive cluster):

1. **`host.fs` / `host.git` enforcement semantics beyond containment** — the current surface contains and audits the host-mediated path, but it does not seal a plugin's in-process `main` from calling raw `node:fs` / spawning git directly. True enforcement (a Node sandbox / IPC-proxied fs) is a **D3** (sandbox/execution path) and **D4** (`scopes` enforcement model) decision; the containment we shipped is the contained-path half, not the seal.
2. **Agent-control / agent-state host API** — driving, pausing, resuming, or reading the live state of the active AI agent session. This crosses the **#4100 agent-config boundary** (never mutate user-owned agent config or session behavior the user didn't opt into) and is a **D1** trust decision. The sanctioned path stays `host.dispatch` into existing actions plus passive observation.
3. **Plugin-MCP-into-driven-agent bridge** — wiring a plugin-contributed MCP server's tools into an agent that Daintree is itself driving (vs. only exposing them to a user-launched agent). This bridges plugin trust into agent execution and is gated on the same **D1/#4100** boundary as agent-control.
4. **Inbound webhook / host-side `fetch` server** — a host-managed HTTP listener (or outbound `host.fetch`) so a plugin can receive external callbacks or make host-mediated network calls under `scopes.network.allowedUrls`. This is gated on the **D4** network-enforcement decision (the network scope is still advisory) and the **D1** trust model; an inbound listener also widens the attack surface in a way that needs the trust-model call first.

These four stay out until their gating decisions (D1–D4) and the #4100 rule are settled; documenting them here keeps the additive cluster honest about where the line is.

## Audit provenance & confidence

- **Method.** 11 subsystems read in parallel by independent agents, each returning structured findings with `file:line` evidence; the 16 highest-severity claims were then handed to separate adversarial verifiers instructed to refute them against the actual code.
- **Confidence.** The verification pass **confirmed nearly every high-severity finding** (a few downgraded from critical→high on scope; none refuted). The schema-vs-runtime gaps and the security findings in particular are corroborated, not speculative.
- **Known coverage gap.** The **renderer-integration** subsystem agent failed to return structured output, so that area (plugin manager UI, `usePlugin*` hooks, the `experimental_views` rendering host, settings-form UI) is under-covered here and should be re-audited when its issues are scoped.

## How to use this document

- Each freeze issue should link back to the relevant section here and name the failure class (theme 1–8) it belongs to.
- Decision issues (D1–D10) are blockers: do not start dependent implementation issues until the decision is recorded.
- When a contribution point graduates to frozen/stable, update its row in the contribution-point table and the [contribution-points reference](./contribution-points.md).
- This plan is the rationale of record; the author-facing contract lives in [manifest.md](./manifest.md), [host-api.md](./host-api.md), [contribution-points.md](./contribution-points.md), and [trust-model.md](./trust-model.md). When they disagree, that disagreement is itself a freeze bug (theme 2).
