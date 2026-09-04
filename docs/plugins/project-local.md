# Project-local plugins

A project can ship its own plugins. They live in the project's repository at `<projectRoot>/.daintree/plugins/`, they are committed like any other source, and they load only while that project is open — bound to it, not to the app.

This is the difference from an installed plugin. An installed plugin lives in `~/.daintree/plugins/`, belongs to the user, and is app-wide: every project sees its panels and commands. A project plugin belongs to the repository, travels with a clone and a branch, and is visible only inside the project that ships it. If the tool you are building is about _this_ codebase — a deploy board, a dashboard over your own build artifacts, a purpose-built canvas for the people working in this repo — it belongs here rather than in the user's plugin directory.

The whole design is shaped by one case: an agent working in a fresh worktree should be able to write a plugin, commit it, and have it load on the next open with no install step and no build step. That is why the build output is committed, why the host never compiles, and why trust is decided once per project instead of per change.

## On disk

```
<projectRoot>/.daintree/
├── recipes/                     # existing, git-tracked
├── plugin-settings/             # existing, git-tracked, project-scope settings
└── plugins/
    └── acme.dashboard/
        ├── plugin.json          # must declare "scope": "project"
        ├── dist/                # COMMITTED build output — the load contract
        │   ├── index.js         # manifest `main`
        │   └── panel.js         # a view's `componentPath`
        ├── src/                 # your source. The host NEVER reads this.
        ├── package.json         # your build. The host NEVER runs it.
        └── README.md
```

Daintree scans `<projectRoot>/.daintree/plugins/` on project open. Each direct subdirectory holding a `plugin.json` is a candidate; dot-prefixed directories are skipped, and a directory (or a `plugin.json`) that symlinks out of the project root is refused rather than followed. Manifests over 512 KB are refused too — discovery runs before any trust decision, on a folder anyone who can push to the repository can write, so it stays cheap and bounded.

The plugin is identified by its manifest `name`, not by its directory name — the project-root scan deliberately does not compare the two. The manifest id is what names the plugin's git-tracked settings and storage files, what the trust record lists as known or staged, and what the host joins with the project id to form the instance key everything else is indexed by. Name the directory after the manifest anyway (`acme.dashboard/` for `"name": "acme.dashboard"`); that is what `daintree-plugin new --project` does and what every other tool assumes.

A project plugin may share a manifest id with an installed plugin. Both load — identity keeps them apart — and the plugin manager flags the overlap rather than hiding it.

## Create one

```bash
cd <somewhere inside your project>
npx daintree-plugin new dashboard --publisher acme --project
```

`--project` is a boolean flag; the plugin name is still the positional argument. It walks up from the current directory for the nearest ancestor holding a `.daintree/` directory or a `.git` (a file, in a worktree), and fails with a message rather than guessing if it finds neither. The plugin is written to `<projectRoot>/.daintree/plugins/acme.dashboard/`.

What `--project` changes relative to an installed scaffold:

- `plugin.json` gains `"scope": "project"`
- `package.json` gains a `dev` script running `vite build --watch`, and drops the `package` script — a project plugin is distributed by being committed, not as a `.dntr`
- `vite.config.ts` emits **inline** source maps with absolute `sources`, so DevTools breakpoints land in the real `.tsx` without a sidecar `.map` having to be served over `plugin://`
- `.gitignore` force-includes `dist/`, and a generated `README.md` explains why
- no `.dntrignore` — that file only shapes a `.dntr` archive
- a watcher recipe lands in `<projectRoot>/.daintree/recipes/`, so Daintree can start the build alongside the rest of the project environment

