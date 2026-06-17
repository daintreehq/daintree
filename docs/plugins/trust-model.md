# Plugin trust model

This is the canonical decision record for what a plugin's declared `capabilities` mean. It settles a contradiction that had accumulated across the codebase: the docs claimed pure disclosure while the code already applied a small derived gate. The contract is now **hybrid** — disclosure-first, with load-bearing host-side policy effects. Everything downstream built on this record and has since shipped: the `capabilities` rename (`#9268`), the compound-capability lattice (`#9247`, `manifestTriggersCompoundElevation`), and MCP consent + the danger-tier cap (`#9234`, `electron/services/plugin-mcp/`).

## The contract in one line

> **Capabilities are disclosure-first with host-side policy effects.** The host does not sandbox plugin code — a plugin can call any Node API directly. The `capabilities` field is disclosed in the plugin manager, drives host-derived danger classification on plugin-registered actions, and caps the consent danger tier a plugin-hosted MCP server's tools can reach. It is not an enforcement boundary against malicious code; it is an honest, machine-readable description of what a plugin claims to need, used by the host to apply proportional friction at high-risk intent surfaces.

## The three options

Three contracts were on the table. Only one is honest about the constraint that defines our situation: there is no sandbox, and there cannot be one. Plugins share the host's React 19 + Node.js process. A plugin can `require("fs")` and `child_process.spawn` directly, and no custom-API gate intercepts that.

|  | (a) Disclosure-only | (b) Pure gated | (c) Hybrid (recommended) |
| --- | --- | --- | --- |
| Enforcement cost | None | Very high — checks on every host-API method, plus the impossible task of intercepting raw Node calls | Moderate — extend the existing `effectiveDanger` derivation, add the lattice, add the MCP tier cap (all now shipped) |
| Plugin-author cost | None | High — calls can fail mid-flow with `PermissionDenied` | Low — declare honestly; high-risk declarations show a confirm dialog (already true) |
| False-negative risk | **High** — compound attacks (read + network) declare nothing individually risky | Medium — gates work at the host-API surface but raw Node bypasses them, giving false confidence | Medium — same Node bypass, but the model never claims to prevent it; the lattice catches the compound classes |
| False-positive risk | None | High — risks training users to dismiss dialogs | Low — gates fire only on the six high-risk tokens + lattice; scopes attenuate further |
| Compound lattice | No derived effects to raise | A lattice would refuse calls, but the enforcement surface doesn't exist | The lattice raises `effectiveDanger`; URL scopes narrow sinks (shipped) |
| MCP coupling | MCP consent runs independent of the manifest — shadow privilege escalation | The manifest caps MCP at advertisement | The manifest caps the MCP consent danger tier; `mcp:elicitation` / `mcp:sampling` opt-in tokens still pending |
| Honest framing | Truthful (no sandbox) but invites attacks | Misleading — implies enforcement we can't deliver | Truthful: we disclose, we don't sandbox, but high-risk intent gets a confirm dialog |

## Recommendation

**Hybrid.** Three reasons.

**The code already does this.** `electron/services/PluginService.ts` raises a plugin action's `effectiveDanger` to `"confirm"` whenever the manifest holds one of six high-risk tokens. The docs claimed pure disclosure. The docs were wrong, not the code — this record reconciles them.

**Pure disclosure is the no-sandbox baseline, and it's the model that failed publicly.** VS Code, Cursor, Obsidian, and JetBrains all ship pure disclosure. That's the industry default, and it's exactly the class the malicious `ChatGPT - 中文版` / `ChatMoss` VS Code extensions exploited in January 2026 — over 1.5M combined installs, exfiltrating developer code using only the implicit filesystem + network access every editor extension already gets. They declared nothing individually risky because nothing gated the capabilities they abused. Pure disclosure has no surface to detect that compound class.

**Pure gated is security theatre without a sandbox.** Zed gates at the WebAssembly Component Model boundary; Tauri 2.x gates at the IPC bridge because that bridge is the only path from webview to host. Neither precedent transfers — we run shared V8 with Node, so a plugin bypasses any custom-API gate by calling Node directly. Claiming runtime enforcement we cannot deliver is worse than admitting we cannot.

