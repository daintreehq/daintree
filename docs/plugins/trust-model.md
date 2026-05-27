# Plugin trust model

This is the canonical decision record for what a plugin's declared `capabilities` mean. It settles a contradiction that had accumulated across the codebase: the docs claimed pure disclosure while the code already applied a small derived gate. The contract is now **hybrid** — disclosure-first, with load-bearing host-side policy effects. Everything downstream (`#9268` schema, `#9247` lattice, `#9234` MCP consent) builds on this record.

## The contract in one line

> **Capabilities are disclosure-first with host-side policy effects.** The host does not sandbox plugin code — a plugin can call any Node API directly. The `capabilities` field is shown to the user at install, drives host-derived danger classification on plugin-registered actions, gates which MCP client capabilities are advertised to plugin-hosted servers, and is the upper bound on which MCP tools are exposed. It is not an enforcement boundary against malicious code; it is an honest, machine-readable description of what a plugin claims to need, used by the host to apply proportional friction at high-risk intent surfaces.

## The three options

Three contracts were on the table. Only one is honest about the constraint that defines our situation: there is no sandbox, and there cannot be one. Plugins share the host's React 19 + Node.js process. A plugin can `require("fs")` and `child_process.spawn` directly, and no custom-API gate intercepts that.

|  | (a) Disclosure-only | (b) Pure gated | (c) Hybrid (recommended) |
| --- | --- | --- | --- |
| Enforcement cost | None | Very high — checks on every host-API method, plus the impossible task of intercepting raw Node calls | Moderate — extend the existing `effectiveDanger` derivation, add the lattice (#9247), add the MCP advertisement gate (#9234) |
| Plugin-author cost | None | High — calls can fail mid-flow with `PermissionDenied` | Low — declare honestly; high-risk declarations show a confirm dialog (already true) |
| False-negative risk | **High** — compound attacks (read + network) declare nothing individually risky | Medium — gates work at the host-API surface but raw Node bypasses them, giving false confidence | Medium — same Node bypass, but the model never claims to prevent it; the lattice catches the compound classes |
| False-positive risk | None | High — risks training users to dismiss dialogs | Low — gates fire only on the five high-risk tokens + lattice; scopes attenuate further |
| Interaction with #9247 | No derived effects to raise | A lattice would refuse calls, but the enforcement surface doesn't exist | The lattice raises `effectiveDanger`; URL/glob scopes narrow sinks |
| Interaction with #9234 | MCP consent runs independent of the manifest — shadow privilege escalation | The manifest caps MCP at advertisement | The manifest caps MCP advertisement; `mcp:elicitation` / `mcp:sampling` become explicit opt-in tokens |
| Honest framing | Truthful (no sandbox) but invites attacks | Misleading — implies enforcement we can't deliver | Truthful: we disclose, we don't sandbox, but high-risk intent gets a confirm dialog |

## Recommendation

**Hybrid.** Three reasons.

**The code already does this.** `electron/services/PluginService.ts` raises a plugin action's `effectiveDanger` to `"confirm"` whenever the manifest holds one of five high-risk tokens. The docs claimed pure disclosure. The docs were wrong, not the code — this record reconciles them.

**Pure disclosure is the no-sandbox baseline, and it's the model that failed publicly.** VS Code, Cursor, Obsidian, and JetBrains all ship pure disclosure. That's the industry default, and it's exactly the class the malicious `ChatGPT - 中文版` / `ChatMoss` VS Code extensions exploited in January 2026 — over 1.5M combined installs, exfiltrating developer code using only the implicit filesystem + network access every editor extension already gets. They declared nothing individually risky because nothing gated the capabilities they abused. Pure disclosure has no surface to detect that compound class.

**Pure gated is security theatre without a sandbox.** Zed gates at the WebAssembly Component Model boundary; Tauri 2.x gates at the IPC bridge because that bridge is the only path from webview to host. Neither precedent transfers — we run shared V8 with Node, so a plugin bypasses any custom-API gate by calling Node directly. Claiming runtime enforcement we cannot deliver is worse than admitting we cannot.

Hybrid threads the needle: be honest that we don't sandbox Node, and still use declared capabilities as load-bearing host-side policy input.

## The three roles, by guarantee strength

The contract carries three roles, in descending order of how strong a guarantee each provides.

### 1. Disclosure (always)

Declared capabilities are shown in the install dialog and the Settings detail view as a humanised list ("This plugin can read your worktree files, make network requests, and spawn subprocesses"). This is the same reasoning Chrome extension permissions use — informational, pre-install. It is always present and never an enforcement boundary.

### 2. Host-side policy input (load-bearing)

Declared capabilities feed five derived effects. Be precise about what is live today versus what these sibling issues add — only the first is implemented.

- **`effectiveDanger` raise — _live today._** When a plugin's manifest holds any token in `CONFIRM_TRIGGERING_CAPABILITIES` (`shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:invoke`), every action that plugin registers is raised to `effectiveDanger: "confirm"`, regardless of the `danger` the plugin self-declared. The host may only raise, never lower. **This affects Daintree's own action system** — it gates the renderer's confirm dialog, MRU-rail eligibility, and `repeatLast`. It does **not** block the plugin from executing code or calling IPC directly. It is host-side UX policy, not a sandbox. (`PluginService.ts` — `CONFIRM_TRIGGERING_CAPABILITIES`, `effectiveDanger` derivation.)
- **Compound-capability lattice — _forthcoming (#9247)._** Combinations that are individually benign but dangerous together — read-source + unconstrained-sink, or unconstrained-sink + local-write — raise `effectiveDanger` even when no single token triggers. This is the surface that catches the compound benign-capability attack class.
- **Scope attenuation — _forthcoming (#9247)._** `network:fetch` with a URL allowlist, `fs:project-write` with a glob allowlist. The schema rejects `*` and `**`. A scoped declaration skips lattice elevation because it has narrowed its own sink.
- **MCP client-capability advertisement — _forthcoming (#9234)._** `elicitation` and `sampling` are advertised to a plugin-hosted MCP server in the `initialize` handshake only when the plugin declares `mcp:elicitation` / `mcp:sampling`. Default-deny.
- **MCP tool advertisement — _forthcoming (#9234)._** The host refuses to expose tools whose declared scope exceeds the manifest. The manifest is the upper bound.

### 3. Explicit non-guarantee (written prominently)

The host does not sandbox Node. A plugin can call `require("fs")` directly, spawn subprocesses, and open sockets regardless of what it declared. The capability list governs declared intent through host-side UX policy; it is not a kernel of enforcement against arbitrary code. Trust in a plugin's code is the user's responsibility — install only from sources you trust, and inspect plugins that request broad capabilities.

## Schema shape

The manifest field is `capabilities` (`PluginCapability = BuiltInPluginCapability` in `shared/types/plugin.ts`). The discriminated-union form below and the `mcp:*` tokens are **not yet parsed** — only flat string tokens are accepted today. The schema extension to the discriminated-union form is tracked in #9247.

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

## Sibling-issue amendments

The chosen contract changes what these issues must do:

- **#9268** — adopt `capabilities` as the field name and extend the element schema to the discriminated union above. The field rename and the non-guarantee both freeze here.
- **#9228** — bake the canonical statement into the manifest contract before the SDK ships to npm; the field name and the non-guarantee must be frozen before external authors depend on them.
- **#9247** — the compound-capability lattice and scope attenuation are load-bearing parts of this contract, not optional add-ons. Ship them in the same release as the schema.
- **#9234** — `elicitation` / `sampling` advertisement must be gated by `mcp:elicitation` / `mcp:sampling` capabilities; tool advertisement must be bounded by the manifest as the upper bound.

## Open questions

- Whether `mcp:elicitation` / `mcp:sampling` should be top-level tokens or nested under an `mcp:` object. The current bias is flat, for grep-ability.
- Whether scope wildcards should be allowed for built-in plugins via a signed-manifest path. Probably not for 1.15; revisit later.