Use the `command` or `view` template with `--project`. The `mcp` and `full` templates scaffold `contributes.mcpServers`, which a project-scoped manifest may not declare (see [What a project plugin may contribute](#what-a-project-plugin-may-contribute)), so the scaffold refuses those two combinations rather than writing a manifest the host would decline to load.

Run `npx daintree-plugin validate` in the plugin directory to check the manifest before committing. It reads your declared `scope` and validates under the matching origin, so a `"scope": "project"` manifest is checked against the project rules.

## The committed `dist/` contract

**Daintree reads `plugin.json` and `dist/`. It never compiles a project plugin, never reads `src/`, and never runs its `package.json`.** That holds for command handlers too: an installed plugin may put one at `src/<commandId>.js` for the host to import, but a project plugin's commands are registered from its worker entry point with `host.registerAction`. Running a repository's uncompiled source in the main process would sit outside the worker every other plugin gets its crash isolation from.

Opening a project must not run a build — that would be an execution channel with no gate in front of it — so the build output is part of the repository. The payoff is that a checkout is complete: the plugin activates on any machine, on any branch, with no `npm install` and no build step. That is what makes it work for an agent that just created a worktree.

The consequence is a rule you have to keep: **rebuild and commit `dist/` in the same commit as the source change that caused it.** A branch with stale `dist/` is a plugin that is stale for everyone who checks that branch out. A branch with no `dist/` is worse than it looks: the manifest still parses, so the plugin's panels and commands still appear — they just do nothing, because there is no module behind them.

Most repositories ignore `dist/` at the root, and that pattern covers this directory too. The generated `.gitignore` in the plugin directory undoes it:

```gitignore
!dist/
!dist/**
```

Both lines are there deliberately. `!dist/` re-includes the directory, which is what makes git descend into it at all; `!dist/**` re-includes the files against any parent rule that matches the contents rather than the directory (`dist/*`, `**/dist/**`, even `*.js`). Whether you need the second one depends on how the repository's own ignore rules are written, and getting it wrong looks correct in the file while silently breaking the load contract — so keep both.

One case no rule inside the plugin can fix: if the project ignores `.daintree/` itself, git never descends far enough to read this `.gitignore`. Un-ignore `.daintree/plugins/` at the project root instead. `git check-ignore -v .daintree/plugins/acme.dashboard/dist/index.js` settles the ignore half in one command — no output means nothing is ignoring the file, which is necessary but not sufficient; `git ls-files` tells you whether it is actually tracked.

Two more things about how the host reads that directory. **`main` is realpath-contained**: a `dist/index.js` that resolves outside the plugin directory through a symlink is ignored rather than executed, matching what the `plugin://` handler does for view modules. And **activation is still lazy**: a trusted project plugin without `"onStartupFinished"` in `activationEvents` registers its contributions at load but does not import `main` or run `activate()` until one of those contributions is actually used, exactly like an installed plugin.

Your view module is addressed by an opaque, per-load `plugin://` authority rather than by your plugin id. If you build a `plugin://` URL by hand, use the `pluginId` you are handed in `PanelViewProps` — for a project plugin that value is the instance key, not your manifest name, and hardcoding the manifest name resolves nothing.

## The dev loop

```bash
cd .daintree/plugins/acme.dashboard
npm install
npm run dev        # vite build --watch, rebuilding dist/ in place
```

The scaffolded recipe in `.daintree/recipes/` runs the same watcher as a terminal, so the build comes up with the rest of the project environment rather than as a separate thing you have to remember.

There is no package-and-install step. The plugin is already where the host reads it, so a rebuilt `dist/` is picked up in place — see [Hot reload](#hot-reload). `daintree-plugin dev` is the _installed_-plugin loop and does not apply here.

## Trust

Project plugin code is code from a repository. It runs with your account, unsandboxed, exactly like an installed plugin — and unlike an installed plugin, you did not choose to install it: it arrived with a clone, a pull, or an agent's commit. So there is a gate.

**One gate, at the folder, once.** Opening a project that has at least one valid manifest under `.daintree/plugins/` and no decision on record raises a dialog naming the plugins, and offers three answers:

| Answer | Effect |
| --- | --- |
| **Keep disabled** | Remembered. Nothing runs, and you are never asked again for this project. The plugin manager offers to enable later. |
| **Enable for this session** | Held in memory only. Nothing is written, and the next launch asks again. |
| **Always enable** | Persisted for this project, in Daintree's own store — never in the repository. |

Dismissing the dialog records nothing, which means nothing runs and the project may ask again next time.

**The default is disabled, and no record means no code runs.** Discovery still parses every manifest so the plugin manager can tell you what is there, but with no decision on record it reads no `dist/`, imports nothing, and spawns no worker.

**A trusted project never re-prompts on content change.** Branch switches, pulls, rebases, rebuilds and agent edits all reload silently. Daintree's agents rewrite the repository continuously; a content-hash re-approval prompt would fire constantly and train you to dismiss it, which buys nothing.

**Worktrees inherit the project's decision.** Trust is per project, and only the project root's `.daintree/plugins/` is scanned — worktrees are views of the project, not separate scan roots. A worktree never raises its own prompt.

**A manifest id the project has never had is staged, not run.** This is the one content signal worth spending your attention on: "something new wants to execute here" is materially different from "the file you are editing changed". A new plugin id in a trusted project is parsed, announced once, and listed in the plugin manager with a one-click **Activate**; it does not run until you click. Ignoring the announcement is enough — the plugin stays staged and is not announced again, and for a persisted trust decision that staging survives a restart. A plugin that disappears and comes back — a rebase, a branch round trip — is treated as returning, not as new.

**Revoking is stronger than closing.** Turning project plugins off in the plugin manager unloads everything immediately, unregisters its contributions, invalidates its `plugin://` authorities, and purges that project's capability grants. Closing a project unloads its plugins too, but keeps the trust decision — a close is not a revoke.

A clone that Daintree registers as a separate project decides independently. A clone it recognises as the _same_ project moved — `.daintree/project.json` is git-tracked, and Daintree adopts the folder when the originally registered path is gone — keeps that project's identity, and with it its trust decision.

### Capabilities are disclosed, not enforced

There is no sandbox. A project plugin's `main` runs in a worker with full Node privileges and can call `node:fs` and `child_process` directly, whatever its manifest declares. `capabilities` mean exactly what they mean for an installed plugin — disclosure in the plugin manager, plus the host-side policy effects documented in the [trust model](./trust-model.md): the confirm-dialog raise, the compound lattice, the MCP danger-tier cap, and containment on the host-mediated `host.fs` / `host.git` surface.

There is deliberately **no per-capability consent dialog** at the project gate. Offering to deny filesystem access would claim an enforcement Daintree does not have. The gate asks one question — do you trust everyone who can write to this folder, including the agents you run here — and the capability list is disclosure beside it.

Capability grants (the just-in-time consent prompts on high-risk host surfaces) are held per plugin _instance_, so one project's grant never answers for another project's copy of the same plugin id.

## What a project plugin may contribute

Scoped to the owning project, and visible only in its views:

| Contribution | Behaviour under `scope: "project"` |
| --- | --- |
| `panels` | Registered against the project; the panel kind is qualified at runtime so two projects can contribute the same id |
| `views` | Served and mounted only in the owning project's renderer |
| `commands` | In that project's palette, dispatched into that project's renderer |
| `toolbarButtons` | Only in the owning project's toolbar |
| `contextMenus` | Only in the owning project's views |
| `keybindings` | Renderer-level, so they resolve within the focused project |
| `settings` | `scope: "project"` settings resolve from the bound project root, not from whatever is focused |
| `surfaces` | Project-scope only — see [Surfaces](#surfaces) |

Forbidden under `scope: "project"`, each rejected at manifest validation with an error naming the real obstacle:

| Contribution | Why it cannot be scoped yet |
| --- | --- |
| `menuItems` | The application menu is one OS-level menu shared by every window, with no per-project projection — the item would stay on the menu bar while another project is focused, and dispatch into it |
| `agents` | The plugin agent roster is one app-wide registry mirrored into the shared pty-host, and an agent's launch identity is persisted into terminals and sessions that outlive the project binding |
| `skills` | Contributed skills land in one app-wide index behind the built-in MCP server's `skills.search` / `skills.load`, which external agent sessions query with no project context to filter on |
| `recipes` | The plugin recipe registry is broadcast to every renderer unfiltered, so the recipe would appear in every project's launcher and empty state |
| `fileDecorationProviders` | Decoration requests carry a resource path with no owning-project routing, so the provider would be consulted for files in every open project |
| `processTools` | Process-tool detections are mirrored into the shared pty-host as one detection table for every terminal in the app |
| `mcpServers` | Contributed servers are reachable through the app-global plugin-MCP surface, where an external agent session carries no project binding to check against |
| `forgeProviders` | Forge providers need synchronous host methods (`parseRemote`, the URL builders) that cannot cross the plugin worker's async message port, so the descriptor could never be given an implementation |

These are deferred, not closed. Each error names the structural obstacle so that when the obstacle goes, the rule can go with it. An installed or builtin plugin is unaffected — being app-wide is what the absent `scope` means.

## Surfaces

`contributes.surfaces` lets a project plugin replace one of the host's own surfaces for its own project, so the project can present as a purpose-built application rather than as Daintree with one extra panel. It is available to `scope: "project"` plugins only: an installed plugin is bound to no project, so there is nothing to scope a claim to and nothing to arbitrate a second claimant against.

One slot exists today.

```jsonc
"contributes": {
  "panels": [{ "id": "overview", "name": "Overview", "iconId": "gauge", "color": "var(--theme-category-orange)" }],
  "views":  [{ "id": "overview", "componentPath": "dist/panel.js", "location": "panel" }],
  "surfaces": {
    "emptyCanvas": { "viewId": "overview" }
  }
}
```

`emptyCanvas` replaces what the content grid draws when the project has no panels open — the region the stock launcher lives in.

Rules:

- **Slot-replacing, never removing.** The surrounding chrome is untouched: the project switcher, the sidebar and the worktree dashboard stay exactly where they were. The frame around the surface keeps a control that swaps between your surface and the stock launcher in both directions, so the launcher is always one click away and a half-finished surface can never strand the user.
- **`viewId` must name a declared `contributes.views` entry**, cross-checked at manifest validation like any other dangling reference. It must not name a panel with `hasPty: true` — a PTY panel is rendered by the terminal host and never loads the view module, so the claim would hold the slot and draw nothing.
- **At most one plugin per slot per project.** The first claim stands and a second is refused, with both plugin names logged — fixing it means editing one of the two manifests, and you cannot do that without knowing the other. It is never a silent last-wins. The refused plugin still loads and everything else it contributes works, and its claim is remembered: if the incumbent later unloads, the slot passes to it rather than reverting to stock.
- The surface view receives the standard `PanelViewProps` (`panelId`, `pluginId`, `disposeSignal`) and sits inside the standard plugin error boundary, so a crash falls back with a working "Try again" rather than a blank region.

`projectHome` and `defaultLayout` appear in the design notes for this feature and are **not implemented** — the manifest schema rejects them. There is no per-project routing a persistent home surface could live at yet, and a recipe is launched against a worktree rather than against a project cold open. They land with the routing they need, not before it.

## Binding — which project a host call reaches

A project plugin's host object is bound to its project at construction, and every closure reads that binding rather than the focused project view. `host.dispatch` and `host.actions.*` target the bound project's renderer; `showQuickPick` / `showInputBox` / `showConfirm` are delivered into that project's view so the user finds the prompt when they switch to it; `getWorktrees` / `getActiveWorktree` / `getWorktreeStatus` and the worktree change events see only that project's worktrees; `sendToActiveAgent` reaches only agents belonging to it; toasts and renderer pushes go to its views.

There is no fallback to the focused view. `host.dispatch` and the UI prompts reject with `PROJECT_VIEW_UNAVAILABLE` when the bound project has no live renderer, rather than landing somewhere else — handing project A's plugin project B's renderer is the confused-deputy bug the binding exists to prevent. The read-only catalog surfaces (`host.actions.list` / `get` / `canDispatch`) never throw by contract, so they answer empty in the same situation. A project view that has been evicted under memory pressure still counts as live: the project is open, just backgrounded.

Installed and builtin plugins keep their existing ambient behaviour — they have no project of their own, so the focused view is the only thing their calls can mean.

## Settings and storage

`host.settings` with `scope: "project"` resolves from the bound project root, so a project plugin writes `<projectRoot>/.daintree/plugin-settings/<manifestId>.json` — never moved by a project switch. `host.storage` has three scopes and follows the same split:

| Scope      | File                                                        |
| ---------- | ----------------------------------------------------------- |
| `user`     | `~/.daintree/plugin-storage/<instanceKey>.json`             |
| `project`  | `<projectRoot>/.daintree/plugin-storage/<manifestId>.json`  |
| `worktree` | `<worktreePath>/.daintree/plugin-storage/<manifestId>.json` |

In-repository files are named by the **manifest id**, never by the instance key: the instance key embeds this machine's project id, and writing that into a tracked filename would commit one developer's local identity into everyone's checkout. The project root already provides the isolation. Files under the user's own directory are keyed by the **instance key**, so two projects shipping the same manifest id keep separate state.

The project root a bound plugin writes to is the one from its binding, not the focused project. The `"worktree"` storage scope is the exception today — it still resolves the app-global active worktree, so it can follow the user's focus rather than your project.

The `${worktree}` and `${project}` tokens in `scopes.fs.allowedPaths` expand against the bound project's own worktrees, so a project plugin's containment roots do not move when the user switches projects. An installed or builtin plugin keeps expanding them ambiently — it has no project of its own.

A project plugin that declares no `scopes.fs.allowedPaths` at all defaults to its own project root. It lives inside that tree, so the tree is the only sensible default — and without it `host.fs` and `host.git` would reach nothing but the plugin's own data directory. Declaring `allowedPaths` replaces that default rather than adding to it. An installed plugin that declares nothing still gets nothing, because it has no project to widen to.

The same containment applies to the settings UI: a project plugin's settings form can only address its own project.

## Hot reload

`plugin.json` and `dist/` are watched for every trusted project. **`src/` is never watched** — the host does not know how a given plugin builds, so a source write says nothing about whether a loadable artifact exists yet, and watching it would fire on every keystroke. `node_modules/` and `.git/` are ignored too.

A settled burst re-scans the plugin directory and hands the result to the ordinary project-open reconcile, so the trust gate, the staging rules and the per-project serialization all apply to a reload for free. Reloads are per plugin directory, not per project: rebuilding one plugin does not restart its siblings.

Three behaviours are worth knowing while you iterate:

- **A trailing debounce of ~200 ms.** A rebuild writes a whole `dist/` and a branch switch rewrites the tree; both are storms whose only useful interpretation is "look again once it stops".
- **Git operations defer the reload.** While `.git/index.lock` exists the tree is mid-rewrite, and any scan of it is a scan of a half-applied state. The watcher waits for the lock to clear (up to 30 seconds, so a crashed `git` cannot wedge it).
- **An invalid manifest keeps the running version.** A `plugin.json` caught mid-save does not tear down a working plugin: the re-read is retried with a short backoff, and only a manifest still broken afterwards falls through to the ordinary reconcile, which disables the plugin and leaves an `invalid` row in the plugin manager as the diagnostic. A plugin directory that has _vanished_ is a different signal and unloads immediately, which is what a branch switch should do.

What survives a reload: your `settings` values and everything in `host.storage`, because both are files keyed by identity rather than by process — and any panel state written with `PanelViewProps.persistState`, which is stored on the panel record alongside the layout rather than in the plugin process, so it outlives the worker entirely. What does not: module-scope state in your worker, and React state in your views. Design for a remount, exactly as for an installed plugin. [patterns.md](./patterns.md#what-survives-what) has the full matrix.

Each reload mints a fresh view-module generation so the renderer actually re-imports your bundle rather than returning the module already in its cache. Each generation is a permanent module record in that renderer (Chromium has no eviction API), so a very long authoring session in one project accumulates them; closing and reopening the project view clears it.

## Layouts and missing plugins

A panel whose kind no longer resolves — you switched to a branch without the plugin, or trust is off — renders the standard "plugin missing" placeholder and is **retained, not deleted**. Switching back restores the layout intact.

A project plugin's panel kind is qualified at runtime as `project:{projectId}/{manifestId}/{kindId}` so two projects can contribute the same panel id. That qualified form is not meant to reach saved layouts — a re-clone at a different path would orphan every panel that named it — and `toPersistedPanelKindRef` / `toRuntimePanelKindId` in `shared/config/panelKindRegistry.ts` are the conversion the save path is meant to use. The save path does not use them yet, so today a saved layout holds the qualified id. Treat panel restore across a re-clone as unfinished rather than guaranteed.

## Gotchas

- **`dist/` not committed.** The single most common failure, and it is invisible on the machine that built it. Check with `git check-ignore -v` before you assume the loader is broken.
- **The first negation without the second.** `!dist/` alone makes git descend into the directory and still excludes every file in it. Both lines, always.
- **A manifest without `"scope": "project"`** under `.daintree/plugins/` is rejected (`project_scope_required`), and a manifest _with_ it installed into the user directory is rejected the other way (`project_scope_not_allowed`). The guard runs in both directions so a plugin cannot quietly load under assumptions its author never made.
- **Editing `src/` and expecting a reload.** Only `plugin.json` and `dist/` are watched. Keep the watcher running.
- **Expecting a restart to be required.** It never is. Every contribution point available to a project plugin registers, reloads and unregisters live; anything that genuinely needed an app restart is simply not offered here.

## See also

- [Agent brief](./agent-brief.md) — the compressed version to hand an agent, with a zero-build skeleton
- [Manifest reference](./manifest.md) — `scope`, `contributes.surfaces`
- [Contribution points](./contribution-points.md) — per-point project-scope status
- [Trust model](./trust-model.md) — the capability contract and the non-guarantees
- [Development loop](./dev-loop.md) — `daintree-plugin new --project` and the CLI
- [Architecture](./architecture.md) — discovery roots, binding, identity