Hybrid threads the needle: be honest that we don't sandbox Node, and still use declared capabilities as load-bearing host-side policy input.

## The three roles, by guarantee strength

The contract carries three roles, in descending order of how strong a guarantee each provides.

### 1. Disclosure (always)

Declared capabilities are shown in the plugin manager's detail pane as a humanised list — each token maps to a label + one-line description with a `neutral`/`warning`/`danger` severity (the `CAPABILITY_META` map in `src/components/Plugin/PluginDetailPane.tsx`, e.g. `network:fetch` → "Make network requests" with `warning`, `shell:exec` → "Run shell commands" with `danger`; rendered by `PluginCapabilityList` in that same file). This is the same reasoning Chrome extension permissions use — informational disclosure. It is always present and never an enforcement boundary.

### 2. Host-side policy input (load-bearing)

Declared capabilities feed five derived effects. Be precise about what is live today — the `effectiveDanger` raise, the compound-capability lattice, network scope attenuation, and the MCP tool danger-tier cap are all implemented. Only the `mcp:elicitation` / `mcp:sampling` client-capability advertisement tokens and the per-capability discriminated-union refactor remain unshipped.

- **`effectiveDanger` raise — _live today._** When a plugin's manifest holds any token in `CONFIRM_TRIGGERING_CAPABILITIES` (`shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:invoke`, `agent:register` — registering a launchable agent CLI is a runtime side effect on par with `agent:invoke` — and `agent:input` — injecting text into a live agent session drives the agent the same way, #10558), every action that plugin registers is raised to `effectiveDanger: "confirm"`, regardless of the `danger` the plugin self-declared. The host may only raise, never lower. **This affects Daintree's own action system** — it gates the renderer's confirm dialog, MRU-rail eligibility, and `repeatLast`. It does **not** block the plugin from executing code or calling IPC directly. It is host-side UX policy, not a sandbox. (`PluginService.ts` — `CONFIRM_TRIGGERING_CAPABILITIES`, `effectiveDanger` derivation.)
- **Compound-capability lattice — _live today._** Combinations that are individually benign but dangerous together — sensitive-read + unconstrained-sink, or `network:fetch` + local-write/shell sink — raise `effectiveDanger` even when no single token triggers. This is the surface that catches the compound benign-capability attack class. (`PluginService.ts` — `manifestTriggersCompoundElevation`.)
- **Scope attenuation — _network live today; fs enforced for the host API._** Scopes ship as a top-level `scopes` object on the manifest, not a per-capability discriminated union. `scopes.network.allowedUrls` is parsed and consulted: a non-empty URL allowlist on `network:fetch` attenuates lattice elevation because the sink can't be remote-controlled. `scopes.fs.allowedPaths` is now **enforced at runtime for the host-mediated `host.fs`/`host.git` surface**: every path argument is realpath-contained to a declared root (traversal/symlink-escape rejected, mirroring the `plugin://` handler), reads gate on `fs:*-read`/`git:read`, writes/mutations on `fs:*-write`/`git:write`, and writes/commits are audited. It still does not attenuate the lattice (fs writes already elevate flat). **Honest limit:** this gates the sanctioned host API only — a plugin's in-process `main` can still call raw `node:fs`, which the host cannot intercept until the sandbox decision (D3); `host.fs`/`host.git` give a contained, audited path, they do not seal the in-process one. `host.git.commit` additionally enforces the #7880 / D2 change-preview safeguard at the host layer: it refuses without an explicit non-empty message (no silent derived-message fallback) and computes the real staged diff as a preview before mutating. The schema rejects `*` / `**` and SSRF/credential-bearing URLs at parse time (`electron/schemas/plugin.ts`).
- **MCP tool danger-tier cap — _live today._** A plugin-hosted MCP server's per-tool consent danger tier is capped against the plugin's declared `manifest.capabilities`. The cap reads the same `CONFIRM_TRIGGERING_CAPABILITIES` set the action-danger raise uses — there is no separate `HIGH_RISK_CAPABILITIES` constant; `PluginMcpTierAuth.ts` imports `CONFIRM_TRIGGERING_CAPABILITIES` from `shared/config/pluginCapabilities.ts` directly. A plugin that declared none of those seven high-risk tokens (`shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:invoke`, `agent:register`, `agent:input`) cannot have its server reach the D2 "shared-state mutation" tier just because a tool advertised `destructiveHint: true`; the call is **denied**, not silently downgraded (a downgrade would let the model pretend a mutation was read-only and bypass the audit narrative). This caps the consent tier, not literal tool-list filtering. (`deriveDangerTier` in `PluginMcpTierAuth.ts`, whose `deriveCapabilityCap` helper reads the set, wired into `PluginMcpConsentService.ts`. `agent:register` is in the set and **does** lift the cap — the source comment states it "entitles its MCP tool surface to reach D2" — as does `agent:input`.)
- **MCP client-capability advertisement — _not yet shipped._** Intended: `elicitation` and `sampling` are advertised to a plugin-hosted MCP server in the `initialize` handshake only when the plugin declares `mcp:elicitation` / `mcp:sampling` (default-deny). Those tokens don't exist in the schema yet, so no gate fires today.

### 3. Explicit non-guarantees (the 1.0 contract)

These are the non-guarantees the 1.0 plugin model deliberately makes. They are stated here, in one place, so a plugin author or a security reviewer can read the whole contract without inferring it from scattered notes. None is an oversight — each is a decision to ship honestly rather than imply protection we don't deliver.

- **No runtime sandbox.** The host does not sandbox Node. A plugin can call `require("fs")` directly, spawn subprocesses, and open sockets regardless of what it declared. The capability list governs declared intent through host-side UX policy; it is not a kernel of enforcement against arbitrary code.
- **No signing or publisher identity.** Daintree verifies a plugin's _integrity_ — a SHA-256 hash over the archive bytes, persisted in the provenance record and used for update detection — but not its _authenticity_. `.dntr` archives carry no cryptographic signature, and there is no publisher-identity system. A `.dntr` downloaded from a URL you trust is exactly as trustworthy as that URL, and no more. (Signing is deferred — see [distribution](./distribution.md).)
- **No install-time consent gate.** A plugin's declared capabilities are surfaced _after_ install, in the plugin manager's detail pane — not in a pre-install dialog the user must approve. A fresh install runs without enumerating capabilities; the only interstitial prompts are the plaintext-HTTP warning (URL installs) and the update-preview confirm (re-fetching an installed plugin). This is a deliberate 1.0 decision; a pre-install consent gate is not yet implemented. The first per-capability consent a user actually sees is the MCP TOFU prompt at first tool use, and those consent pins are keyed by `pluginId` (author-controlled) and purged on uninstall, so reinstalling the same plugin name re-prompts rather than inheriting prior approvals (#9533).
- **Secret storage uses the OS keychain when available, plaintext otherwise.** Settings declared `type: "secret"` are encrypted at rest through the OS keychain — macOS Keychain, Windows DPAPI, or libsecret/kwallet on Linux — via Electron `safeStorage`, and persisted as base64 ciphertext in the same per-plugin JSON file (user-scope at `~/.daintree/plugin-settings/{pluginId}.json`, project-scope at `<projectRoot>/.daintree/plugin-settings/{pluginId}.json`, the latter tracked per-repo). When no keychain backend is available — typically a headless Linux box with no libsecret/kwallet — the value falls back to plaintext JSON under `chmod 0o600` (POSIX) exactly as before, and the plugin settings UI discloses which tier is in use per field ("Stored in OS keychain" vs "Stored as plaintext — keychain unavailable"). Existing plaintext secrets are migrated to the keychain on their next write, never silently dropped. Two caveats remain: a secret in the keychain is still readable by any code running as your user (no runtime sandbox — see above), and project-scope secrets written on a plaintext-only host are committed in cleartext if the file is tracked. Prefer scoped, short-lived, or read-only tokens for anything stored this way; don't store a credential that must survive a compromise of your logged-in session.

Trust in a plugin's code is the user's responsibility — install only from sources you trust, and inspect plugins that request broad capabilities.

## Schema shape

The manifest field is `capabilities` (`PluginCapability = BuiltInPluginCapability` in `shared/types/plugin.ts`). The per-capability discriminated-union form below and the `mcp:*` tokens are **not yet parsed** — `capabilities` accepts only flat string tokens today. Scope attenuation has shipped, but as a separate **top-level `scopes` object** on the manifest (`scopes.network.allowedUrls`, `scopes.fs.allowedPaths`; see `PluginManifestScopesSchema` in `electron/schemas/plugin.ts`), not as the per-element `{ name, scopes }` shape below. The refactor that folds scopes into the capability element, plus the `mcp:*` tokens, remains the only genuinely unshipped part of this contract.

```ts
capabilities: Array<
  | BuiltInPluginCapability // "shell:exec", "git:write", "fs:project-read", ...
  | { name: "network:fetch"; scopes: { allow: string[] } } // URL prefix allowlist
  | { name: "fs:project-write"; scopes: { allow: string[] } } // glob allowlist
  | { name: "mcp:elicitation" }
  | { name: "mcp:sampling" }
>;
```

The array is kept (it matches the current shape and stays grep-friendly). The element becomes a discriminated union — a bare token for the unchanged cases, a `{ name, scopes }` object for the scoped ones, and dedicated `mcp:*` tokens for the MCP advertisement gates. `*` and `**` are rejected at the schema level. `mcp:*` tokens are opt-in only and are never implied by any other capability.

## Industry precedent

The prior art divides cleanly along one axis: whether a sandbox exists to gate against.

- **VS Code** — pure disclosure. Workspace Trust gates _workspace features_ (auto-run tasks, terminals, workspace-settings injection), **not** the extension API surface. Extensions self-attest a trust level and voluntarily gate their own behaviour; once running, an extension is an unsandboxed Node.js process. Not a runtime API gate.
- **Obsidian** — pure disclosure. Community plugins get full Node/Electron access; Obsidian's own docs concede they cannot reliably restrict them, which is why community plugins live behind a Restricted Mode and a prominent warning.
- **Chrome extensions** — gated, because a sandbox exists. Pre-install disclosure plus `host_permissions` / `optional_permissions`, enforced at runtime — an undeclared cross-origin fetch is blocked at the platform boundary.
- **Tauri 2.x** — gated at the IPC bridge, which is the only path from webview to host. A command can't be dispatched without a capability declaration. Scope attenuation (allow/deny globs) is enforced _within_ the command handler via an injected scope, not before dispatch.
- **Zed** — gated at the WebAssembly Component Model boundary (wasmtime). The host controls which host functions the guest can call. This is the "pure gated needs a sandbox" precedent.

Daintree has no equivalent boundary — shared V8 + Node means there is no chokepoint to gate at. Hybrid is the honest model for that constraint.

## What shipped

The sibling issues this record drove are all closed. For traceability:

- **#9268 (capabilities rename + schema)** — shipped. `permissions` was renamed to `capabilities` (`PluginCapability = BuiltInPluginCapability` in `shared/types/plugin.ts`). The element is still a flat token, not the discriminated union below.
- **#9228 (lock the manifest contract before 1.0)** — shipped. The field name and the non-guarantee are frozen in the manifest contract before external authors depend on them.
- **#9247 (compound lattice + manifest scopes)** — shipped. `manifestTriggersCompoundElevation` (`PluginService.ts`) implements the lattice; `scopes` ship as a top-level object (`PluginManifestScopesSchema`, `electron/schemas/plugin.ts`), with network attenuation live and fs parsed-but-unconsulted.
- **#9234 (plugin-MCP consent + gating + audit)** — shipped. `electron/services/plugin-mcp/` holds `PluginMcpConsentService`, `PluginMcpTierAuth` (`deriveDangerTier`), and `PluginMcpAuditService`.

Still genuinely unshipped (no open issue tracks them — fold in when the work lands): the per-capability discriminated-union refactor below, and the `mcp:elicitation` / `mcp:sampling` client-capability advertisement tokens.

## Open questions

- Whether `mcp:elicitation` / `mcp:sampling` should be top-level tokens or nested under an `mcp:` object. The current bias is flat, for grep-ability.
- Whether scope wildcards should be allowed for built-in plugins via a signed-manifest path. Probably not for 1.15; revisit later.
