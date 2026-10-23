# Contribution Points

A contribution point is a slot in Daintree that a plugin can fill. Contributions are declared in the `contributes` field of `plugin.json`. Daintree reads the manifest eagerly at startup — contributions show up in the command palette and UI before any plugin code runs.

Each section below documents a contribution point, its schema, an example, and current implementation status.

## Status legend

- **Shipped** — available in the current Daintree release
- **Future** — not yet committed

## Project scope

A plugin that declares `"scope": "project"` lives in a project's own repository and loads only while that project is open — see [Project-local plugins](./project-local.md). Not every contribution point can be narrowed to one project yet, so the manifest gate refuses the ones that cannot. This table is the per-point status; the sections below describe each point in its app-wide form, which is what an installed or builtin plugin always gets.

| Contribution | Under `scope: "project"` |
| --- | --- |
| `panels` | Available — registered against the project, visible only in its views |
| `views` | Available — served and mounted only in the owning project's renderer; a `location: "settings"` view renders in Project settings → Plugins |
| `commands` | Available — in that project's palette, dispatched into that project's renderer |
| `toolbarButtons` | Available — only in the owning project's toolbar |
| `launchEntries` | Available — only in the owning project's launcher, and a pinned entry's toolbar button is that project's alone |
| `layouts` | Available — only in the owning project's palette, and only that project's views can apply them |
| `searchProviders` | Available — only in the owning project's quick switcher; its keyword is checked against the providers that project can see, and its "Show in quick switcher" switch is that project's alone |
| `contextMenus` | Available — only in the owning project's views |
| `keybindings` | Available — renderer-level, so they resolve within the focused project |
| `settings` | Available — every field, whatever its `scope`, lives in Project settings; `project` and `local` values resolve from the bound project root, not the focused one |
| `surfaces` | **Project scope only** — see [Surfaces](#surfaces--shipped-project-scope-only) |
| `agentMcp` | Available — every credential for the plugin's server is minted per terminal and bound to one project, and a project plugin's server can only be granted to its own project |
| `databases` | Available — a `"project"` database is a file in the repository, resolved against the bound project root; `"local"` stays in this machine's plugin data |
| `fileDecorationProviders` | Available — consulted only for the owning project's views, ahead of installed providers in the merge |
| `recipes` | Available — only in the owning project's launcher, empty state and recipe manager, and gone while the plugin is switched off or its folder is untrusted. A terminal may use `terminal`, `dev-preview`, `plugin-panel` for one of the plugin's own panels, or a built-in agent; `agents` is rejected below, so there is no plugin agent of its own to name |
| `promptTemplates` | Available — offered only in the owning project's composer, and gone while the plugin is switched off or its folder is untrusted |
| `worktreeSetupSteps` | Available — run only for worktrees created in the owning project |
| `terminalLinks` | Available — matched only in the owning project's terminals, and gone while the plugin is switched off or its folder is untrusted |
| `menuItems` | Rejected — the application menu is one OS-level menu shared by every window, with no per-project projection |
| `agents` | Rejected — the agent roster is one app-wide registry mirrored into the shared pty-host, and launch identity outlives the project binding |
| `skills` | Rejected — contributed skills land in one app-wide index behind the MCP server's `skills.search` / `skills.load`, which filter by no project |
| `processTools` | Rejected — detections are mirrored into the shared pty-host as one table for every terminal |
| `mcpServers` | Rejected — the plugin-MCP IPC surface is app-global: servers are addressed by plugin and server id alone, and a tool call carries no project to check the contribution against. To serve tools to the project's agents, declare `agentMcp` instead |
| `tours` | Allowed — a project plugin's tours are offered only in its own project |
| `themes` | Rejected — the app theme is one machine-wide selection painted into every window, with no per-project theme to narrow to |
| `forgeProviders` | Rejected — forge providers need synchronous host methods that cannot cross the plugin worker's message port |
| `fileEditors` | Allowed, view-backed only — editors apply only in the plugin's own project and may also match project-relative `paths`. A `slot` is built-in only |
| `previewTools` | Rejected — built-in only; the tool's components resolve out of the host bundle, which no other origin's renderer reaches |
| `guestAdapters` | Rejected — built-in only; the bundle is emitted by Daintree's own build and runs with full DOM access inside the previewed site |

Each rejection is a manifest error naming the obstacle, not a silent drop, and each is deferred rather than closed — the reason says what has to be built before the rule can go.

## Commands — _Shipped_

Commands are callable actions that appear in the command palette and can be bound to keybindings, toolbar buttons, or menu items. Declare them in `plugin.json` so the command shows up in the palette before your plugin activates, or register them at runtime via `host.registerAction()` for dynamic cases. See [Host API → registerAction](./host-api.md#registeraction) for the full signature.

```json
{
  "contributes": {
    "commands": [
      {
        "id": "plan-from-issue",
        "title": "Plan From Issue",
        "description": "Turn a Linear issue into a branch and agent session.",
        "category": "Linear Planner",
        "kind": "command",
        "danger": "confirm"
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Bare command id. Daintree namespaces it as `{pluginId}.{id}` at runtime — matching every other contribution surface. |
| `title` | yes | Palette entry label. |
| `description` | yes | One-line summary surfaced in the palette description. |
| `category` | yes | Sub-label on the command's row. The palette gives your plugin one group of its own, titled with its display name, so this only tells your commands apart inside it. Up to 40 characters; a built-in category id (`worktree`, `git`, `terminal`, …, compared case-insensitively) is refused. |
| `kind` | yes | `"command"` or `"query"`. |
| `danger` | yes | `"safe"` or `"confirm"`. `"restricted"` is rejected — plugins cannot self-register restricted actions. The host raises `"safe"` to `"confirm"` automatically when the plugin holds a high-risk capability. |
| `keywords` | no | Extra search terms for the palette. |
| `inputSchema` | no | JSON schema validated against the dispatched `args` payload. |
| `when` | no | A `when` clause over your plugin's context keys. While it is false the command is left out of the palette. |
| `enablement` | no | Same grammar. While it is false the command stays in the palette, greyed out with a reason, and Enter does nothing. |
| `requires` | no | The capabilities _this command_ actually uses — see below. |

`when` and `enablement` only shape the palette. Keybindings, context menus, MCP and `host.dispatch` never evaluate them, so they decide what is offered, not what can run. A clause that doesn't parse is refused when the command registers.

**`requires` — per-action capability intent:**

By default the host derives a command's `effectiveDanger` from your plugin's _entire_ `capabilities` list, so declaring `shell:exec` for one command puts a destructive confirmation on all of them — including a no-argument "open the panel" command. Dropping the capability isn't an honest fix; `requires` is:

```json
{
  "id": "open-panel",
  "title": "Open Panel",
  "description": "Opens the tools panel.",
  "category": "Flutter Tools",
  "kind": "command",
  "danger": "safe",
  "requires": []
}
```

- **Omit `requires`** and nothing changes — the whole manifest is consulted, as before. Existing plugins need no migration.
- **`"requires": []`** declares the command exercises no capability, so it stays one click even in a plugin holding `shell:exec`.
- **`"requires": ["git:read"]`** consults only those capabilities, for both the high-risk set and the compound-capability lattice.

Three things it does _not_ do. It grants no access: host APIs still gate on `manifest.capabilities` at call time, so listing a capability here neither adds nor removes runtime authority. It cannot lower a self-declared `"danger": "confirm"`. And every entry must appear in your `capabilities` — naming one you didn't declare fails the command's registration outright rather than falling back, so an author's typo surfaces at load instead of quietly reverting to the old behaviour.

**Handler binding — two ways:**

_Filesystem convention (manifest-declared, lazy import):_ a command with id `plan-from-issue` looks for `src/plan-from-issue.{js,mjs}` (probed in that order) under your plugin directory. Its default export is the handler. The module is **not** imported until the command is first dispatched — twenty manifest commands cost zero activation time. It is imported and run inside your plugin's worker, like every other surface you contribute, so a command handler needs no `main` entry to exist: a plugin that declares commands and ships nothing but their handler modules gets a worker on first dispatch. The handler must be shipped as JavaScript: `.ts`/`.tsx` files are not probed (a `.ts` handler appears to work under Node's type-stripping but throws at first dispatch on any non-erasable syntax, and `.tsx` never runs) — author in TypeScript and compile to `src/{id}.js`, or register the command imperatively.

The convention is for installed and dev-linked plugins only. A project plugin's load contract is its committed `dist/`, so the host never probes its `src/` for handler modules: every command a project plugin declares needs a `host.registerAction` registration from its `main`.

```js
// src/plan-from-issue.js
export default async function planFromIssue(args) {
  // handler body
}
```

> **Lazy handlers receive `args` only — no `host`.** A filesystem-convention handler's single parameter is the dispatched `args` payload. There is no second `host` argument, so a lazy handler **cannot** call `host.showQuickPick`, `host.sendToActiveAgent`, `host.settings.get`, or any other host API. This is structural, not an oversight: the host is scoped to `activate()` and is revoked once activation returns, long before a command is first dispatched, so there is no live host to hand a lazily-imported handler. **If your command needs host APIs, register it imperatively in `activate()`** (next section) — that handler closes over the live `host`. An imperative `registerAction` for the same id supersedes the lazy file, so you can start with a manifest-declared stub and graduate to `registerAction` the moment you need host access.

_Imperative registration (escape hatch for dynamic commands — and the only way to reach host APIs from a command handler):_

> `@daintreehq/plugin-sdk` is the published SDK package (its types re-exported from `shared/types/plugin-sdk.ts`, scaffolded as a dependency by the `daintree-plugin` CLI). It's distinct from the `daintree-plugin` CLI package — don't conflate the two.

```ts
// src/index.ts
import type { PluginHostApi } from "@daintreehq/plugin-sdk";

export async function activate(host: PluginHostApi) {
  host.registerAction(
    {
      id: "plan-from-issue",
      title: "Plan From Issue",
      description: "Turn a Linear issue into a branch and agent session.",
      category: "Linear Planner",
      kind: "command",
      danger: "confirm",
    },
    async (args) => {
      // handler body
    }
  );
}
```

If a manifest-declared command has no matching `src/{id}.{ext}` file and no imperative `registerAction` override, running it produces a user-visible toast: `Command "{pluginId}.{id}" has no handler`. The manifest entry alone is enough to make the command appear in the palette so authors can wire it up incrementally.

**Collision rule:** a command whose resolved `{pluginId}.{id}` matches a built-in Daintree action id is rejected at load with a provenance `loadError` — the command does not register. Pick a different id.

**Duplicate ids within an array** are rejected at manifest validation (`duplicate_contribution_id`). The bare `id` is the registry key for every contribution array that has one — `panels`, `toolbarButtons`, `commands`, `views`, `mcpServers`, `agentMcp`, `databases`, `skills`, `recipes`, `tours`, `forgeProviders`, `fileDecorationProviders`, `fileEditors`, `previewTools`, `guestAdapters`, `agents`, `worktreeSetupSteps`, and `settings` — so two entries with the same id in the same array would silently first-win at load. The check is per-array: ids in different arrays are namespaced independently and never collide.

## Panels — _Shipped_

Panels are full-sized workspaces in Daintree's grid (alongside terminal panels, browser panels, etc.). A plugin panel is a React component the user can open, tile, and close like any other panel.

```json
{
  "contributes": {
    "panels": [
      {
        "id": "dashboard",
        "name": "Cost Dashboard",
        "iconId": "gauge",
        "color": "hsl(150 60% 55%)",
        "hasPty": false,
        "canRestart": false,
        "canConvert": false,
        "showInPalette": true
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Letters, digits, `.`, `_` and `-`, at most 64 characters. Namespaced at runtime as `{pluginId}.{id}`. |
| `name` | yes | Display label in the panel header and palette. |
| `iconId` | yes | One of the shared plugin icon IDs listed in `shared/config/pluginIconIds.ts`, or a [custom SVG](#custom-icons) inside your plugin (`"./icons/dash.svg"`). An unrecognized ID falls back to the generic terminal glyph on panel surfaces; `daintree-plugin validate` warns about it. |
| `color` | yes | Any CSS colour, applied raw to the panel's icon on the palette and launcher surfaces — not to the active-tab indicator, which is a fixed accent. The convention for plugin panels is a theme category token, `var(--theme-category-orange)`, so it follows the active theme; every fixture in the repo uses that form. |
| `hasPty` | no | `false` (default) for a view panel. `true` makes the kind a terminal: it renders through the terminal host, never loads a view, and is refused together with `toolbar` or `dockable: false`. Its `menu` entries, and any it publishes at runtime, appear on the terminal's right-click menu. Not a way to build plugin UI. |
| `canRestart` | no | Show a "restart" control in the panel header. Default `false`. |
| `canConvert` | no | Allow conversion between compatible panel kinds. Rarely useful for plugins. Default `false`. |
| `showInPalette` | no | Include in the "New Panel…" palette. Default `true`. |
| `dockable` | no | Dockable by default. Declare `false` to opt the kind out of the dock. Rejected together with `hasPty: true` (`pty_panel_dock_opt_out_unsupported`) — a plugin PTY kind renders as a terminal, which is always dockable, so the opt-out could never be honoured. |
| `stateVersion` | no | Integer from 1 to 1,000,000 naming the shape your panel writes through `persistState`. Omit it and the host makes no promises about your saved state; declare it and you get the migration contract below. |
| `scope` | no | `"worktree"` (the default) ties each panel to the worktree it was opened in. `"project"` makes it one panel for the whole project: `panel.openPluginPanel` and the launchers open it in the dock with no worktree, and its dock chip and dialog show in every worktree. A user can still move it into a worktree's grid, which ties it to that worktree. Rejected together with `hasPty: true` (`pty_panel_project_scope_unsupported`) or `dockable: false` (`project_panel_dock_opt_out_unsupported`). See [Open it in the dock](./patterns.md#open-it-in-the-dock). |
| `reportsActivity` | no | `true` lets your plugin report its own work on panels of this kind with [`host.setPanelActivity`](./host-api.md#setpanelactivity) — working, waiting, finished or failed — drawn like agent activity and attributed to your plugin. The plugin manager lists the kind as reporting activity. Omitted or `false`, the method refuses this kind's panels. |
| `menu` | no | Up to five of your own actions to offer in the panel's ⋯ and right-click menus. See [Panel menu](#panel-menu) below; to change the entries while the panel runs, see [Runtime menu entries](#runtime-menu-entries). |
| `toolbar` | no | Up to three of your own actions drawn as buttons in the panel header, with live state your view sets. See [Panel toolbar](#panel-toolbar) below. |

**Icon IDs** — one shared set backs every surface that renders a plugin icon (the panel palette, panel headers, tabs, the dock, toolbar buttons, and the toolbar overflow menu), so an ID looks the same everywhere it appears:

`terminal`, `package`, `puzzle`, `globe`, `monitor`, `monitor-play`, `file-text`, `file-diff`, `folder-tree`, `git-branch`, `git-pull-request`, `sticky-note`, `gauge`, `list`, `sparkles`, `layout-panel-top`, `daintree`, `wallet`, `receipt`, `chart-column`, `chart-line`, `chart-pie`, `calendar`, `clock`, `kanban`, `check-square`, `list-todo`, `users`, `contact`, `handshake`, `briefcase`, `inbox`, `mail`, `image`, `palette`, `book-open`, `bookmark`, `notebook`, `newspaper`, `megaphone`, `target`, `heart-pulse`, `flame`, `dumbbell`, `utensils`, `tag`, `shopping-cart`, `boxes`, `database`, `table`, `layout-grid`, `map`, `star`, `rocket`, `lightbulb`, `flask`, `refresh-cw`, `download`, `upload`, `filter`, `plus`, `search`, `play`, `settings`

`shared/config/pluginIconIds.ts` is authoritative — run `daintree-plugin validate` to check a manifest against the set your installed host actually ships. Panel `iconId` also accepts a built-in agent ID (e.g. `claude`) to render that agent's brand mark.

<a id="custom-icons"></a>**Custom icons** — when no generic ID fits, `iconId` on a panel, toolbar button or process tool can point at an SVG file in your plugin instead: a lowercase path starting with `./`, relative to `plugin.json`, ending in `.svg`, at most 64 characters (`"iconId": "./icons/flutter.svg"`). It renders on every surface the generic IDs do, including the terminal tab of a detected process tool.

- **Draw it monochrome.** The host paints the icon as a mask in the surrounding text colour, so it follows the theme like the built-in glyphs do. Only the shape's opacity counts — fills and stroke colours are ignored, and a multi-colour logo flattens to its silhouette.
- **Size it like a 24×24 glyph.** Give the `<svg>` root `xmlns="http://www.w3.org/2000/svg"` and a `viewBox` (for example `0 0 24 24`); the host scales it into the same box as the built-in icons. The file has to be well-formed XML with a single `<svg>` root and at least one shape.
- **Keep it static and self-contained.** At most 64 KB of UTF-8. No scripts, event handlers, `foreignObject`, animation, external or `data:` references, DOCTYPE or entity declarations. A file that needs anything removed is refused rather than silently cleaned.
- **It has to live inside the plugin.** Paths with `..`, backslashes, URL syntax, or a symlink that resolves outside the plugin directory are refused, and `daintree-plugin package` fails if the file wouldn't make it into the archive.

`daintree-plugin validate` reports a missing or unusable icon file as an error. At runtime a broken icon doesn't stop the plugin loading; that one surface draws the generic fallback glyph instead. An older Daintree that predates custom icons treats the path as an unknown ID and draws the same fallback, so a manifest using one still loads there. Edits to an icon file take effect when the plugin reloads.

**Panel state versioning** — `persistState` writes an opaque bag that survives restarts, so a change to its shape meets bags written by every version of your plugin the user has ever run. `stateVersion` is how you tell those apart.

Declare it, and the host stamps that number onto the panel record every time your view persists — the value comes from the manifest, never from your patch, so the bag can never claim a version it is not. On the next mount the view reads `PanelViewProps.stateVersion` and migrates forward from whatever it says: `0` means the bag predates versioning, an absent value means you never declared one. Persisting the migrated result re-stamps it at your current version.

You never have to handle a version _above_ the one you declare. That only happens on a downgrade — the user ran a newer build of your plugin, then went back — and the host refuses the bag rather than let it be misread and overwritten, showing the user an error naming both versions. The state stays on disk, so reinstalling the newer build brings it back intact.

Bump `stateVersion` when the shape changes incompatibly, never for an additive key your view can already tolerate missing.

### Panel menu

`menu` puts your own actions on the panel's ⋯ menu and its right-click menu, which always show the same list. Each entry is `{ "actionId": "<your action>", "label"?: "<text>" }`:

```json
{
  "contributes": {
    "commands": [
      {
        "id": "refresh",
        "title": "Refresh data",
        "description": "",
        "category": "general",
        "kind": "command",
        "danger": "safe"
      },
      {
        "id": "export",
        "title": "Export transactions",
        "description": "",
        "category": "general",
        "kind": "command",
        "danger": "safe"
      }
    ],
    "panels": [
      {
        "id": "main",
        "name": "Budget",
        "iconId": "wallet",
        "color": "var(--theme-category-green)",
        "menu": [
          { "actionId": "acme.budget.refresh" },
          { "actionId": "acme.budget.export", "label": "Export as CSV…" }
        ]
      }
    ]
  }
}
```

- **Only your own actions.** `actionId` is written in your manifest namespace, `"{manifestId}.{id}"`, and names a `contributes.commands` entry or an action you register with `host.registerAction`. When you declare commands, the id must match one of them (`action_id_undeclared_command`); a built-in action or another plugin's is refused (`panel_menu_action_not_own`). A project plugin writes its manifest id too; the host moves the id into the instance's namespace for you.
- **At most five**, each action once (`panel_menu_duplicate_action`).
- **On a PTY-backed panel.** A `hasPty: true` panel renders as a terminal and keeps the terminal's right-click menu. Your entries appear on it after View terminal info, above your plugin's tour and settings. The terminal header's ⋯ menu does not show them. A PTY panel restored after a restart is an ordinary terminal and shows none of them.
- **Where they appear.** In their own group, directly above the host's entries for your plugin (below), in the order you declared them, each with the same generic plugin glyph — the entry names no icon.
- **When they appear.** An entry shows only while its action is registered, so an action you register late in `activate()`, or withdraw, comes and goes with it.
- **Label.** `label` is the menu text, 1–80 characters after trimming. Leave it out to use the action's `title`. End it with `…` when the action asks for more before it acts, as the host's own entries do.
- **Arguments.** The action is dispatched with `{ panelId }`, the id of the panel whose menu was used, the same `panelId` your view receives in `PanelViewProps`. If the action declares an `inputSchema`, it has to accept that property, or the dispatch fails validation. From the right-click menu, focus moves into that panel before the action runs, so a dialog it opens hands focus back there.
- **Danger.** The action's own danger tier applies: a `"confirm"` action asks first, as it does from the palette.

### Runtime menu entries

`menu` is fixed when the plugin loads. To offer entries that follow what the panel is showing (a selected row, an open record, a mode), publish them while the panel runs. A published list holds entries of the same shape, `{ actionId, label? }`, and they appear in the same group, after the manifest's `menu` entries.

There are two publishers, and both may be used at once:

- **The view** calls `setMenuItems(items)` from `PanelViewProps`, or uses the `usePanelMenuItems(props, items)` hook from `@daintreehq/plugin-sdk/react`, which republishes only when an entry changes.
- **The backend** calls [`host.setPanelMenuItems(panelId, items)`](./host-api.md#setpanelmenuitems). This is the only publisher a PTY-backed panel has, because it has no view.

```tsx
import { usePanelMenuItems } from "@daintreehq/plugin-sdk/react";

export default function LedgerView(props: PanelViewProps) {
  const selected = useSelectedRow();
  usePanelMenuItems(
    props,
    selected
      ? [
          { actionId: "acme.ledger.open-row", label: `Open ${selected.name}` },
          { actionId: "acme.ledger.delete-row" },
        ]
      : []
  );
  // …
}
```

```ts
// In the worker, for a PTY-backed panel it opened.
const opened = await host.dispatch("panel.openPluginPanel", { kind: host.panelKindId("server") });
if (opened.ok) {
  const { panelId } = opened.result as { panelId: string };
  await host.setPanelMenuItems(panelId, [
    { actionId: "acme.devserver.restart", label: "Restart server" },
  ]);
}
```

The rules match `menu` where they can:

- **Only your own actions**, written `"{manifestId}.{id}"`: a built-in action, another plugin's action, or a malformed id refuses the whole list. A project plugin writes its manifest id, and the host moves it into the instance's namespace.
- **At most five per publisher**, each action once. Labels are trimmed and cut at 80 characters. Leave a label out to use the action's `title`.
- **Order and duplicates.** The group lists the manifest's `menu` entries, then the view's list, then the backend's. An action already listed earlier in the group is not repeated.
- **When an entry appears.** It shows only while its action is registered, and only on a panel of a kind your plugin contributed. A list published for another plugin's panel is never drawn.
- **Replacing and clearing.** Each call replaces that publisher's whole list, and `null` or `[]` clears it. A menu that is open when you republish shows the new list straight away. Avoid republishing on every render while the user may be reading the menu.
- **Dispatch.** An entry dispatches its action with `{ panelId }`, through the action's own danger tier, exactly like a `menu` entry.
- **Lifetime.** The view's list belongs to the panel. It survives the view unmounting and remounting, and is cleared when the panel closes or is trashed, or the view reloads or crashes. The setter belongs to its attempt, like `setToolbarItemState`. The backend's list lasts until you clear it or the plugin unloads, and a restored window gets it back. Clear it when [`onDidChangePanelLifecycle`](./host-api.md#ondidchangepanellifecycle) reports the panel `removed`. Neither list is persisted across a restart.

The host's own entries never move: a published list cannot remove, reorder or rename any of them.

### Panel toolbar

`toolbar` puts up to three of your own actions in the panel's header, as buttons beside the window controls. Each entry is `{ "actionId", "label"?, "iconId"?, "status"? }`, and your view sets each button's live state while it runs:

```json
{
  "panels": [
    {
      "id": "ledger",
      "name": "Ledger",
      "iconId": "wallet",
      "color": "var(--theme-category-blue)",
      "toolbar": [
        {
          "actionId": "acme.ledger.refresh-quotes",
          "label": "Refresh prices",
          "iconId": "./icons/refresh.svg",
          "status": true
        }
      ]
    }
  ]
}
```

- **Only your own actions**, by the same rules as `menu`: written `"{manifestId}.{id}"`, matching a declared command when you declare any (`action_id_undeclared_command`), never a built-in or another plugin's (`panel_toolbar_action_not_own`). A project plugin writes its manifest id; the host moves it into the instance's namespace.
- **At most three**, each action once (`panel_toolbar_duplicate_action`). The same action may also sit in `menu`. A `hasPty: true` panel draws the terminal's header, so a `toolbar` on one is refused (`pty_panel_toolbar_unsupported`).
- **When they appear.** A button shows only while its action is registered, in declared order, ahead of the window controls.
- **Label and icon.** `label` (1–80 characters, trimmed) is the button's name and resting tooltip; leave it out to use the action's `title`. `iconId` takes the same generic plugin icon IDs as a panel's own `iconId` (`refresh-cw`, `download`, `filter` and the other verbs are there for toolbar actions), or a [custom SVG](#custom-icons) path; leave it out and the label is drawn as a text button, cut short on a narrow header with the full label on hover.
- **Status.** `status: true` draws a short status beside the button from its live state: the `text`, then "Updated 3h ago" from `updatedAt`, ticking on the host's shared clock. Without it those fields are ignored.
- **Arguments.** A click dispatches the action with `{ panelId }`, as a menu entry does, and the action's own danger tier applies.

**Live state.** Your view sets a button's state with `setToolbarItemState(actionId, state)` from `PanelViewProps`, naming the button by its `actionId` exactly as the manifest writes it. Each call replaces that button's state, and `null` resets it. Every field is optional:

| Field | Effect |
| --- | --- |
| `busy` | A spinner on the button, which ignores clicks until it is cleared. You rarely need it: the host already draws the button busy while its action's handler runs, whether the click came from the toolbar, the palette, a menu or a keybinding. Set it for work that outlives the handler. |
| `disabled` | Announced unavailable and ignores clicks. The button keeps its place in the tab order. |
| `text` | The status beside a `status: true` button ("2 prices kept from cache"). Cut to 120 characters. |
| `updatedAt` | Epoch ms or an ISO string, drawn as "Updated 3h ago". |
| `staleAfterMs` | Once `updatedAt` is older than this, the status turns to a warning (glyph and colour) on its own, with no further call. |
| `tone` | `"warning"` or `"danger"` adds that glyph and colour to the status; colour is never the only signal. An explicit tone, `"default"` included, wins over the stale warning. |
| `tooltip` | The button's tooltip when it says more than the label ("Prices fetched 14:02"). Cut to 120 characters. |

State belongs to the panel: it survives your view unmounting and remounting (a dock move, a tab switch) and is cleared when the panel closes, the view reloads or the view crashes. The setter belongs to its attempt like `setHasUnsavedChanges`, so a refresh that settles after a reload does nothing. An `actionId` the manifest doesn't list is ignored. The setter is absent on project surfaces, settings views and a panel shown as a dialog, none of which draws the toolbar. That absence is the contract: a view that also renders on one of those surfaces and still wants the control draws it itself when `setToolbarItemState` is missing (or when `usePanelToolbarItem` returns `false`). Its presence says only that the panel has a header: a button still shows only while its action is registered.

In React, `usePanelToolbarItem(props, actionId, state)` from `@daintreehq/plugin-sdk/react` keeps a button in step with your view. It sends the state on mount and whenever a field changes, resets the old button when `actionId` changes, leaves the state to the panel when the view unmounts (so it survives a tab switch or a move to the dock), and does nothing where the setter is absent. It returns `false` where the surface has no panel header, so the same view can fall back to an in-view control:

```tsx
import { usePanelToolbarItem } from "@daintreehq/plugin-sdk/react";

export default function LedgerView(props: PanelViewProps) {
  const { fetchedAt, cachedCount } = useQuotes();
  const inHeader = usePanelToolbarItem(props, "acme.ledger.refresh-quotes", {
    text: cachedCount > 0 ? `${cachedCount} prices kept from cache` : undefined,
    updatedAt: fetchedAt,
    staleAfterMs: 15 * 60_000,
  });
  // On a project surface there is no header, so draw the control in the view.
  // …
}
```

### Host entries on plugin panel menus

Every panel of a plugin carries some entries you never declare. The ⋯ menu and the right-click menu list the same groups, separated, in this order:

1. Layout: Move to worktree… where there is one to move to, Move to dock (or Move to grid from the dock), Maximize or Restore.
2. Rename panel and **Reload panel** — a fresh view attempt, the same one `requestReload` asks for; see [Views → Reloading a view](./views.md#reloading-a-view).
3. Your `menu` entries, then the [runtime entries](#runtime-menu-entries) your view and backend publish.
4. Your plugin's own entries, in this order, each only when it applies:
   - **<Panel name> Welcome Tour** — once a tour whose `panelKind` names this panel is registered (see [Tours](#tours--shipped)).
   - **Back up data…** — when the plugin declares any [database](#databases--shipped).
   - **Plugin settings…** — when the plugin declares any [settings](#settings-schema--shipped) field or a `location: "settings"` view. It opens whichever home those settings live in.
5. Send to background, Trash panel, Remove panel.

None of these needs wiring in your view, and none can be removed from a manifest.

**Component registration** is covered by the **views** contribution point below — panels declare the slot, views provide the component.

## Views — _Shipped_

Views are the React components a plugin renders. A `location: "panel"` view binds to a panel slot declared in `contributes.panels` by matching its bare `id`; at plugin load the matching panel kind gains a `componentPath` resolved to a `plugin://` URL. The renderer host (`PluginViewHost`) lazy-imports the module over Daintree's `plugin://` protocol and mounts it under an `ErrorBoundary` + `Suspense`. A `location: "settings"` view is the plugin's custom settings section instead, and a `location: "sidebar"` view one of the sidebar's views (both below). The contribution key is `views` (it was `experimental_views` until #10466 — the old key is still accepted as a deprecated alias that logs a warning). [Views: what you get in the DOM](./views.md) is the authoring guide.

```json
{
  "contributes": {
    "panels": [
      { "id": "dashboard", "name": "Cost Dashboard", "iconId": "gauge", "color": "#5b8def" }
    ],
    "views": [
      {
        "id": "dashboard",
        "componentPath": "./dist/dashboard.js",
        "location": "panel"
      }
    ]
  }
}
```

**A settings view** — `location: "settings"` is the one exception to the pairing below. It names no panel: its `id` may not match a panel's (`settings_view_panel_id_collision`), a plugin declares at most one (`settings_view_duplicate`), and a surface can't claim it (`surface_view_ref_settings`). The host mounts it in the plugin's settings home, below the generated [settings](#settings-schema--shipped) fields, with `settingsContext` and without the panel-record props. See [Settings → A custom section](#a-custom-settings-section) and [Views → A settings section](./views.md#a-settings-section).

**A sidebar view** — `location: "sidebar"` puts the view in the sidebar, beside the built-in worktree list (the workspace, in a folder without git). Like a settings view it names no panel: its `id` may not match a panel's (`sidebar_view_panel_id_collision`) and neither a surface nor a toolbar popover can claim it (`surface_view_ref_sidebar`, `toolbar_popover_view_sidebar`). A plugin may declare several.

```json
{
  "contributes": {
    "views": [
      {
        "id": "board",
        "componentPath": "./dist/board.js",
        "location": "sidebar",
        "name": "Board",
        "iconId": "list",
        "priority": 10,
        "when": "isGitBacked"
      }
    ]
  }
}
```

- **The switcher.** While at least one plugin sidebar view applies to the project, the sidebar's heading becomes a dropdown listing every view, highest `priority` first, each plugin's entry attributed to the plugin. With none, the heading stays a plain title. The worktree list is always in the list, and its entry keeps the count of agents waiting on the user while a plugin view shows.
- **Priority.** An integer from `-1000` to `1000`, default `0`. The worktree list's priority is fixed at `0` and it wins a tie, so a view lists above it only with a positive priority; views that tie each other sort by id. Priority orders the list and nothing else: the sidebar opens on the worktree list until the user picks a view.
- **The choice** is remembered per project. If the chosen view stops applying (its plugin stops, is hidden in this project, or its `when` turns false), the sidebar shows the worktree list until the view applies again, then returns to it.
- **`when`** is evaluated live against the [project keys](#keybindings--shipped) and your plugin's own [`host.setContext`](./host-api.md#setcontext) keys. It may not read `activeSidebarView` (`sidebar_view_when_reads_active_view`): which view shows is decided from which ones apply.
- **`activeSidebarView`** names the view showing: `<manifest name>.<view id>` for an installed plugin's view, `project:<manifest name>.<view id>` for a project plugin's (an installed and a project copy of one plugin can both load, and each keeps its own entry). The `ui.sidebar.switchView` action takes the same id.
- **What the view gets.** The standard view props and error boundary, with `hostContext.kind === "sidebar"`, mounted in the region below the header. The header holds only the switcher, so draw your own controls inside the view, and lay it out for the sidebar's minimum width of 200px. When the view fails, its error pane offers **Show worktrees** beside **Try again**. A right-click inside the view reaches the view and never opens the sidebar's own menu. The view unmounts when the user switches away, which fires `disposeSignal`.

**Pairing with `contributes.panels`** — a panel view binds to a panel by matching its bare `id` (pre-namespace) to a panel `id`. A view whose `id` matches no panel is rejected at manifest validation (`view_panel_ref_unknown`) — it would otherwise never render, so it's a hard load error rather than a silent runtime skip. A view targeting a panel with `hasPty: true` is skipped — PTY panels render through `TerminalPane` and cannot host a plugin module.

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | For a panel view, the panel `id` it provides a component for; for a settings or sidebar view, an id of its own. Letters, digits, `.`, `_` and `-`, at most 64 characters. |
| `componentPath` | yes | POSIX-relative path to an ESM module inside the plugin (`.js` or `.mjs`). The module's default export is a React component. Absolute paths, backslashes, URL schemes, `?`, `#` and `..` segments are rejected at manifest validation. |
| `location` | yes | `"panel"` (rendered in the panel of the same id, in the grid, the dock or a dialog), `"settings"` for the plugin's custom settings section, `"fileEditor"` for a view that backs a [file editor](#file-editors--shipped), or `"sidebar"` for a sidebar view. |
| `iconId` | no | A sidebar view's glyph in the switcher: a plugin icon id or a `./…svg` [custom icon](#custom-icons). On a panel or settings view it is accepted for compatibility but **ignored at runtime** — the matching `contributes.panels` entry owns the rendered icon. |
| `name` | sidebar only | The sidebar view's name in the switcher and the header, at most 40 characters. Required for a sidebar view. |
| `priority` | sidebar only | Integer from `-1000` to `1000`, default `0`; orders the switcher against the worktree list's `0`. |
| `when` | sidebar only | Shows the view only while the expression holds. |

The view schema is strict and carries no `description`, and a panel or settings view takes no `name`, `priority` or `when`: the matching panel is the single source of truth for a panel view's display metadata, so those fields were removed (#10888) rather than validate values the runtime ignores. A sidebar view has no panel to borrow them from, so it carries its own.

**Bundling** — the host serves the module as-is and compiles nothing, so a view is either hand-written browser ESM (the zero-build path: `createElement`, no JSX, bare imports limited to the host import map) or a bundle `@daintreehq/plugin-vite` produces with the right externals for sharing the host's React 19. See [Views → Getting data in](./views.md#getting-data-in) for what the import map serves and [Architecture → Renderer host](./architecture.md#renderer-host) for the internals.

**Component contract:**

> **Both kinds of view get the hooks.** `useHostChannel`, `usePluginEvent`, `usePluginPanelEvent` and the rest of `@daintreehq/plugin-sdk/react` (see [Host API → React hooks](./host-api.md#react-hooks--daintreehqplugin-sdkreact)) work in a view bundled with `@daintreehq/plugin-vite`, which bundles the SDK version you pinned, and in a raw, un-bundled `plugin://` view, where the host import map serves `@daintreehq/plugin-sdk/react` from the host's own copy (a raw-only specifier: the build preset never externalizes it). The import map serves nothing else from the SDK: the root `@daintreehq/plugin-sdk`, `/files` and `/data` are for the worker. The hooks wrap the `window.electron.plugin.on(pluginId, channel, cb)` / `.invoke(pluginId, channel, …args)` bridge, which a hand-authored view can also call directly (the raw-ESM example follows the bundled one below). There are no hooks for worktrees, settings or commands: a view reads its own worktree from the `worktreeId` prop, and anything else — settings values, worktree details, data — comes from your worker over a channel.

```tsx
// src/dashboard.tsx
import { useEffect, useState } from "react";
import type { PanelViewProps } from "@daintreehq/plugin-sdk";
import { usePluginEvent } from "@daintreehq/plugin-sdk/react";

export default function Dashboard({ panelId, pluginId, disposeSignal }: PanelViewProps) {
  const [worktreeName, setWorktreeName] = useState<string | null>(null);
  // The plugin's main side pushes worktree context with host.postToPanel("worktree", …).
  usePluginEvent<{ name: string }>(pluginId, "worktree", (wt) => setWorktreeName(wt.name));

  useEffect(() => {
    const controller = new AbortController();
    // Chain the host signal so the fetch aborts on unmount AND when the
    // host receives a `plugin:panel-kinds-changed` push that no longer
    // contains this kind — before main tears down plugin IPC handlers.
    const onAbort = (): void => controller.abort();
    disposeSignal.addEventListener("abort", onAbort);
    void fetch(`plugin://${pluginId}/api/cost-summary`, { signal: controller.signal });
    return () => {
      disposeSignal.removeEventListener("abort", onAbort);
      controller.abort();
    };
  }, [pluginId, disposeSignal]);

  return <div data-panel-id={panelId}>Dashboard for {worktreeName ?? "no worktree"}</div>;
}
```

The same view as a **raw ESM module** (loaded verbatim by `plugin://`, no `@daintreehq/plugin-vite` bundling). It could import `usePluginEvent` from `@daintreehq/plugin-sdk/react` through the import map just as well; this version subscribes through the host bridge the hook wraps. Because nothing transpiles the file, it ships as valid browser ESM: the bare `react` specifier resolves through the host import map, and `createElement` avoids any JSX transform. `window.electron.plugin.on(pluginId, channel, cb)` returns an unsubscribe function; return it from the effect for cleanup.

```js
// src/dashboard.js — raw ESM variant, served as-is over plugin://
import { createElement, useEffect, useState } from "react";

export default function Dashboard(props) {
  const { panelId, pluginId } = props;
  const [worktreeName, setWorktreeName] = useState(null);
  useEffect(() => {
    // Same payload host.postToPanel("worktree", …) pushes; usePluginEvent wraps this.
    const off = window.electron.plugin.on(pluginId, "worktree", (wt) => setWorktreeName(wt.name));
    return off;
  }, [pluginId]);
  return createElement(
    "div",
    { "data-panel-id": panelId },
    `Dashboard for ${worktreeName ?? "no worktree"}`
  );
}
```

| Prop | Type | Notes |
| --- | --- | --- |
| `panelId` | `string` | Runtime id of this panel instance. Useful as a key for plugin-local panel-scoped state, and the routing key for per-instance pushes: the plugin's main side targets one instance with `host.postToPanel(channel, payload, panelId)` (omit or pass `null` to broadcast to every instance of the kind). To receive only the targeted pushes, subscribe with `usePluginPanelEvent(pluginId, channel, panelId, cb)` (or raw `plugin.onPanel(pluginId, channel, panelId, cb)`) and pass this prop. `usePluginEvent` / `plugin.on` receive broadcast pushes, not per-instance ones. |
| `pluginId` | `string` | The host-side plugin identifier, taken from the panel kind's `extensionId`: the bare manifest `name` for an installed or builtin plugin, but the instance key `project__{projectId}__{manifestId}` for a project plugin. Pass it through to `window.electron.plugin.*` and the SDK hooks unchanged — a view that substitutes its own manifest name addresses nothing under project scope. Stable for the lifetime of the host, so it still serves for namespacing storage keys and log lines. |
| `worktreeId` | `string` \| `undefined` | The worktree the panel was spawned with, as recorded on the panel record. Read this rather than dispatching `worktree.getCurrent`, which answers for the _visible_ worktree and is wrong for a background or restored panel. `undefined` for a panel spawned without a worktree. |
| `disposeSignal` | `AbortSignal` | Lifetime of **this mounted view attempt**. Aborts on unmount, on "Try again", on an accepted `requestReload`, and when the host receives a `plugin:panel-kinds-changed` push that omits this kind. The broadcast fires before main tears down plugin IPC handlers, so signal-driven cleanup runs while host APIs are still live. A **temporary** unmount aborts it too — maximizing a sibling pane or leaving a dock tab. Switching to another project does not: the view stays mounted and the signal stays open. On unmount it aborts just after React has run your effect cleanups, so a cleanup may still see it open. Tie only view-scoped work to it. |
| `panelRemovedSignal` | `AbortSignal` | Lifetime of **the panel record**. The same object is handed to every mount of a given `panelId`, so it survives remounts, retries, trash-then-restore, and plugin upgrades. Aborts exactly once, when the panel is permanently removed. |
| `initialArgs` | `Record<string, unknown>` \| `undefined` | The argument bag the panel was spawned with — set when the panel is opened via the `panel.openPluginPanel` action's `initialArgs` (e.g. dispatched from a context menu with a file path) — merged with whatever the view has since persisted through `persistState`. It rides the panel's save/restore-surviving extension state, so a restored panel comes back the way the user left it. A snapshot taken at mount, not a live value: it does not update while the view is mounted, including in response to your own `persistState` calls. `undefined` when the panel was opened without args and has persisted nothing. |
| `openRequest` | `{ seq: number; args: Record<string, unknown> }` \| `undefined` | The latest `panel.openPluginPanel` call that reused this panel instead of spawning one, with the `initialArgs` it passed. Live: a mounted view re-renders with each new request, and one made while no view is mounted waits for the next mount, latest call wins. `seq` is new on every call. A request a view has committed with is not replayed by a later remount or reload. It is never persisted or merged into `initialArgs`, and one still waiting when the project's window reloads or is evicted is lost. See [Open your own panel from a command](./patterns.md#open-your-own-panel-from-a-command). |
| `stateVersion` | `number` \| `undefined` | Which version of your declared state shape `initialArgs` holds: the panel's `stateVersion` when the bag was written, `0` for a bag that predates versioning, absent when you declare no `stateVersion`. See [panel state versioning](#panels--shipped). |
| `persistState` | `(patch: Record<string, unknown>) => boolean` \| `undefined` | Writes view state back onto the panel record, so the next mount sees it in `initialArgs`. The two are one bag: spawn seeds it, this updates it, `initialArgs` reads it back — which is what lets a view survive the teardowns a panel routinely outlives (maximizing a sibling pane, leaving a dock tab, a project view reclaimed under memory pressure, a restart) without forgetting where the user was. The patch is **merged**, so independent parts of a view can each persist their own key; a key set to `undefined` is removed. An unchanged write is free — it neither churns the store nor schedules a save — so calling it from a render-derived effect is fine. Keep it small: the host refuses an update whose serialized form exceeds 64KB, and anything larger, not JSON round-trippable, or that should outlive the panel belongs in `host.storage`. Returns `true` when the stored state now matches what you asked for (applied, or already identical) and `false` when the host rejected the write — the merged bag would exceed 64KB, or it is not JSON-serializable (a cyclic value, a `BigInt`, a throwing `toJSON`). `true` means accepted and scheduled, not flushed: the layout save is debounced. |
| `requestReload` | `() => void` \| `undefined` | Ask the host to discard this view attempt and mount a fresh one for the same panel, without restarting the backend. The current `disposeSignal` aborts and React cleanup runs; the next attempt gets a new `disposeSignal` and the latest accepted `persistState` bag as `initialArgs`, while `panelId`, `panelRemovedSignal` and the backend carry over. The module is reused, so module globals, document-wide registrations and anything on `window` survive — a reload frees only what your cleanup releases, and cannot rescue a blocked renderer. A request, not a command: the host may refuse it, reports no completion, and merges calls in the same tick. A callback held past its own attempt does nothing. A fourth reload within 30 seconds of three accepted ones stops the view until the user reloads the panel. Absent on project surfaces and settings views. See [Views → Reloading a view](./views.md#reloading-a-view). |
| `setHasUnsavedChanges` | `(hasUnsavedChanges: boolean) => void` \| `undefined` | Tell the host whether the view holds work a reload or a close would lose. The user and agents can reload a plugin panel without being asked, since persisted state comes back; while this is `true`, they are asked to confirm first, and so is the user closing the panel. Your own `requestReload` is never held up by it. The setter belongs to its attempt, so one held past its teardown does nothing, and a new attempt starts with nothing unsaved. Absent where the host offers no reload. See [Views → Reloading a view](./views.md#reloading-a-view). |
| `setMenuItems` | `(items: readonly { actionId: string; label?: string }[] \| null) => void` \| `undefined` | Publishes the contextual actions the panel's ⋯ and right-click menus offer right now, after the manifest's `menu` entries. Each call replaces the list; `null` or `[]` clears it. The list survives the view remounting and is cleared when the panel closes or the view reloads. Belongs to its attempt. Absent on project surfaces, settings views and a panel shown as a dialog. See [Runtime menu entries](#runtime-menu-entries). |
| `setTitle` | `(title: string \| null) => void` \| `undefined` | Names this panel: its tab, header, dock chip and dialog title. `null` or a blank title goes back to the kind's `name`. The title belongs to the panel: it survives remounts and reloads, a grid or dock panel keeps it across a restart, and a dialog keeps it until it closes. A rename by the user wins. Control and invisible formatting characters become spaces, and the title is cut at 80 characters. Only ever titles this panel. Belongs to its attempt. Absent on project surfaces and settings views. |
| `setToolbarItemState` | `(actionId: string, state: PluginPanelToolbarItemState \| null) => void` \| `undefined` | Set the live state of one of the panel's manifest `toolbar` buttons: busy, disabled, a status line, an "Updated" age and its tone. Each call replaces that button's state; `null` resets it. State survives the view remounting and is cleared when the panel closes or the view reloads. Belongs to its attempt, like `setHasUnsavedChanges`. Absent on project surfaces, settings views and a panel shown as a dialog. See [Panel toolbar](#panel-toolbar). |
| `runningActions` | `readonly string[]` \| `undefined` | Your actions whose handlers are running now, by `actionId` as the manifest writes it, however they were dispatched (palette, menu, panel toolbar, keybinding, agent). A new array when the set changes, so the view re-renders as a run starts and ends, and a view mounting mid-run sees it at once. Read one action with `useActionRunning(props, actionId)` from `@daintreehq/plugin-sdk/react`. |
| `styleRootAttributes` | `Readonly<Record<string, string>>` | Spread onto any container you render through `createPortal`, so the runtime-compiled Tailwind classes inside it still apply. See [Views → Styling](./views.md#styling). |
| `settingsContext` | `{ scope: "user" \| "project"; projectId: string \| null }` \| `undefined` | Present only on a `location: "settings"` view: which settings home it is mounted in. `projectId` is `null` in the `"user"` home. See [A custom settings section](#a-custom-settings-section). |

The view is wrapped in an error boundary by the host. An unhandled render error shows a diagnostics pane with "Try again" — which mounts a fresh attempt, and after a failed import loads the view from a new URL, since the failed module stays cached under the old one — alongside "Close panel", "Copy diagnostics", and "View logs".

### Which signal to use

A panel outlives its views. Maximizing a different pane unmounts every other grid panel, so `disposeSignal` fires for a teardown the user experiences as "I'll be right back", identically to one they experience as "I'm done with this". Deciding deletion from `disposeSignal` alone is how a plugin ends up killing a running dev-server session because the user maximized a neighbouring pane.

- **View-scoped work** — in-flight `fetch`es, DOM observers, `postToPanel` subscriptions, timers driving the UI → `disposeSignal`.
- **Panel-scoped work** — anything that should survive being backgrounded but not survive the panel itself → `panelRemovedSignal`.
- **Durable resources** — spawned processes, long-lived sessions, anything expensive to restart → keep them in the **worker** and release them from `host.onDidChangePanelLifecycle` on the `"removed"` phase. The worker observes the panel across every remount; the view cannot, because it is gone during exactly the teardown that matters. See [Host API → `onDidChangePanelLifecycle`](./host-api.md#ondidchangepanellifecycle).

### Worker reload vs. view-module replacement

These are two different reloads, and a plugin author debugging "my change didn't show up" is usually confusing them:

- **Worker reload** replaces the plugin's _backend_ Realm. `activate()` runs again against a fresh module graph, so edits to your main entry take effect on the next reload.
- **View-module replacement** is the _renderer_ half. Chromium caches ESM module records by URL with no eviction API, so re-importing the same `plugin://` specifier returns the module already in memory no matter how thoroughly the panel remounts.

Daintree bridges the gap by stamping a per-load generation into the view URL — `plugin://<authority>/__dtv-<n>/dist/view.js`. The authority is an opaque per-load token (`pi-` plus 32 hex characters). The host also seeds the plugin's **host-side id** into the same resolver map as an alias, which is what keeps a hand-written `plugin://<pluginId>/…` URL working — including the example above. That id is your manifest id for an installed plugin, but for a project-local plugin it is the instance key (`project__{projectId}__{manifestId}`), so use the `pluginId` you were handed in `PanelViewProps` rather than hardcoding your manifest name. Both keys are dropped on unload. Every time the plugin is **loaded** — an install, a replacement install, an enable, or an app start — it mints a new `<n>`, which is a specifier the renderer has never imported, so the new bundle is genuinely fetched and evaluated. Open panels remount onto it automatically; no Force Reload, and no need to hand-version your bundle filename each release.

A `daintree-plugin dev` rebuild is a full load like any other (#12277): once the artifact settles the host re-enters the same load path, re-registering every contribution and minting a new `__dtv-<n>`, so an open panel imports a specifier the renderer has never seen and picks up view edits along with the backend they shipped with. No disable/enable, reinstall, or Force Reload is needed mid-session.

Two consequences worth knowing. Relative imports inside your entry module inherit the generation namespace (they resolve against the entry's URL), so multi-chunk bundles refresh as a unit — but an **absolute** `plugin://` import you write by hand does not, and will keep resolving to the first version imported in that session. And because each generation is a distinct module record, a long dev session with many reloads accumulates them in the renderer's memory; that is bounded by how many times you reloaded, and a window reload clears it.

The `__dtv-<n>` segment is virtual — it never exists on disk, and the protocol handler strips it before resolving your file. Treat `__dtv-` as a reserved top-level directory name.

## Toolbar buttons — _Shipped_

Toolbar buttons dispatch an existing action from the main toolbar, or open an anchored popover holding one of your own views.

Every contributed button is collected into the **plugin tray** — a single toolbar button, grouped by plugin — rather than claiming its own top-level slot. A user can promote any individual button to its own toolbar slot from the tray (hover the row and click the pin, or press <kbd>P</kbd>) or from Settings → Toolbar; a promoted button keeps its tray row as well. Placement is the user's call, not the manifest's: there is no field that requests a top-level slot.

```json
{
  "contributes": {
    "toolbarButtons": [
      {
        "id": "plan-button",
        "label": "Plan",
        "iconId": "list",
        "actionId": "acme.linear-planner.plan-from-issue",
        "priority": 3
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}` — matches the convention used by every other contribution surface. |
| `label` | yes | Hover tooltip. |
| `iconId` | yes | One of the shared plugin icon IDs listed in `shared/config/pluginIconIds.ts` — the same set panels use — or a [custom SVG](#custom-icons) inside your plugin (`"./icons/flutter.svg"`). An unrecognized ID falls back to a generic puzzle glyph; `daintree-plugin validate` warns about it. Agent brand IDs (e.g. `claude`) don't resolve here. |
| `actionId` | one of `actionId`, `popover` or `menu` | Fully-qualified action ID, including plugin namespace. Built-in actions (e.g. `terminal.new`) also work. |
| `popover` | one of `actionId`, `popover` or `menu` | `{ "viewId": "<view id>" }` — open a popover showing that view instead of dispatching an action. See below. |
| `menu` | no | Up to five of your own actions, `[{ "actionId": "acme.sync.pull", "label": "Pull" }]` (`label` defaults to the action's title). With an `actionId` the button is a split button: the click runs the action and a chevron opens the menu. On its own it is a menu button. In the tray and the overflow menu it is a submenu. See below. |
| `priority` | no | `1`–`5`, lower = earlier. Orders your buttons within your plugin's tray group. Default `3`. |
| `when` | no | Context expression deciding whether the button shows, evaluated live. |

### Showing a button only when it applies

While a button's `when` is false it leaves both the plugin tray and the toolbar, and the overflow menu with them. Nothing about it is forgotten: a button the user promoted comes back in the slot they gave it as soon as the clause is true again. Settings → Toolbar still lists it, so the user can arrange it at any time.

The clause sees the [project keys](#keybindings--shipped) (`isGitBacked`, `workspaceKind`, `activeSidebarView`, `presentation*`) and the keys plugins publish with [`host.setContext`](./host-api.md#setcontext), under each plugin's manifest name, and is re-evaluated whenever one of them changes. An identifier that names no key is false, and an expression that fails to parse hides the button. A `when` only decides whether the button shows: the action stays reachable from the palette and keybindings.

```json
{
  "id": "sync",
  "label": "Sync",
  "iconId": "refresh-cw",
  "actionId": "acme.notes.sync",
  "when": "isGitBacked && acme.notes.signedIn"
}
```

To show state on a button rather than hide it — a toggle that is on, a reason it can't run, work in progress — use [`host.setToolbarButtonState`](./host-api.md#settoolbarbuttonstate).

A button declares `actionId` or `popover`, not both (`toolbar_button_behavior_conflict`), or it carries a non-empty `menu` instead; none of the three fails validation (`toolbar_button_behavior_missing`).

A `menu` lists your own actions only — a built-in or another plugin's id fails (`toolbar_button_menu_action_not_own`), as does a repeat (`toolbar_button_menu_duplicate_action`) or a popover button that also declares one (`toolbar_button_menu_popover_conflict`). Each entry shows while its action is registered and dispatches on its own, with nothing from your plugin. Replace the list at runtime with the `menu` field of [`host.setToolbarButtonState`](./host-api.md#settoolbarbuttonstate).

**Popovers.** For an inbox, a recent-items list or a quick-add form, name one of your views instead of an action:

```json
{
  "contributes": {
    "panels": [{ "id": "inbox", "name": "Inbox", "iconId": "list", "color": "#7c3aed" }],
    "views": [{ "id": "inbox", "componentPath": "dist/inbox.js", "location": "panel" }],
    "toolbarButtons": [
      { "id": "inbox-button", "label": "Inbox", "iconId": "list", "popover": { "viewId": "inbox" } }
    ]
  }
}
```

`viewId` names a `location: "panel"` view whose panel is not `hasPty` (`toolbar_popover_view_unknown`, `toolbar_popover_view_settings`, `toolbar_popover_view_sidebar`, `toolbar_popover_view_file_editor` and `toolbar_popover_view_pty` otherwise). The same view stays spawnable as a panel. The host draws the popover itself — 450 by up to 500 pixels, clamped to the room on screen — anchored under the promoted button, or under the plugin tray or the toolbar's overflow menu when the button is picked from one of their rows. It stays open while a dialog, menu or picker your view opened is up, and closes on Escape or a click outside; closing it from inside hands focus back to the button that opened it. Only one plugin popover is open at a time. Your view mounts fresh on each opening, with `hostContext.kind` set to `"popover"` and `hostContext.close()` to dismiss it, after a quick-add submits for example. Like a project surface, it has no panel record behind it, so `persistState`, `initialArgs` and the other panel-record props are absent. A popover button takes `when` and [`host.setToolbarButtonState`](./host-api.md#settoolbarbuttonstate) like any other: a disabled or busy one doesn't open, and an open popover closes when its button's `when` turns false. Works the same for installed and project plugins.

## Launch entries — _Shipped_

Launch entries are rows in the launcher: the dock's `+`, its right-click menu, the grid's right-click menu and the toolbar launcher. Each entry opens one of your panels (with arguments, where you choose), runs one of your commands, or starts an agent with a first prompt.

Your entries form one group under your plugin's name, below the panels and above the recipes. They are searchable like every other row, and the user can pin any of them to its own toolbar button. The host draws every row from the manifest; a plugin can't draw its own. A user can hide your group in one project from the group's last row, **Hide in this project**, and bring it back from Project settings → Plugins.

```json
{
  "contributes": {
    "panels": [{ "id": "records", "name": "Records", "iconId": "database", "color": "#0ea5e9" }],
    "commands": [
      {
        "id": "publish",
        "title": "Publish site",
        "description": "Publish the records site",
        "category": "records",
        "kind": "command",
        "danger": "confirm"
      }
    ],
    "launchEntries": [
      {
        "id": "new-record",
        "label": "New record…",
        "iconId": "plus",
        "description": "Open Records on an empty form",
        "priority": 1,
        "panel": { "id": "records", "args": { "mode": "new" }, "placement": "dialog" }
      },
      {
        "id": "publish",
        "label": "Publish site",
        "iconId": "upload",
        "command": { "actionId": "acme.records.publish" }
      },
      {
        "id": "chat",
        "label": "Chat with the records agent",
        "iconId": "bot",
        "agent": { "id": "claude", "prompt": "Read RECORDS.md, then wait for my question." }
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}`. It also keys a pinned toolbar button, so renaming it unpins the entry. |
| `label` | yes | The row's text, up to 80 characters. Write it as the action: "New record…", "Publish site". |
| `iconId` | yes | A shared plugin icon id, the same set panels use, or a [custom SVG](#custom-icons). |
| `description` | no | Up to 200 characters, shown as the row's tooltip and searched. |
| `priority` | no | `1`–`5`, lower = earlier within your group. Default `3`; ties keep manifest order. Groups themselves are ordered by plugin name. |
| `when` | no | Context expression deciding whether the row shows, evaluated live like a [toolbar button's](#showing-a-button-only-when-it-applies). A pinned entry's button follows it. |
| `showInEmptyState` | no | `true` also lists the entry as a tile in a "From {your plugin}" band of the stock empty-canvas launcher, below the recipes. Default `false`. Tiles follow `priority` and `when`; hiding your group in a project hides the band too. The band doesn't appear while your own `emptyCanvas` surface replaces the stock launcher. |
| `panel` | one of `panel`, `command`, `agent` | `{ "id", "args"?, "placement"? }`. `id` names one of your own `contributes.panels`. `args` (at most 8 KB of JSON) reaches the view as `initialArgs`, or as `openRequest` when an open panel of that kind is reused. `placement` is `"dock"`, `"grid"` or `"dialog"`; without it the panel opens where that launcher opens panels, and a `scope: "project"` panel in the dock. |
| `command` | one of `panel`, `command`, `agent` | `{ "actionId", "args"? }`. `actionId` must be one of your own actions, written `{manifest name}.{id}`; when you declare `contributes.commands` it must name one of them. `args` (at most 8 KB of JSON) is passed to the action. |
| `agent` | one of `panel`, `command`, `agent` | `{ "id", "prompt" }`. Starts that agent with `prompt` as its first turn, up to 4,000 characters. Nothing else about the launch is yours to choose — no flags, environment or preset — and a prompt starting with `-` is refused. The agent lands where that launcher puts agents and uses the user's own preset. If no agent with that id is registered, the row is shown disabled. |

An entry declares exactly one target (`launch_entry_target_missing`, `launch_entry_target_conflict`). A target outside your own plugin fails validation: a command in another namespace or a built-in action (`launch_entry_command_not_own`), a panel you don't declare (`launch_entry_panel_unknown`). So does a placement the panel can't take — the grid for a `scope: "project"` panel, the dock for `dockable: false`, a dialog for `hasPty: true` (`launch_entry_panel_placement`) — and `args` for a PTY-backed panel, which has no view to receive them (`launch_entry_panel_args_pty`). A plugin may declare at most 20 entries.

Declaring an entry for one of your panels replaces that panel's own row in the launcher, even while the entry's `when` is false or its group is hidden, so the panel is never listed twice. A panel no entry targets keeps its plain row.

Entries are user-only. They run when the user picks the row or presses its pinned button, never from the command palette, an MCP client or an agent; those reach the same panels, commands and `agent.launch` through their own routes and confirmations.

## Layouts — _Shipped_

A layout is a named arrangement of your panels, browser pages and recipes: "Records on the left, an agent beside it, the preview docked". The user applies one from the command palette, where each layout is a row titled **Apply layout: {name}**, and your own commands can apply yours with `host.dispatch("layout.apply", { layoutId: "workspace" })`.

```json
{
  "contributes": {
    "panels": [
      { "id": "records", "name": "Records", "iconId": "database", "color": "#0ea5e9" },
      { "id": "notes", "name": "Notes", "iconId": "file-text", "color": "#0ea5e9" }
    ],
    "recipes": [
      {
        "id": "agent",
        "name": "Records agent",
        "terminals": [{ "type": "claude", "initialPrompt": "Read RECORDS.md." }]
      }
    ],
    "layouts": [
      {
        "id": "workspace",
        "name": "Records workspace",
        "entries": [
          { "panel": "records", "tabGroup": "main", "maximized": true },
          { "panel": "notes", "tabGroup": "main" },
          { "recipe": "agent" },
          { "browser": "http://localhost:3000", "location": "dock" }
        ]
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}`. Your commands may pass either form to `layout.apply`. |
| `name` | yes | Up to 80 characters; the palette row and the confirmation dialog show it. |
| `entries` | yes | 1–12 entries, opened in order. |
| `entries[].panel` | one of `panel`, `browser`, `recipe` | One of your own `contributes.panels`. A panel of that kind already open in the worktree (or anywhere, for a `scope: "project"` panel) is reused rather than opened again. A `hasPty: true` panel is refused: terminals come from recipes. |
| `entries[].browser` | one of `panel`, `browser`, `recipe` | An `http:` or `https:` URL, opened in a browser panel. A browser panel already showing that page is reused. The browser still asks before loading a host the user hasn't approved. |
| `entries[].recipe` | one of `panel`, `browser`, `recipe` | One of your own `contributes.recipes`. Its terminals start in the active worktree, every time the layout is applied. |
| `entries[].location` | no | `"grid"` or `"dock"`. Default `"grid"`, or `"dock"` for a `scope: "project"` panel. A recipe puts all its terminals there; split a recipe in two to place its terminals apart. |
| `entries[].tabGroup` | no | Entries sharing a key become the tabs of one group, in entry order. A group needs at least two panels in one place, and `scope: "project"` panels group only with each other. |
| `entries[].maximized` | no | Maximizes the entry's panel, or its tab group, in the grid. At most one per layout. |

Applying a layout is additive. It opens what's missing and moves, groups and maximizes what it lists; a panel it doesn't list is never closed, killed or moved. **Undo layout change** (`layout.undo`) puts back everything the layout moved in one step and drops the groups it made. Panels and terminals it opened stay open.

A layout that runs a recipe never starts it silently. Before anything opens or moves, the user sees a confirmation listing every terminal the recipes start, as the recipe confirmation lists them, and the layout applies only if they approve. A command that applies such a layout gets `{ "status": "awaiting-confirmation" }` back at once rather than waiting on the dialog. A recipe that changed after the user approved it doesn't start, and neither does one a team recipe of the same name now shadows.

Your commands can apply only your own layouts, and MCP clients and agents can't apply layouts at all. Validation refuses an entry with no target or several (`layout_entry_target_missing`, `layout_entry_target_conflict`), a panel or recipe you don't declare (`layout_panel_unknown`, `layout_recipe_unknown`), a PTY panel (`layout_panel_pty`), a placement the panel can't take (`layout_panel_placement`), the same panel, recipe or page twice (`layout_entry_duplicate`), a second or docked maximize (`layout_maximized_invalid`), and a tab group split between grid and dock, mixing project and worktree panels, or holding one panel (`layout_tab_group_location`, `layout_tab_group_scope`, `layout_tab_group_single`). A plugin may declare at most 20 layouts. An entry naming a recipe Daintree couldn't register, because none of its terminals passed the recipe checks, is dropped from the layout when the plugin loads.

## Search providers — _Shipped_

A search provider makes your plugin's content findable from the quick switcher (`⌘P` / `Ctrl+P`). Typing the provider's `keyword` and pressing Tab scopes the switcher to it: the field shows a chip with your `title`, and every keystroke after that asks your provider. With `blend: true` it also adds a few results below the built-in ones in the unscoped search. Backspace on an empty field, or Escape once the query is clear, steps back out.

The host draws every result from data you return: a label, a description, an icon, and a target that is one of your own panels or commands with small arguments. Picking a result opens a panel through `panel.openPluginPanel` — an open panel of that kind is reused and receives the result's args as `openRequest` — or dispatches the command with them.

```json
{
  "contributes": {
    "panels": [{ "id": "notes", "name": "Notes", "iconId": "notebook", "color": "#0ea5e9" }],
    "databases": [
      {
        "id": "notes",
        "location": "local",
        "queries": [
          {
            "name": "find_notes",
            "mode": "read",
            "description": "Notes whose title matches.",
            "params": { "q": { "type": "string", "maxLength": 200 } },
            "sql": "SELECT id, title AS label, folder AS description, json_object('noteId', id) AS args FROM notes WHERE title LIKE '%' || :q || '%' ORDER BY updated_at DESC LIMIT 20"
          }
        ]
      }
    ],
    "searchProviders": [
      {
        "id": "notes",
        "kind": "declarative",
        "title": "Notes",
        "keyword": "notes",
        "iconId": "notebook",
        "blend": true,
        "query": "find_notes",
        "target": { "panel": "notes" }
      },
      { "id": "people", "kind": "runtime", "title": "People", "keyword": "people" }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}`. The user's "Show in quick switcher" choice is stored under it. |
| `kind` | yes | `"declarative"` or `"runtime"` — see below. |
| `title` | yes | Up to 80 characters. The scope chip, the scoped placeholder ("Search Notes") and the Settings row. |
| `keyword` | yes | 1–24 lowercase letters, digits or `-`, starting with a letter. The palettes' prefix characters (`>`, `@`, `#`, `:`, `/`) can never be part of one. |
| `iconId` | no | A shared plugin icon id or a [custom SVG](#custom-icons) for results that carry none. Default `search`. |
| `blend` | no | `true` also adds results to the unscoped search. Default `false`. |
| `query` | declarative only | The `name` of one of your `databases[].queries`. It must be `mode: "read"` and declare exactly one param, of type `"string"`, which receives what the user typed. |
| `target` | declarative: yes; runtime: no | `{ "panel": "<panel id>" }` or `{ "command": "<manifest name>.<id>" }`. Where results open; for a runtime provider, the default for results without their own. |

**Declarative providers** answer without your plugin running. The host binds what the user typed to the query's one param and runs the statement read-only in the same child process an agent's declared query uses, so an expensive statement costs that process, never Daintree. Rows are read by column name — alias your columns to match:

| Column | Required | Notes |
| --- | --- | --- |
| `id` | yes | Stable within the provider. Rows with a repeated id are dropped. |
| `label` | yes | The row's text, cut at 160 characters. |
| `description` | no | The second line, cut at 256 characters. |
| `iconId` | no | A shared plugin icon id; anything else falls back to the provider's icon. |
| `args` | no | A JSON object as text (SQLite's `json_object()`), at most 4 KB. Handed to the target. |

Text your param's own constraints refuse (its `maxLength`, `pattern`, …), and a database your plugin hasn't created yet, answer with no rows.

**Runtime providers** are a function you bind in `activate()` with [`host.registerSearchProvider`](./host-api.md#registersearchprovider). It returns results of the same shape — `{ id, label, description?, iconId?, target?, args? }` — and gets a `signal` that aborts when the query is superseded.

**Budgets.** The switcher waits 150 ms after the last keystroke, and a new query cancels the one before it. Each provider has one second to answer; one that misses it is left out of that query and a warning lands in your plugin's diagnostics (at most once a minute per provider). A scoped provider shows up to 20 results; a blended one adds up to 3, and the unscoped search shows at most 6 provider results in all, always below the built-in rows, which never wait for a provider. A blended search only asks declarative providers and runtime providers whose plugin is already running — it never starts your plugin. A scoped search may: the first query after the user picks your provider activates the plugin, inside the same one-second deadline.

**Checks.** Every result is checked host-side before the switcher sees it: a target outside your plugin, args that aren't a small JSON object, or a missing id or label drop that row, and the dropped rows are counted in your diagnostics. The manifest gate refuses a declarative provider with no query (`search_provider_query_missing`) or no target (`search_provider_target_missing`), a query you don't declare (`search_provider_query_unknown`), a write query (`search_provider_query_not_read`), a query without exactly one string param (`search_provider_query_params`), a runtime provider naming a query (`search_provider_query_runtime`), a target naming both or neither of panel and command (`search_provider_target_conflict`), a command outside your namespace (`search_provider_command_not_own`), a panel you don't declare (`search_provider_panel_unknown`), a PTY-backed panel, which has no view to hand args to (`search_provider_panel_pty`), and two of your providers sharing a keyword (`search_provider_keyword_duplicate`). A plugin may declare at most 5 providers.

**Keywords are first come, first served.** When two plugins claim the same keyword in a project they can both be seen in, the provider registered first keeps it and the other is refused there: it never appears in that project's switcher, its Settings row says which plugin holds the keyword, and a warning lands in the refused plugin's diagnostics. Two project plugins in different projects never collide.

**Show in quick switcher.** Each provider has a switch in Project settings → Plugins, on your plugin's page. For an installed plugin the choice holds in every project; for a project plugin, only in that project. Hiding an installed plugin in a project hides its providers there too.

## Menu items — _Shipped_

Menu items add entries to Daintree's application menus.

```json
{
  "contributes": {
    "menuItems": [
      {
        "label": "Plan from Linear…",
        "actionId": "acme.linear-planner.plan-from-issue",
        "location": "view",
        "accelerator": "Cmd/Ctrl+Shift+L"
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `label` | yes | Menu entry label. |
| `actionId` | yes | Fully-qualified action ID to dispatch. |
| `location` | yes | One of `"terminal"`, `"file"`, `"view"`, `"help"`. Determines which top-level menu the item appears in. |
| `accelerator` | no | An Electron accelerator string, passed through as written except that `Cmd/Ctrl` becomes `CommandOrControl`. Write `"Cmd/Ctrl+Shift+L"` (or Electron's own `"CmdOrCtrl+Shift+L"`) for Cmd on macOS and Ctrl on Windows/Linux; a bare `Cmd` is the Command key, which Electron does not map to Ctrl there. |
| `when` | no | Context expression gating whether the item appears. Evaluated once at menu build time against an empty context, so only constant expressions (literals and negations of unknown identifiers) are useful — for live conditions use a keybinding `when` clause instead. |

## Keybindings — _Shipped_

Keybindings map a key combination to an action.

```json
{
  "contributes": {
    "keybindings": [
      {
        "actionId": "acme.linear-planner.plan-from-issue",
        "combo": "Cmd+Shift+P",
        "scope": "global",
        "when": "!terminalFocused && !modalOpen"
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `actionId` | yes | Fully-qualified action ID, usually one your plugin declared. |
| `combo` | yes | Normalized key combo string, same format as Daintree's default keybindings. Chords (`"Cmd+K Cmd+S"`) supported. |
| `scope` | no | One of `"global"`, `"portal"`, `"worktreeGrid"`, `"dev-preview"`. Defaults to `"global"`. An unknown scope is rejected at the manifest gate. The former `"terminal"`, `"modal"`, and `"worktreeList"` scopes were removed — use `when` conditions instead (`"terminalFocused"`, `"modalOpen"`); worktree-list navigation keys are fixed and not bindable. |
| `description` | no | Human-readable description of what the binding does. |
| `when` | no | Context expression gating when the binding is active. Evaluated live at each keydown against the context keys below; unknown identifiers evaluate falsy — which makes negated expressions permissive (a misspelled `!modalOpne` is always true), so double-check identifier spelling. Supports `&&`, `\|\|`, `!`, `==`, `!=`, and single-quoted string literals. |

**`when` context keys.** The project keys describe the project this window shows. Every renderer `when` sees them: keybindings, [context menus](#context-menus--shipped), and each chrome contribution that takes a `when`. They update live, so an entry appears or disappears as soon as a key it reads changes.

| Key | Type | Meaning |
| --- | --- | --- |
| `isGitBacked` | boolean | The project is a git repository. `false` in a folder opened without git, in a scratch workspace, and when no workspace is open. |
| `workspaceKind` | string | `"project"`, `"scratch"`, or `""` when no workspace is open. |
| `activeSidebarView` | string | The sidebar view the project shows: `"worktrees"` for the built-in worktree list, or a [sidebar view](#views--shipped)'s id. It names the view showing whether or not the sidebar is visible, and falls back to `"worktrees"` while a chosen plugin view doesn't apply. |
| `presentationForgeStats` | string | How this project presents the toolbar's forge stats pill: `"shown"`, `"demoted"` (in the toolbar's `…` menu) or `"hidden"`. Always `"hidden"` in a folder without a git repository. |
| `presentationGitDetail` | string | How this project presents git detail on worktree cards: `"shown"` or `"demoted"` (labelled Quiet in settings). Quiet moves the branch, issue and PR detail and the sync line into the card's expanded details, with the headline's tooltip naming what it displaced, drops the resting last-activity chip, and gathers the card menu's git rows under its Git submenu; failing CI, a head that moved under an armed merge, drift and fetch failures stay on the card. Always `"hidden"` in a folder without a git repository. |
| `presentationLauncherAgents` | string | How this project's launcher presents its agent group: `"shown"` or `"demoted"` (folded into the launcher's collapsed More row, where search still finds every agent). |
| `presentationLauncherPanels` | string | How this project's launcher presents its built-in panel groups: `"shown"` or `"demoted"`, as for agents. |

A `when` turns one entry on or off. It never gates the action behind it, which still runs from anywhere else that offers it.

Keybindings also see the focus and UI keys:

| Key                | Type    | Meaning                                                        |
| ------------------ | ------- | -------------------------------------------------------------- |
| `terminalFocused`  | boolean | Keyboard focus is inside an xterm terminal.                    |
| `textInputFocused` | boolean | Keyboard focus is in a text field or editor (not a terminal).  |
| `modalOpen`        | boolean | A modal dialog (`aria-modal`) is open.                         |
| `paletteOpen`      | boolean | Any palette (command palette, quick switcher, …) is open.      |
| `paletteId`        | string  | Identifier of the open palette, or `""` when none.             |
| `fleetArmed`       | boolean | At least one terminal is armed for fleet broadcast.            |
| `fleetWaiting`     | boolean | At least one armed terminal's agent is in the `waiting` state. |
| `sidebarVisible`   | boolean | The worktree sidebar is currently visible.                     |
| `canopyHidden`     | boolean | The user hid Canopy; its panel cannot open.                    |

The `presentation*` keys come from the project's presentation profile, which the user sets in Project settings → General → Features, and → Launcher for the two launcher keys. A repository can suggest one by committing `.daintree/presentation.json` — `{ "features": { "forgeStats": "hidden", "gitDetail": "demoted" } }` — and the suggestion applies only once the user accepts it when the project opens. Daintree reads that file and never writes it, unknown features and levels are ignored, and no plugin API changes a level.

The profile also arranges the launcher. Once it demotes a launcher group or features an entry, the project's own plugin groups lead the launcher; installed plugins keep their name order. `.daintree/presentation.json` can suggest a featured entry with `"featuredLaunchEntry": "publisher.name.entry-id"`, naming one of the project plugin's own [launch entries](#launch-entries--shipped) by its manifest name and entry id. The featured entry is preselected when the launcher opens, so Enter runs it; featuring never runs anything by itself, and an entry that is hidden, filtered out by its `when` or not loaded leaves the first row selected. The user's group order, set in Project settings → General → Launcher, wins over the profile's.

A plugin adds keys of its own with [`host.setContext`](./host-api.md#setcontext). They sit under its manifest name — `setContext("needsYou", true)` from `digitalfrontier.beads` reads as `digitalfrontier.beads.needsYou` — so a binding can stay off until the plugin has something to act on. Manifest names with hyphens or leading digits (`acme.linear-planner`, `3m.tools`) parse as paths. Every renderer `when` sees these keys too, like the project keys.

Note: none of these keys reach native menu-item `when` clauses (the `menuItems` contribution). Those resolve in the main process, once at menu build time, against an empty context — only literal/negation expressions are useful there.

Bindings register when the plugin loads and unregister on unload. Conflicts with user overrides or other plugins' bindings are resolved by Daintree's existing keybinding service — plugin bindings are low-priority and yield to user overrides. See `registerBinding` in `src/services/KeybindingService.ts` for the registration API.

## Settings schema — _Shipped_

Declares the values your plugin needs from the user. Daintree stores them, renders the form for them in the plugin's settings home, and hands them back through [`host.settings`](./host-api.md#settings), so a plugin never builds a settings screen of its own.

```json
{
  "contributes": {
    "settings": [
      {
        "id": "linear.apiToken",
        "type": "secret",
        "scope": "user",
        "label": "Linear API token",
        "description": "Personal API token from linear.app/settings/api",
        "required": true
      },
      {
        "id": "linear.defaultTeam",
        "type": "string",
        "scope": "project",
        "label": "Default team",
        "description": "Team slug to use when opening a new planning session",
        "default": ""
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Setting key, used to read and write the value through the host API. Letters, digits, `.`, `_` and `-`, so it can always be named by a `${settings:id}` token. |
| `type` | no | One of `string`, `number`, `boolean`, `enum`, `json`, `secret`, `path`, `directory`, `file`. Defaults to `string`. |
| `label` | no | Field label in the generated form. Defaults to the `id`. |
| `description` | no | Help text beneath the field. |
| `default` | no | The value `host.settings.get` returns while nothing is stored, and what the form's reset restores. Rejected on a `secret`: it would ship in `plugin.json` — mark the secret `required` instead. |
| `scope` | no | `user` (default), `project` or `local`. See **Scopes** below. |
| `options` | no | Non-empty string array; required when `type` is `enum`. |
| `min` / `max` | no | Numeric bounds for `number` settings, enforced by the form. `min` cannot exceed `max`. |
| `mustExist` | no | For `path` / `directory` / `file`: when `true`, the form flags a stored path that no longer resolves on disk. Advisory — it never blocks saving. |
| `extensions` | no | For `file` only: restrict the native chooser to these extensions (no leading dot, e.g. `["json", "md"]`). Rejected on any other type. |
| `secret` | no | Legacy boolean; `secret: true` normalizes to `type: "secret"`. Prefer `type: "secret"`. |
| `required` | no | `true` when the plugin can't do its job without a value. See **Required settings** below. |
| `editor` | no | `"form"` (default) or `"view"`. `"view"` hands the value to your own [custom section](#a-custom-settings-section) — for something a plain field edits badly, like a per-channel table stored as `json` — and the generated form leaves it out instead of showing it twice. Without a `location: "settings"` view the field is shown anyway. |

**Types.** `string` is a text input, `number` a number input held to `min` / `max`, `boolean` a switch, `enum` a select over `options`, and `json` a text area that must parse as JSON before it is stored (clearing it resets to the default). `path` and `directory` render a read-only input plus a **Browse** button that opens a native folder chooser; `file` opens a single-file chooser narrowed by `extensions`. The stored value is an absolute path. The form applies each change as it is made; there is no Save.

**Scopes.** `user` is one value for the whole app, persisted in `~/.daintree/plugin-settings/`. `project` is per project and persisted in the repository, at `<projectRoot>/.daintree/plugin-settings/`, so a value committed there reaches everyone who clones it. `local` is per project but stays on this machine, under `~/.daintree/plugin-settings/local/<projectId>/`. An installed plugin's `project` and `local` values follow the active project: with none open they read as unset and `host.settings.set` refuses them. A project plugin's always resolve against its own project.

**Secrets.** A `secret` is a masked input with a reveal toggle and a Clear that asks first. Its value is encrypted at rest through the OS keychain; where no keychain is available, the form says secrets can't be saved on this device and `host.settings.set` rejects rather than storing plaintext. A secret is never written into the repository: a `project`-scoped secret is stored like a `local` one, so each collaborator enters their own. It can't declare a `default`.

**Required settings.** While a `required` setting is unset, each of the plugin's open panels and surfaces shows a neutral "<Plugin> needs setup" strip above its content, whose **Open plugin settings** lands on the first missing setting, and [`host.settings.missingRequired()`](./host-api.md#settings) lists it. The strip goes away by itself once the value is stored. A `default` never satisfies it — the form shows a **Use default** button that stores the default explicitly — and a secret counts as set only once a value is stored. A required setting whose stored file can't be read shows as "Couldn't read <label>" instead.

**Where they appear.** Each field has exactly one home. An installed plugin's `user` fields are in the plugin manager, on its Settings tab; its `project` / `local` fields are in Project settings → Plugins, with the plugin selected; a project plugin's fields are all in Project settings. Each home shows only its own fields, with a row pointing to the other when there is one. Every way in lands in the right home: the **Plugin settings…** entry in your panels' ⋯ and right-click menus, the setup strip, [`host.settings.open(key?)`](./host-api.md#settings), and the `plugin.openSettings` action behind them, which scrolls to and briefly highlights `key` when it names a declared setting — or, for an `editor: "view"` key, your custom section. A project-scoped destination with no project open is refused rather than sent somewhere the field isn't. `plugin.openSettings` is UI navigation: it is hidden from agents and MCP clients.

### A custom settings section

When fields aren't enough — a sign-in flow, a list editor, a connection test — declare one view with `location: "settings"` (see [Views](#views--shipped)). The host mounts it in the plugin's settings home below the generated fields, inside a settings group it draws, so the section reads as more rows of the same page. Declaring it is also enough to give your panels a **Plugin settings…** entry, with no settings fields at all.

- **Where it mounts.** An installed plugin's section mounts in both homes — `settingsContext: { scope: "user", projectId: null }` in the plugin manager, `{ scope: "project", projectId }` in Project settings — so render the rows for the scope you're given. A project plugin's section always mounts with `scope: "project"`.
- **What it receives.** `pluginId`, a `panelId` of its own per home, `disposeSignal`, `panelRemovedSignal`, `styleRootAttributes` and `settingsContext`. There is no panel record behind it, so `initialArgs`, `persistState`, `stateVersion`, `worktreeId`, `requestReload`, `setHasUnsavedChanges` and `setTitle` are absent.
- **Containment.** The group is isolated and contained (`contain: layout paint`, overflow clipped), so a `position: fixed` descendant stays inside it; portal anything that has to float, with `styleRootAttributes` on the portal container.
- **Lifecycle.** Loading it activates a loaded plugin that hasn't activated yet, like opening a panel; it never starts a stopped one. While the plugin is disabled or stopped, the section shows as one row saying it's available once the plugin runs. An installed plugin's section is served only to projects that show the plugin; where it is hidden the section is one row saying so. When the plugin stops, is muted, reloads or is hidden, the section unmounts and its `disposeSignal` and `panelRemovedSignal` abort; after a reload an open settings page swaps onto the new module as soon as it is served, so it never runs the retired one. A render error shows the same diagnostics pane with **Try again** that a panel gets, and the rest of the page keeps working.

[Views → A settings section](./views.md#a-settings-section) covers writing one.

Values are read via the host API:

```ts
const token = await host.settings.get<string>("linear.apiToken");
```

Changes made through Daintree fire the `host.settings.onDidChange` subscription, so you don't need to reactivate to pick them up.

## Context menus — _Shipped_

Adds entries to right-click menus on specific UI elements.

```json
{
  "contributes": {
    "contextMenus": [
      {
        "actionId": "acme.linear-planner.link-issue",
        "location": "worktree",
        "label": "Link to Linear issue…"
      },
      {
        "actionId": "acme.linear-planner.attach-log",
        "location": "terminal",
        "label": "Attach output to Linear issue…",
        "when": "panelKind == 'terminal'"
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `actionId` | yes | Fully-qualified action ID to dispatch. |
| `location` | yes | `"worktree"`, `"terminal"`, `"file"`, `"browser"` or `"project"`. |
| `label` | yes | Menu entry label. |
| `when` | no | Context expression gating whether the item appears, in the same syntax as a [keybinding `when`](#keybindings--shipped). See below. |

**`when` context keys.** A context menu's `when` is evaluated in the renderer against keys describing what was right-clicked, not the keybinding keys:

| Location | Keys |
| --- | --- |
| `worktree` | `worktreeId` — the clicked worktree's id |
| `terminal` | `panelId` — the clicked pane's id; `panelKind` — its panel kind; `worktreeId` — the worktree the panel belongs to (unset for a panel with none) |
| `browser` | `panelId` — the pane's id; `panelKind` — `browser` or `dev-preview` |
| `file` | None |
| `project` | `projectId` — the project the pill belongs to |

An identifier that names no key evaluates false, so `"worktree.hasBranch"` hides the item everywhere while `"!worktree.hasBranch"` shows it everywhere; an expression that fails to parse hides the item. Every location also sees the [project keys](#keybindings--shipped) (`isGitBacked`, `workspaceKind`, `activeSidebarView`, `presentation*`) and the keys plugins publish with [`host.setContext`](./host-api.md#setcontext), under each plugin's manifest name; a location's own key wins a clash. Because `file` supplies no keys of its own, a `when` on a `file` item can only test those shared keys or a constant.

**Dispatch arguments.** Every location dispatches its action with the clicked subject, so your handler receives what was clicked rather than `undefined`: `worktree` with `{ worktreeId }`, `terminal` with `{ panelId, panelKind, worktreeId }` (`worktreeId` is omitted for a panel with no worktree), `browser` with `{ panelId, panelKind, url }`, `project` with `{ projectId }` for the project whose pill was right-clicked, and `file` with the clicked file, as described next. Only ids and the page URL are passed — never terminal output or a selection, which stay behind `terminal:read`.

**Locations:** `worktree`, `terminal`, `file`, `browser`, `project`. More may be added. `terminal` is the right-click menu of a terminal-backed panel; `browser` is the "More page actions" menu of a browser or dev preview panel, and its `url` is the address the pane shows with any `user:password@` credentials removed. The `file` location is the one file menu Daintree shares across every surface that shows a file — the Review Hub's changed-file rows, the worktree card's changed-files list, the file browser's tree, folder listing and change summary, the diff viewer's file sidebar, and the right-click menu on a file's own content in the file browser and in a file panel — so a single `file` contribution reaches all of them without any per-surface work. Its action is dispatched with `{ path, isDirectory, relativePath, worktreePath, status }` for the clicked file or folder (so your handler receives the subject, not `undefined`) — `path` is always absolute, `relativePath` is relative to the worktree root with forward slashes, while `relativePath`, `worktreePath` and `status` are each omitted when the row has no worktree root or no git status, so an unchanged file in the file browser arrives as `{ path }` alone.

**Targeting rows.** A `file` item can declare which rows it appears on, and the host evaluates it per row, ANDed with `when`: `kind` (`"file"` or `"folder"`), `extensions` (bare lower-case suffixes without the dot, matched case-insensitively against a file's last suffix; a dotfile or bare name has none; not allowed with `kind: "folder"`) and `paths` (globs relative to the worktree root using `**`, `*` and `?`, the same grammar as `fileEditors[].paths`). Omitted fields match everything, and the three fields are rejected on any other location.

**Where the items go.** On a file menu and on the worktree card's menu, contributed items sit in an **Extensions** submenu, one group per plugin (labelled when more than one plugin contributes), after Daintree's own entries and before the destructive ones — Discard changes and Delete file on a file, Delete worktree… on a worktree. The submenu appears only when at least one item passes its `when`, and a `worktree` item is not offered on a bare workspace root. On the toolbar project pill, `project` items sit in the same **Extensions** submenu, after Project settings and before Stop all agents and Close project. A project plugin's items appear only in its own project, and an installed plugin's only in projects where it is visible. On a terminal, contributed items are appended at the end of the right-click menu.

Context menus follow the same `actionId` dispatch pattern as menu items. A `terminal`-location item appears in the right-click menu of terminal-backed panels, not on browser, dev preview or review panels; gate it with `when` (for example `panelKind == 'terminal'`). To put entries on your own panels, use the panel's `menu` or [runtime menu entries](#runtime-menu-entries) instead: those are dispatched with `{ panelId }`. Two built-in actions pair well here: `file.openDiff` opens the side-by-side diff for the dispatched `{ path, worktreePath, status }`, and `panel.openPluginPanel` spawns (or focuses) one of your plugin panels, passing `initialArgs` straight through to the view's `initialArgs` prop — so a context-menu item can open your panel scoped to the file the user clicked.

## MCP servers — _Shipped_

Declares Model Context Protocol servers the plugin ships. The manifest key is `mcpServers` (it was `experimental_mcpServers` until #10466 — the old key is still accepted as a deprecated alias that logs a warning). The runtime is live: `PluginMcpSupervisor` (`electron/services/PluginMcpSupervisor.ts`) spawns and supervises the stdio subprocess, and IPC handlers in `electron/ipc/handlers/pluginMcp.ts` wire list/restart/listTools/getFullSchema/callTool. See [Agent extensions → MCP servers](./agent-extensions.md#mcp-servers) for the full story.

```json
{
  "contributes": {
    "mcpServers": [
      {
        "id": "linear",
        "name": "Linear MCP",
        "command": "node",
        "args": ["./dist/mcp/linear-server.js"],
        "env": { "LINEAR_API_KEY": "${settings:linear.apiToken}" }
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Letters, digits, `.`, `_` and `-`, at most 64 characters. Scoped to the plugin: a server is addressed by your plugin id and this id. |
| `name` | yes | Display name. |
| `command` | yes | Any non-empty string — typically `node`, `python` or `npx`, resolved on `PATH`. |
| `args` | no | Argv after the command. A relative path here resolves against the plugin directory, the server's working directory. |
| `env` | no | Environment variables. Values can reference settings with `${settings:settingId}` syntax — the id must name a declared `contributes.settings[].id`, else the manifest is rejected at parse time (`settings_token_unknown`; a malformed token shape is `settings_token_malformed`). The same validation applies to `${settings:*}` tokens in `command` and `args`. |

**The process environment.** The server always runs with the plugin directory as its working directory; the manifest cannot change it. It does not inherit Daintree's environment: it gets a minimal allowlist (including proxy and CA settings, since these servers usually make outbound HTTPS calls) plus the variables `env` declares, so anything else the server needs must be forwarded there.

**What a `${settings:…}` token resolves to.** The token is substituted at spawn time from the plugin's stored **user-scope** value only. A string is used as-is, a number or boolean is converted to its string form, and an object or array is JSON-encoded. An unset value becomes the empty string — the setting's declared `default` is not used — and so does a token naming a `project` or `local` setting, which this path never reads.

Daintree supervises the process: lazy spawn the first time its tools are listed or called, hard kill on Daintree exit, and on an unexpected crash it transitions the server to `crashed` and rejects the calls in flight. The supervisor never respawns a crashed server on its own and has no retry or backoff; the next tool listing, schema fetch or call spawns it again, as a manual restart does.

Daintree is the **client** of this server. Its tools are reachable only through the `window.electron.pluginMcp` IPC surface, which nothing in Daintree calls for tools today; the plugin manager's settings UI lists, restarts and inspects the server. They are not merged into the `tools/list` that agents running in Daintree's terminals see. To give terminal agents tools, declare an [agent MCP endpoint](#agent-mcp-endpoints--shipped) instead.

**Secret rotation auto-restart:** when a **user-scope** setting changes, every currently running server (status `ready` or `crashed`) that references it via `${settings:settingId}` in its `command`, `args`, or `env` is automatically restarted so the new value is folded in at the next spawn. The restart is debounced ~1s, so a burst of edits coalesces into one respawn. Servers that were never lazily started stay stopped — a settings change never eagerly boots a server.

Tool use is gated by a consent/permission/audit subsystem (`electron/services/plugin-mcp/` — `PluginMcpConsentService`, `PluginMcpTierAuth`, `PluginMcpAuditService`, `PluginMcpConsentStore`): each `pluginMcp.callTool` into the server is checked against per-server permission tiers, prompts for consent when required, and is recorded to an audit log. Discovery is lazy and two-tier — a cheap tool list first, full schemas fetched on demand.

- **Per-tool danger tier.** Each tool's tier comes from its MCP annotations — `readOnlyHint: true` is D0 and takes precedence over the others, otherwise `destructiveHint: true` is D2 and any other tool D1 — and `openWorldHint: true` raises it one step. The tier is capped by the plugin's declared capabilities: D1 for a plugin with none of the high-risk tokens, D2 for one with any. A call whose tier is above the cap is denied rather than downgraded, so a destructive open-world tool (D3) is denied for every plugin. See [Trust model → MCP tool danger-tier cap](./trust-model.md#2-host-side-policy-input-load-bearing).
- **Rate limit.** Calls into one server share a token bucket: a burst of 20, then one call per second.

**Intentionally excluded:** remote MCP transports (`url`), explicit transport types, per-server working directories, restart policies. These are deferred until use cases concretely require them.

## Agent MCP endpoints — _Shipped_

Declares the tools the plugin serves to agents running in Daintree's terminals. This is the opposite direction from [`mcpServers`](#mcp-servers--shipped): Daintree hosts the plugin's MCP server on its own loopback listener and the agent is the client. Each plugin is one server, `daintree-<name>`, named by the manifest's top-level [`mcpName`](./manifest.md#mcpname); the tools you register are listed on it beside the host's read-only [database tools](#databases--shipped) and any [declared queries](#declared-queries) when the plugin declares a database. The manifest entry is declarative only — the tools arrive at activation through [`host.mcp.registerTools`](./host-api.md#mcpregistertools). See [Agent extensions → Agent MCP endpoints](./agent-extensions.md#agent-mcp-endpoints) for the worked example, the naming rule and troubleshooting.

```json
{
  "capabilities": ["mcp:expose"],
  "contributes": {
    "agentMcp": [
      {
        "id": "ledger",
        "name": "Ledger",
        "description": "Read and record entries in this project's ledger.",
        "mode": "tools"
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Letters, digits, `.`, `_` and `-`, at most 64 characters, and not `.` or `..` — the id is a segment of the endpoint's URL path. The id `registerTools` binds a roster to. |
| `name` | yes | Label for the endpoint, 1–80 characters. Carried in the host's declared-endpoint metadata; agents never see it — the server's name comes from the plugin's `mcpName`. |
| `description` | no | 1–400 characters. |
| `mode` | yes | `"tools"` — host-managed tools, the only mode today. |

The entry is strict: an unknown field (a `url`, a `command`) is rejected rather than read as a transport the host will not honour. At most one endpoint per plugin, and the manifest is rejected unless `capabilities` includes `mcp:expose` (`mcp_expose_capability_required`).

**Tool limits**, enforced on the whole roster when it is registered — a roster that breaks any of them is rejected, never trimmed:

| Limit | Value |
| --- | --- |
| Tools per endpoint | 16, counting the database queries the manifest declares |
| Tool name | `^[a-z][a-z0-9_]{0,31}$` — at most 32 characters, so Claude's `mcp__<server>__<tool>` name stays within its 64-character limit. `database_schema` and `database_query` are reserved for the host's database tools, as is the name of each declared database query |
| Description | Non-empty, at most 400 UTF-8 bytes |
| `inputSchema` / `outputSchema` | A plain object with `type: "object"`, at most 8 KiB serialized each |
| Result | At most 256 KiB of serialized JSON |
| Call timeout | 60 seconds, activation included |

The cap was 8 tools before Daintree 0.39.0. An older host rejects a larger roster whole: `registerTools` throws, and unless the plugin catches it, activation fails. A plugin that registers more than 8 tools should set `engines.daintree` to `>=0.39.0`. The range is advisory — an older Daintree still installs and loads the plugin — but it shows the user a compatibility warning that explains the failure.

**Giving it access.** Declaring the endpoint exposes nothing, for an installed plugin or a project one. Each plugin has one agent access setting — **Off** (the default), **Read only** (the database tools and declared read queries) or **Read and write** (those, declared write queries and your own tools) — in **Project settings → Plugins → Agent tools**. It is stored in Daintree's own user store, keyed by the plugin _instance_ so an answer for an installed plugin never reaches a project plugin with the same manifest id, and never in the repository. An installed plugin can also be set once for every project, and a project's own setting overrides that. A project plugin's own repository can set a default in `.daintree/mcp.json`, which never reaches an installed plugin and which the user's answer overrides ([Agent extensions → Project defaults](./agent-extensions.md#project-defaults-daintreemcpjson)). Lowering the setting revokes every live credential it no longer allows. Once the plugin has access, each agent launched in that project afterwards receives a credential for its server — Claude Code, Codex, Gemini CLI, opencode, Copilot CLI, Amp, Qwen Code and Mistral Vibe, each in its own launch mechanism; an agent already running must be relaunched to get it ([Agent extensions → Reaching an agent](./agent-extensions.md#reaching-an-agent)). The Daintree MCP server must be enabled in Settings → MCP server, since the plugin's server is served on its listener.

**Available under `scope: "project"`.** Unlike `mcpServers` and `skills`, this surface has a project axis: every credential is minted for one terminal launch in one project, the route re-checks that project's access setting on every request, and a project plugin's endpoint can only be granted to the project that loaded it. See [Trust model → Agent MCP endpoints](./trust-model.md#agent-mcp-endpoints-mcpexpose) for the credential and consent model.

## Databases — _Shipped_

Declares a SQLite database the plugin opens with [`host.db`](./host-api.md#db--host-managed-sqlite). The declaration is what names the file, discloses it in the plugin manager, and decides where it lives, so the host resolves and contains the path before your code sees it.

```json
{
  "scope": "project",
  "capabilities": ["fs:project-write"],
  "contributes": {
    "databases": [
      {
        "id": "ledger",
        "description": "Transactions, categories and budgets.",
        "path": "data/finance.db"
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Letters, digits, `.`, `_` and `-`, at most 64 characters. What `host.db.open(id)` names, and the default file name. |
| `description` | no | 1–400 characters. Shown beside the database in the plugin manager, which lists every declared database. |
| `location` | no | `"project"` (default) or `"local"`. |
| `path` | no | `"project"` only. Relative to the project root (no leading `/`, backslash, `..` segment or URL syntax), at most 512 characters, ending in `.db`, `.sqlite` or `.sqlite3`, never inside `.git`. Defaults to `.daintree/data/<manifestId>/<id>.db`. |
| `journalMode` | no | `"delete"` (default) or `"wal"`. |
| `queries` | no | Named read or write statements the host serves to agents as tools of their own. See [Declared queries](#declared-queries) below. |

**`"project"`** puts the file in the repository. That is the location for data agents edit: an agent in the project's terminal can open the same file with the `sqlite3` CLI, the file travels with a clone, and the committed data contract (your plugin's `AGENTS.md`) can name it by its project-relative path. It needs `scope: "project"` (`database_project_scope_only`) and the `fs:project-write` capability (`database_project_write_required`), because it writes into the repository. Whether the file itself is committed is the project's decision; gitignore it to keep the data out of history.

**`"local"`** keeps the file in this machine's per-plugin data directory (`databases/<id>.db` there), out of the repository, and needs no capability — the same footing as `host.storage`. It is available to installed and project plugins alike. An agent working in the project has no path to the file, so it reaches a local database through the plugin's database tools (below) or your own tools. An installed plugin's local database is one file shared by every project, and the database tools cannot filter it by project, so access in one project reads every project's rows; only your own tools can scope per-project data ([Agent extensions → Installed plugins and shared data](./agent-extensions.md#installed-plugins-and-shared-data)). A `path` on a local database is refused (`database_local_path_unsupported`).

**Where the file lands.** The host resolves the declaration, never your code: `host.db.open` creates the file and its directory on first open, contained to the project root (or data directory) on the real path, so a symlinked directory cannot carry it outside, and it refuses a path that resolves inside `.git` or a database file that is itself a symlink. `host.db.resolve(id)` returns the location without opening it, for handing to an agent. See [Host API → `db`](./host-api.md#db--host-managed-sqlite).

**`journalMode`.** The default, `"delete"`, keeps the database one self-contained file between writes, so git, a backup, or a sync folder never sees committed data stranded in a `-wal` sidecar. The host re-applies the declared mode on every open, so an agent that ran `PRAGMA journal_mode=WAL` cannot silently switch it. Choose `"wal"` only for a local, write-heavy database nothing else copies.

At most 16 databases per plugin; entries are strict, so a `url` or `driver` field is refused rather than read as a backend the host does not have.

**Agents can read it.** Declaring any database puts the host's own read-only database tools on the plugin's server, with no `mcp:expose` and no code from you — a plugin with no `agentMcp` endpoint gets a server with just these two and any [queries it declares](#declared-queries). Like the rest of the server they are off until the plugin's agent access is at **Read only** or **Read and write** for the project ([Agent MCP endpoints](#agent-mcp-endpoints--shipped)). The two tools: `database_schema` lists your declared databases and the `CREATE` statements of their tables, views, indexes and triggers (a database never created is reported, never created), and `database_query` runs one row-returning statement — `SELECT`, `WITH`, or a pragma such as `table_info` — with `?` or named parameters, returning columns and rows as arrays (blobs base64, big integers as strings), 100 rows by default and 1000 at most, under the host's result budget. Each call opens a fresh read-only connection in a short-lived process that is killed on cancel or timeout, with the same `ATTACH`, `VACUUM INTO` and directory-pragma refusals as `host.db`. The host binds the declarations at load and resolves the file on each call, so reading your data never starts your plugin; a database your code has not created yet reads as missing until it runs once. The two tools never write: an agent writes through a [declared write query](#declared-queries) or your own `agentMcp` tools. An installed plugin's local databases are one set of files every project shares, and the database tools can't filter rows by the calling project, so giving the plugin **Read only** (or **Read and write**) access in one project lets agents there read what your plugin stored for every other project, and making that the default for all projects lets every project's agents read it; the Agent tools setting says so beside the choice. If your plugin keeps per-project data, serve it through your own `agentMcp` tools, which can scope by `caller.projectId` ([Agent extensions → Installed plugins and shared data](./agent-extensions.md#installed-plugins-and-shared-data)).

### Declared queries

Most of the tools a small data app wants are one parameterised statement and a description: a `SELECT` for a read, an `INSERT` or `UPDATE` for a write. Declare those on the database and the host serves each one as a tool of its own on the plugin's server, named after the query (`mcp__daintree-ledger__month_total`), with no `agentMcp` endpoint and no code:

```json
"databases": [{
  "id": "ledger",
  "queries": [
    {
      "name": "month_total",
      "mode": "read",
      "description": "Total spend for a month, in integer cents.",
      "params": { "month": { "type": "string", "description": "YYYY-MM" } },
      "sql": "SELECT SUM(amount_cents) AS total FROM tx WHERE substr(date, 1, 7) = :month"
    },
    {
      "name": "add_transaction",
      "mode": "write",
      "description": "Record a transaction. Amount in integer cents, negative for spending.",
      "params": {
        "date": { "type": "string", "format": "date", "description": "YYYY-MM-DD" },
        "amount_cents": { "type": "integer", "not": { "const": 0 } },
        "category": { "type": "string" }
      },
      "sql": "INSERT INTO tx (date, amount_cents, category) VALUES (:date, :amount_cents, :category)"
    }
  ]
}]
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | The tool name: `^[a-z][a-z0-9_]{0,31}$`, unique across all of the plugin's databases, and not `database_schema` or `database_query`. |
| `mode` | yes | `"read"` or `"write"`. It decides which statement the query may be, the connection it runs on and the access level that serves it. |
| `description` | yes | The tool description agents see. Non-empty, at most 400 UTF-8 bytes. |
| `params` | no | Map of param name (letters, digits and `_`, not starting with a digit) to `{ "type", "description"? }` plus any constraints below, at most 16. `type` is `"string"`, `"number"`, `"integer"` or `"boolean"`. Defaults to none. |
| `sql` | yes | One statement, at most 65,536 characters. |

The tool's input schema is built from `params`: every param required, of its declared type, and nothing else, so an agent passes values and never SQL. Each value binds to the placeholder of the same name — `:month`, `@month` or `$month`, the same spelling throughout — and an integer or a boolean binds as a SQLite integer (`true` is 1). A value is always data: `"2026-01' OR 1=1 --"` is a month that matches nothing.

A param may also declare JSON Schema constraints on its value, which go into the input schema as written and which the host checks before the statement runs: `minLength` and `maxLength` (in characters), `pattern` (a Unicode regular expression) and `format` (`date`, `time`, `date-time`, `email`, `uri` or `uuid`) on a string; `minimum` and `maximum` (inclusive) on a number or integer; and `not: { "const": value }` on any type to refuse one value, such as `0`. An integer without bounds is held to ±(2^53 − 1). A constraint on a type it cannot apply to, an integer bound outside that range, a minimum above its maximum, a pattern that does not compile, or a `not` value of another type rejects the manifest (`database_query_param_constraint`).

A `"read"` query is served beside `database_query` and under its rules: available once the plugin's agent access is **Read only** or higher, run on the same fresh read-only connection with the same refusals, against the database it is declared on, and returning the same `{ databaseId, columns, rows, truncated }`. It returns up to 1,000 rows under the result budget, with `truncated` set past either, so give a query that can match more an `ORDER BY` and a `LIMIT`. The host marks it `readOnlyHint: true` itself, from its own check of the SQL and the connection it runs on. Listing or calling it never starts your plugin.

A `"write"` query is one `INSERT`, `REPLACE`, `UPDATE` or `DELETE`, optionally after `WITH` and with `RETURNING`. It is served only once the plugin's agent access is **Read and write**, the level that serves your own tools; at **Read only** it is neither listed nor callable. The host runs it in a short-lived process like a read, on a connection with the policy of a writable `host.db` open — foreign keys on, the busy timeout, your declared `journalMode`, and the same `ATTACH`, `VACUUM INTO`, directory-pragma and `load_extension` refusals — and in a transaction of its own, so a statement that fails part way, a trigger's `RAISE(FAIL)` included, leaves nothing behind. It never creates the database: before your code has, the call fails with `DB_NOT_FOUND`, as `database_query` does. The agent supplies only values, so your statement and your schema's `CHECK` constraints, `STRICT` columns and triggers are the whole of the rules a write must pass, and a trigger's `RAISE` message is the error the agent reads. Those are the rules the file has when it is called: a trigger or migration your code applies through `host.db.open` reaches an existing file only once your code has opened it, so a write can meet the previous version's rules until then. Declare a rule about a single value on its param as well: the host checks it before the statement runs, whatever the file holds. A write blocked by another writer for five seconds fails with `DB_LOCKED`, having written nothing.

The result is `{ databaseId, changes, lastInsertRowid }`, plus `columns`, `rows` and `truncated` for a statement with `RETURNING`, under the read path's row and size limits; rows past them are dropped from the result, never from the write. `changes` counts the rows the statement itself wrote, not those its triggers or foreign-key actions did, and `lastInsertRowid` is SQLite's, `0` when the statement inserted no row; use `RETURNING` to read back what was written. The host advertises a write as destructive and not idempotent, since it cannot see what your triggers do, and never as read-only. A `host.db` handle your panel holds open sees the commit through `onDidChange` as `origin: "external"`, so it refreshes as it would for an agent's `sqlite3` write. A call cut off by a cancel or the timeout may already have committed; the host's error says so, and the description should tell the agent to read before retrying.

**Declare a write or register a tool?** Declare it when one statement says it and the schema can hold its rules: add a row, move a card, mark an item done. Register a tool on your [`agentMcp` endpoint](#agent-mcp-endpoints--shipped) when it needs what one statement cannot give: rules checked across rows before anything is written, several statements in one transaction, a value your code computes (a minted id, the calling terminal from `caller`), optional or defaulted arguments, or a remote API. The [`acme.ledger` sample](../../plugins/sample-project/acme.ledger/README.md#declared-write-or-tool) has one of each.

A query the host cannot serve safely rejects the manifest at load, with an error naming the query (`database_query_unservable` and friends):

- the SQL is not exactly one statement (a trailing `;` or comment is fine), or leaves a quote or `/*` comment unterminated;
- a `"read"` query is not a `SELECT`, `WITH` or `VALUES` statement, or contains `INSERT`, `UPDATE`, `DELETE` or `REPLACE` anywhere outside a string or quoted name — `WITH … DELETE` is a write — so quote a column that shares one of those names (`"update"`); `replace(…)` the string function is fine;
- a `"write"` query is not one `INSERT`, `REPLACE`, `UPDATE` or `DELETE` statement, or its `WITH` clause does not lead into one, so a schema change, a pragma, `BEGIN` or `COMMIT`, or a read is refused;
- the SQL calls `load_extension()`;
- a placeholder has no param, a param has no placeholder, or a placeholder is positional (`?`), uses two spellings of one name, or uses SQLite's `$name::x` or `$name(…)` forms;
- the input schema built from `params` is larger than 8 KiB serialized;
- the name is `database_schema` or `database_query` or is declared twice (`database_query_name_reserved`, `database_query_name_duplicate`);
- the plugin declares more than 16 queries across all its databases (`database_query_limit`).

The check reads the SQL as written, since the database need not exist at load; a query naming a table that doesn't exist yet loads and fails when called. Declared queries count toward the plugin's 16-tool budget together with any tools it registers on its [`agentMcp` endpoint](#agent-mcp-endpoints--shipped), and a registered tool may not take a query's name.

**Back up data…** Every panel of a plugin that declares a database offers **Back up data…** in its ⋯ and right-click menus, with no wiring in your view. The host finds the declared databases that exist, never creating one, and snapshots them with SQLite's online backup from a read-only connection, so a write in progress is either wholly in the copy or not in it at all. One database asks where to save the file, suggesting `<manifestId>-<id>-<YYYY-MM-DD_HHmmss>.db` in Downloads; several ask for a folder and write one file each under that pattern. A plugin with no database on disk yet says so instead of opening a dialog. The entry is host UI: the `plugin.backupDatabases` action behind it is closed to plugins and hidden from agents and MCP clients. For a copy your own code makes — into a sync folder, say — use the open handle's `backup(destPath)`.

## Skills — _Shipped_

Markdown-defined instruction/knowledge snippets that extend Daintree's built-in MCP server. Agents running in Daintree discover and load them through the `skills.search` / `skills.load` tools on Daintree's MCP connection.

```json
{
  "contributes": {
    "skills": [
      {
        "id": "tdd-workflow",
        "name": "TDD Workflow",
        "path": "./skills/tdd-workflow.md",
        "triggers": ["test-driven", "tdd", "red-green-refactor"]
      }
    ]
  }
}
```

**Fields:**

| Field      | Required | Notes                                                           |
| ---------- | -------- | --------------------------------------------------------------- |
| `id`       | yes      | Namespaced as `{pluginId}.{id}`.                                |
| `name`     | yes      | Human label.                                                    |
| `path`     | yes      | Markdown file relative to the plugin directory.                 |
| `triggers` | no       | Search terms the agent uses to discover this skill, at most 50. |

A skill file larger than 512 KiB is skipped with a warning, as is one that cannot be read; the rest of the plugin's skills still register. Of a leading YAML frontmatter block, only `description` is read, and it is shown in search results; the rest of the file after the block is the body.

The markdown file content is returned to the agent when it calls `skills.load`, so it can be incorporated into the current task. See [Agent extensions → Skills](./agent-extensions.md#skills) for the full file format and invocation mechanics.

## Prompt templates — _Shipped_

Prompt templates a plugin offers in the composer's ❯ command picker, for the well-worn prompts of its domain. Choosing one asks for its arguments, if it has any, then puts the expanded text in the composer's draft for the user to edit and send. A template **never submits**, and it never appears in the `/` or `$` menus, which belong to the agent CLI's own commands. Each row names the plugin it comes from. Templates are declarative content and require no capability. An installed plugin's templates appear in every project; a [project plugin](./project-local.md)'s appear only in its own project.

```json
{
  "contributes": {
    "promptTemplates": [
      {
        "id": "reconcile",
        "title": "Reconcile this month",
        "description": "Match the month's ledger against the bank export.",
        "body": "Reconcile {{month}} for the {{account}} account and list anything that doesn't match.",
        "args": [
          { "name": "month", "label": "Month", "required": true },
          { "name": "account", "label": "Account" }
        ]
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Unique within the plugin's `promptTemplates`. |
| `title` | yes | The row's name in the picker. At most 80 characters. |
| `description` | yes | The row's summary line. At most 300 characters. |
| `body` | yes | The prompt. `{{name}}` is replaced by the argument of that name. At most 8192 characters. |
| `args` | no | Up to 20 single-line text fields, each `{ name, label, required? }`. `name` is lowercase letters, digits and underscores, starting with a letter. A template with no `args` fills the draft as soon as it is chosen. |

Every `{{name}}` in the body must name a declared argument; anything else is a manifest error. Values are inserted exactly as typed, once: a value that itself contains `{{other}}` is not expanded again. An optional argument left blank becomes empty text. Choosing a template replaces the current draft, and the replacement can be undone.

## Terminal links — _Shipped_

Terminal text a plugin makes clickable: the identifiers and URLs of its own world that agents print, such as `updated INV-0042` or a link to a record in a hosted service. A match is underlined on hover, its tooltip says "Open with" and the plugin's name, and clicking it dispatches one of the plugin's own commands. Matchers are declarative and require no capability. An installed plugin's matchers apply in every project's terminals; a [project plugin](./project-local.md)'s apply only in its own project's.

```json
{
  "contributes": {
    "commands": [
      { "id": "openInvoice", "title": "Open invoice" },
      { "id": "openRecord", "title": "Open record" }
    ],
    "terminalLinks": [
      {
        "id": "invoice",
        "pattern": "\\bINV-(\\d{4,8})\\b",
        "actionId": "acme.invoices.openInvoice"
      },
      {
        "id": "record",
        "url": { "host": "records.example.com", "pathPrefix": "/records/" },
        "actionId": "acme.invoices.openRecord"
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Unique within the plugin's `terminalLinks`. |
| `actionId` | yes | One of the plugin's own commands, written `"<plugin name>.<id>"`. When the plugin declares `commands`, it must name one of them. Built-in and other plugins' actions are refused. |
| `pattern` | one of `pattern` or `url` | A JavaScript regular expression, matched within one terminal row. See the rules below. |
| `ignoreCase` | no | Match `pattern` without regard to case. Only with `pattern`. |
| `url` | one of `pattern` or `url` | `{ scheme?, host, pathPrefix? }`: the URLs the plugin claims. |
| `url.scheme` | no | `"https"` (the default) or `"http"`. |
| `url.host` | yes | One exact, lowercase public domain with at least two labels, such as `records.example.com`. No port, path, credentials, wildcard or IP address, and nothing loopback, private or local-only (`localhost`, `*.local`, `*.internal`, `*.test`, `*.lan` and the like): those URLs belong to the browser and dev preview panels. |
| `url.pathPrefix` | no | The URL's path must start with it, as plain text. End it with `/` to match a folder. No query, fragment or `.`/`..` segments. |

**What the command receives.** A pattern match dispatches `actionId` with `TerminalLinkPatternArgs`: `{ text, groups, panelId, panelKind, worktreeId? }`, where `groups` holds the capture groups by position and `null` for an optional group that matched nothing. A claimed URL dispatches it with `TerminalLinkUrlArgs`: `{ url, panelId, panelKind, worktreeId? }`, instead of opening the browser. `worktreeId` is absent for a terminal outside any worktree. If the command declares an `inputSchema` with `additionalProperties: false`, list every one of these fields in it, or the call is refused. Both types are exported from `@daintreehq/plugin-sdk`.

**Pattern rules.** Patterns run in a worker beside the terminal, never on its own thread, and the manifest gate also refuses any whose backtracking could run away. A pattern compiles with the `u` flag (you can't add flags), is at most 256 characters, and must not match empty text. It may not use backreferences, lookarounds or named groups, and has at most 16 capture groups. A group repeated more than once may not itself repeat or have alternatives: write `[a-z]+` rather than `(a|b|...)+`, and `(?:-\d{1,4})?` rather than `(?:-\d+)*`. The product of every quantifier's maximum, counting an unbounded `*`, `+` or `{n,}` as 512, and of every alternation's branch count, may not exceed 1,000,000. So a pattern can have two unbounded quantifiers at most; bound the rest, as in `\w{1,64}`. A pattern that still runs slowly on a real row, or doesn't finish within a second, is switched off for the session.

**How matching works.**

- Matching runs in the host, only for the row under the pointer, and never on terminal output. The first 512 characters of the row are read. A match must fit on one row, is at most 256 characters long, and each row offers at most 32 plugin links.
- Built-in links win any overlap: a file path, web URL, figure reference or suggested command is never taken over by a pattern. Between plugins, the first plugin by id keeps an overlapping match.
- URL matchers don't find URLs themselves. They claim the web links Daintree already detects, including OSC 8 hyperlinks. When two plugins claim a URL, the longer `pathPrefix` wins, then the first plugin by id. The URL is parsed before it is compared, so a credential prefix, a non-default port or a lookalike host never matches. The host check reads the URL alone and never resolves the name, so a public-looking domain that your DNS points at a private address can still be claimed.
- Only the matched text leaves the terminal, and only when the user clicks. A matcher grants no `terminal:read` access.
- A URL a plugin claims keeps "Open in external browser" in the terminal's right-click menu, beside "Open with" and the plugin's name.

Each plugin's matchers can be switched off from its page in the Plugin Manager, or from Project settings → Plugins for a project plugin. The choice is stored on this machine and applies in every terminal at once.

## Context providers — _Shipped_

`@` context the agent composer offers from the plugin's own data: a record, a page, a ticket, a row. A provider claims a short prefix such as `rec`; typing `@rec:` in an agent's input bar lists the provider's matches for what follows, and picking one leaves an `@rec:{id}` chip in the draft under the plugin's name. Nothing is read then. When the user sends, the host asks the provider for the item's current content and puts it in the same literal `daintree-context` block a hand-off drafts, so the agent gets the item as it is at that moment and nothing inside it is read as an `@` token. A provider never submits. Context providers require no capability: the host asks only for what the user picked. An installed plugin's providers are offered in every project; a [project plugin](./project-local.md)'s only in its own project.

```json
{
  "contributes": {
    "contextProviders": [{ "id": "records", "prefix": "rec", "label": "Records" }]
  }
}
```

```ts
export async function activate(host: PluginHostApi) {
  await host.registerContextProvider(
    { id: "records" },
    {
      async search(query, { signal }) {
        const rows = await findRecords(query, { signal });
        return rows.map((r) => ({ id: String(r.id), label: r.title, description: r.status }));
      },
      async resolve(id, { signal }) {
        const record = await loadRecord(id, { signal });
        return record ? { title: record.title, text: renderRecord(record) } : null;
      },
    }
  );
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Unique within the plugin's `contextProviders`; `host.registerContextProvider` binds to it. |
| `prefix` | yes | One to sixteen lowercase letters. Never `diff`, `terminal` or `selection`, which the composer reserves, and never two of the plugin's own providers' prefix. |
| `label` | yes | What the provider offers ("Records"). Shown on its chips' card and in Project settings. At most 60 characters. |

**The impl.** `search(query, { signal })` gets only what the user typed after `@{prefix}:` — never the rest of the draft — and returns at most 50 `{ id, label, description? }` rows, best first. `resolve(id, { signal })` returns `{ text, title? }`, or `null` when the item is gone. An item `id` is one draft token: up to 128 letters, digits and `_ - . : / # ~ + =`, not ending in `.` or `:`. Rows with any other id are dropped.

**Deadlines.** A search has 3 seconds and a resolve 5, both counted from the host's request, so a plugin's first activation is inside them. When the host stops waiting it aborts `signal`. All of a draft's chips resolve in parallel, at most 20 distinct items per message. A chip whose provider fails, times out, returns `null` or returns more than 32,768 characters sends as a visible placeholder in its place (`[Couldn't attach @rec:142 from Kanban: timed out]`) rather than holding the send. Content is never cut short to fit.

**Prefix collisions.** The first plugin to claim a prefix holds it wherever both are visible; a later one is refused that prefix, keeps its other contributions, and is listed under Project settings → Plugins → Context providers with the plugin that holds it. Switching the holder's providers off there hands the prefix to the next plugin in line. Project plugins in different projects never collide.

**Switching off.** Each plugin's providers have one switch in Project settings → Plugins. An installed plugin's switch applies to every project; a project plugin's to its own project. A chip whose provider is switched off sends as a placeholder.

**Remote terminals.** A terminal on another host keeps its context rules: chips aren't drawn there and `@{prefix}:{id}` is sent as typed, like `@diff`.

**Drag.** A view can drag an item by reference instead of a snapshot: `ContextDragSource` with `reference={{ prefix, id, label }}`, or `setAgentContextDragData(dataTransfer, { v: 2, reference })` by hand. Dropping it on an agent leaves the same chip the `@` menu would. A drop is refused when no provider in the project holds the prefix.

## Recipes — _Shipped_

Named multi-terminal launch layouts a plugin ships. A contributed recipe is registered under the qualified id `{pluginId}.{id}`, merged into the recipe list as a plugin-owned tier, and available in **every** project — a plugin that ships an agent can also ship a ready-made layout that runs it, with no per-project setup. A [project plugin](./project-local.md)'s recipes are the exception: they appear only in the project that owns the plugin, and come and go with its switch and its folder's trust.

```json
{
  "contributes": {
    "recipes": [
      {
        "id": "review-loop",
        "name": "Review loop",
        "showInEmptyState": true,
        "terminals": [
          {
            "type": "acme-reviewer",
            "initialPrompt": "Review the working tree",
            "args": "--strict"
          },
          { "type": "terminal", "command": "npm run test:watch" }
        ]
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced as `{pluginId}.{id}`. |
| `name` | yes | Human label, shown in the recipe manager and in the install confirmation. At most 200 characters. |
| `terminals` | yes | 1–10 terminal definitions. See the table below. |
| `showInEmptyState` | no | Default for the empty-state pin. A user pin/unpin overrides it. |
| `autoAssign` | no | `always` \| `never` \| `prompt` — default issue auto-assign behaviour during quick worktree creation. A user choice overrides it. |
| `variables` | no | Names the prompts may use as `{{plugin.<name>}}`, filled by [`host.runRecipe`](./host-api.md#runrecipe--offer-to-run-one-of-your-recipes). Lowercase letters, digits and underscores, starting with a letter; at most 20. A prompt using an undeclared one is a manifest error (`recipe_variable_undeclared`). |
| `requiresAgentTools` | no | The recipe's agents need this plugin's [agent tools](./agent-extensions.md). While they're off in the project, or Daintree's MCP server is off, a launch is refused with a message saying so, instead of starting the agents without them. It never turns them on. Needs `contributes.agentMcp` or `contributes.databases` and at least one agent step. |

**Terminal fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `type` | yes | `terminal`, `dev-preview`, `plugin-panel`, a built-in agent id, or an agent id **this same plugin** contributes. Any other value drops that terminal at load. At most 64 characters. |
| `title` | no | Custom pane title. At most 200 characters. |
| `command` | no | Shell command, for `type: "terminal"`. At most 4096 characters. |
| `devCommand` | no | Dev-server command, for `type: "dev-preview"`. At most 4096 characters. |
| `initialPrompt` | no | Sent to an agent terminal after boot. Supports the same `{{issue_number}}` / `{{branch_name}}` variables user recipes do, plus the recipe's own `{{plugin.<name>}}`. At most 8192 characters. |
| `systemPrompt` | no | Standing instruction appended to an agent step's system prompt, on agents whose CLI supports one; a launch on one that doesn't fails that step. Takes the same variables as `initialPrompt`. At most 2000 characters. |
| `panelId` | for `plugin-panel` | One of **this plugin's own** `contributes.panels` ids (`recipe_panel_unknown` otherwise). |
| `panelArgs` | no | For `plugin-panel`: handed to the view as `initialArgs`, or as `openRequest` to a panel the step reuses. At most 8 KB of JSON; refused for a PTY-backed panel (`recipe_panel_args_pty`). |
| `args` | no | Extra CLI flags for an agent terminal, as one string. At most 4096 characters. |
| `env` | no | Environment variables for the spawned terminal. |
| `exitBehavior` | no | `keep` \| `trash` \| `remove`. |

**No capability required.** Recipes are declarative content, like [Skills](#skills--shipped) — a capability in an unsandboxed runtime would be a label rather than a gate. Disclosure happens where it can actually inform a decision instead: the sideload install confirmation lists every contributed recipe by name, which is why terminals are declared inline rather than pointing at a shipped JSON file (the installer reads the manifest without extracting the archive).

**Content is immutable.** The plugin owns what its recipes run; edits and deletes are rejected, and a plugin update replaces them wholesale. To customise one, use **Save to repo** — that duplicates it into a user-owned team recipe you can edit freely, leaving the plugin's original in place.

**Your own metadata survives.** Frecency (`lastUsedAt` / usage history), the empty-state pin, and `autoAssign` are yours, not the plugin's, so they live in a sidecar (`plugin-recipe-metadata.json` in the global config dir) keyed by qualified id. They persist across disable, reload, and plugin updates, and are purged only when you explicitly uninstall the plugin. A project plugin's metadata is kept even while its project is closed, since nothing outside the repository can tell a closed project from a removed one.

**Referencing your own agent.** A recipe terminal may name an agent id from the same plugin's `contributes.agents`. Ownership is resolved against the live registry, not the manifest: if another plugin already claimed that agent id, the terminal is dropped rather than silently launching someone else's agent.

**Opening your panel beside an agent.** A `plugin-panel` step opens one of your panels the way `panel.openPluginPanel` does: reusing an open one, in the recipe's worktree, or in the dock for a `scope: "project"` panel. Fields that belong to another kind of step are refused on it rather than ignored (`recipe_panel_step_fields`). Panel steps, plugin variables, system prompts and `requiresAgentTools` only work in your own recipe, so **Save to repo** and **Duplicate** refuse a recipe that uses them rather than copying a recipe that quietly does less.

```json
{
  "id": "review-record",
  "name": "Review record",
  "variables": ["record_id", "record_title"],
  "requiresAgentTools": true,
  "terminals": [
    { "type": "plugin-panel", "panelId": "records", "panelArgs": { "mode": "review" } },
    {
      "type": "claude",
      "initialPrompt": "Review {{plugin.record_title}} and note anything that looks wrong.",
      "systemPrompt": "You are reviewing ledger record {{plugin.record_id}}. Use the ledger tools to read it."
    }
  ]
}
```

**Running your own recipe.** Your plugin can offer to run one of its own recipes with values for its variables through [`host.runRecipe`](./host-api.md#runrecipe--offer-to-run-one-of-your-recipes) — "Open in agent" from your own panel, for example. Nothing starts until the user confirms a dialog showing every step resolved, final prompt and system prompt included. A recipe whose agent steps set `args` or `env` can't be run this way, since a plugin never chooses how an agent runs. A launch the user starts from the recipe list leaves a variable with no value empty, as a host variable with no value is.

**Agent-initiated runs are confirmation-gated.** Any agent or MCP dispatch that carries a `recipeId` — through `recipe.run` or a composite like `worktree.createWithRecipe` — pauses for a single human approval showing the resolved recipe, its origin, and the commands each terminal will run (env keys are listed, values are not). This applies to every recipe tier, not just plugin-contributed ones. An external MCP session bound to one workspace has no one watching that view to answer the dialog, so there the dispatch is refused outright rather than paused (#11789).

## Tours — _Shipped_

Welcome tours that play in the same dialog as the Daintree tour. An enabled plugin's tours register when it loads and are withdrawn when it is disabled, uninstalled or hidden in the project; a tour that is open at that moment closes, keeping the viewer's progress. A reload closes it too, and reopening plays the new version.

A tour without `panelKind` is a **plugin tour**, offered from Help and the command palette as "<plugin display name>: <title>" (for example "SvelteKit Site Builder: Welcome Tour"). A tour with `panelKind` is a **panel tour**, opened from that panel's three-dots menu as "<Panel name> Welcome Tour"; it keeps to a couple of chapters but is held to the same standard as any other tour. The panel's Welcome Tour item appears once its tour is registered and disappears when it is withdrawn, so the item never appears with nothing to play.

```json
{
  "contributes": {
    "panels": [
      { "id": "site-builder", "name": "Site Builder", "iconId": "globe", "color": "#336699" }
    ],
    "tours": [
      {
        "id": "site-builder-welcome",
        "title": "Site Builder Welcome Tour",
        "componentPath": "dist/tours/site-builder.js",
        "panelKind": "site-builder",
        "audioHosts": ["cdn.example.com"],
        "chapters": [
          {
            "id": "intro",
            "duration": 8.4,
            "cues": { "open-preview": 2.1 },
            "captions": [{ "start": 0, "end": 4.2, "text": "This is the site builder." }],
            "audioUrl": "https://cdn.example.com/tours/intro.mp3",
            "narrationHash": "3fa9c21e"
          },
          {
            "id": "publish",
            "duration": 6,
            "audioUrl": "tours/publish.mp3",
            "narrationHash": "0b7d1c44"
          }
        ]
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Unique within `contributes.tours`. |
| `title` | yes | Shown where the tour is offered. At most 120 characters. |
| `componentPath` | yes | Plugin-relative module exporting the chapter scenes, same path rules as a view's. |
| `panelKind` | no | Makes it a panel tour. Must be the `id` of one of this plugin's own `contributes.panels`. That panel's three-dots and right-click menus offer it with no wiring in your view; if two tours name the same panel, the first wins. |
| `audioHosts` | no | Bare hostnames remote narration is fetched from, at most 8 and no duplicates. No scheme, port, wildcard, IP literal or private host. |
| `chapters` | yes | 1–32 chapters, played in order. |
| `chapters[].id` | yes | Unique within the tour. Letters, digits, `.`, `_` and `-`, at most 64 characters. |
| `chapters[].duration` | yes | Seconds, up to 600. |
| `chapters[].cues` | no | Named scene cues in seconds; each must fall within `duration`. At most 128 per chapter; a name is letters, digits, `.`, `_` and `-`, at most 64 characters, and `__proto__` is reserved. |
| `chapters[].captions` | no | `{ start, end, text }` in seconds; each must end after it starts and within `duration`. At most 128 per chapter; `text` is 1–500 characters. |
| `chapters[].audioUrl` | yes | A plugin-relative audio file, an `https://` URL on a host listed in `audioHosts`, or `null` for a silent chapter. At most 4096 characters, with no leading or trailing whitespace or control characters. |
| `chapters[].narrationHash` | yes | The 8-character lowercase hex fingerprint of the narration the timing was generated from. |

**Shipping one.** [Tours](./tours.md) is the full guide: the file layout, a minimal tour to copy, writing narration with `[[cue]]` markers, building scenes with `@daintreehq/tour/kit` and the mock Daintree window, the anchor-naming contract, voicing with `daintree-plugin tour voice` or your own recordings with `tour align`, previewing with `tour preview`, and the house style every tour is held to. In short: you write the narration and a scene module that default-exports `{ scenes, chapterTitles?, mockKit? }`, and the CLI writes `chapters` for you. The bundled `daintree-tour` Claude Code skill (`npx daintree-plugin skill add`) walks through the whole path.

A malformed tour is reported with the offending path, like any other malformed contribution: `daintree-plugin validate` and the installer refuse it, and at load Daintree logs the issues and drops only that tour, so the rest of the plugin still loads. Exceeding the cap of 10 tours is still a whole-manifest error. Audio that is missing, refused or blocked leaves the chapter playing silently with its captions. A project plugin's tours are offered only in its own project, and their progress is kept separately from the same plugin's tours in any other project.

## Surfaces — _Shipped (project scope only)_

`contributes.surfaces` lets a **project-local** plugin replace one of Daintree's own surfaces for its own project, so a project can present as a purpose-built application rather than as the host with one extra panel. It is the only contribution point that replaces something the host already draws.

Available to `"scope": "project"` plugins alone. An installed plugin is bound to no project, so there would be nothing to scope the claim to and no project registry to arbitrate a second claimant against; a manifest without `"scope": "project"` that declares any surface is rejected at validation.

```json
{
  "scope": "project",
  "contributes": {
    "panels": [
      {
        "id": "overview",
        "name": "Overview",
        "iconId": "gauge",
        "color": "var(--theme-category-orange)"
      }
    ],
    "views": [{ "id": "overview", "componentPath": "dist/panel.js", "location": "panel" }],
    "surfaces": {
      "emptyCanvas": { "viewId": "overview" }
    }
  }
}
```

| Slot | Replaces |
| --- | --- |
| `emptyCanvas` | What the content grid draws when the project has no panels open — the region the stock launcher lives in |
| `projectHome` | Nothing: it adds a Home the main area can switch to beside the grid, behind a host-drawn Home/Grid switch, remembered per project |
| `worktreeCreate` | The stock New worktree dialog, when it opens through `worktree.createDialog.open`; the host draws a Standard dialog… link beside your view |

Fleet scope and a maximized panel still draw over Home, and focusing, spawning, moving or restoring a grid panel returns to the grid. On Home the slot's own strip sits below the view, and its "No home" choice removes the Home entry. Home is a route, not a URL.

Rules:

- **Slot-replacing, never removing.** Surrounding chrome is untouched: the project switcher, the sidebar and the worktree dashboard stay where they are. The host draws a thin strip of its own above the region, outside the view's box, carrying a switch between the panel name and the stock launcher and, while the surface shows, an icon button for the launcher's search, so a broken or half-finished surface cannot strand the user. Nothing overlaps the view, so it needs no reserved space.
- **The user decides whether it stays.** The first time a claimed surface would show in a project, a notice names the plugin and offers to keep it or use the launcher. The answer, whether given there or with the strip's switch, is remembered per project in Daintree's own settings, never in the repository, and is shown with a reset under the project's plugin settings. A slot that passes to a different plugin asks again.
- **`viewId` must name a declared `contributes.views` entry**, cross-checked at validation like any other dangling reference (`surface_view_ref_unknown`). It must not name a panel with `hasPty: true` (`surface_view_ref_pty`) — a PTY panel is rendered by the terminal host and never loads the view module, so the claim would hold the slot and draw nothing — nor a `location: "settings"` view (`surface_view_ref_settings`), which renders only in the plugin's settings.
- **At most one plugin per slot per project.** The lower manifest id wins, independent of load order; the other claimant is refused and named alongside the winner in the log, Project settings → Plugins, the Plugin Manager and `daintree-plugin doctor`, so the author can tell which manifest to change. Never a silent last-wins. The refused plugin still loads and its other contributions work, and its claim is remembered — it inherits the slot if the winner later unloads.
- The surface view receives the standard `PanelViewProps` (`panelId`, `pluginId`, `disposeSignal`) and sits inside the standard plugin error boundary, so a crash falls back with a working "Try again" rather than a blank region.

`defaultLayout` names a `contributes.layouts[].id` of the same plugin (`surface_default_layout_unknown` otherwise) as the arrangement the project starts in. On the project's first open on this machine (no saved state, not safe mode, and nothing unreadable), the host opens that layout's panels and browser pages once, provided the grid and dock are still empty when the layout arrives, which is usually after trust is granted. If the user has opened something first, a strip at the top of the grid offers to open it instead. The layout's recipes never start on open: each is listed as a Start button that goes through the layout's confirmation. Whether the seed has run is recorded per project on this machine, so it never runs twice. It is not a slot and has no switch or answer of its own.

## Themes — _Shipped_

Ships app themes. Each one is offered in Settings → Appearance, grouped under the plugin's name, and in the theme palette, and the user applies it like a built-in theme. Installed and built-in plugins only; a `scope: "project"` plugin is refused until per-project themes exist.

```json
{
  "contributes": {
    "themes": [
      {
        "id": "midnight",
        "name": "Midnight",
        "type": "dark",
        "path": "./themes/midnight.json"
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced as `plugin:{pluginId}:{id}`, so it can never shadow a built-in or imported theme. |
| `name` | yes | Shown in Appearance, the theme palette, and the notice when the theme stops being offered. |
| `type` | yes | `"dark"` or `"light"`. The palette's own `type` must match. |
| `path` | yes | JSON file relative to the plugin directory, at most 128 KiB, at most 20 themes per plugin. |

The file holds a `palette` in the same shape as Daintree's built-in theme sources, plus optional `tokens` and `extensions` overrides. Overrides are limited to the registered token and extension sets. See [Theme system](../themes/theme-system.md) for the palette and token model.

```json
{
  "palette": { "type": "dark", "surfaces": { "grid": "#0e0f12", "…": "…" }, "…": "…" },
  "tokens": { "overlay-highlight": "#2a2d35" },
  "extensions": {}
}
```

Validation is strict. A missing palette field, an unknown key, a token or extension outside the registered sets, or a value that isn't a single CSS value refuses the theme rather than being dropped. A theme can't load anything: the only resource a value may carry is an embedded `url("data:image/…")` texture, like the built-in grain.

**The contrast checks are a gate, not a warning.** A theme is offered only if it passes every check an imported theme is warned about: the text, accent, status, terminal, syntax and overlay contrast pairs that Daintree's built-in themes are held to. A pair the checks can't evaluate fails too. That covers a non-hex value, and a light theme that leaves the engine's `color-mix()` overlay tokens in place. Set those tokens to hex values, as the built-in light themes do. A refused theme never appears in Appearance, and the reason is written to the plugin's log in the Plugin Manager. The plugin's other contributions are unaffected.

A plugin theme is chosen directly. It can't be the theme for a "Match system appearance" slot. The selected theme's palette is saved with the choice, so it paints on the first frame after a restart, before any plugin has loaded. If the plugin is disabled, uninstalled or blocked, or an update stops offering the theme, Daintree switches to the user's preferred built-in theme of the same polarity and says so.

## Forge providers — _Shipped_

Registers a forge backend — issues, pull/merge requests, reviews, CI roll-up, releases, and auth for a developer platform that sits on top of git. The first-party GitHub plugin (`plugins/builtin/github/`) is a forge provider.

```json
{
  "contributes": {
    "forgeProviders": [
      {
        "id": "gitea",
        "name": "Gitea",
        "matches": ["gitea.io", "gitea.example.com"],
        "capabilities": ["issues", "pulls", "required-checks"]
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}` (the built-in GitHub plugin uses bare `github`). Must match the `descriptor.id` passed to `registerForgeProvider`. |
| `name` | yes | Display label in Preferences → Forge Integrations. |
| `matches` | yes | List of exact hostnames. The host extracts the hostname from the project's git remote (HTTPS/SSH/SCP-form URLs handled), lowercases and trims it, then matches for **exact string equality** — no glob, wildcard, or suffix matching. List every distinct hostname your forge serves as a separate entry. First matching provider wins. |
| `kind` | no | `"network"` (the default) for a provider that talks to a remote forge, or `"local"` for one backed by files or a CLI. Display-only: Preferences uses it to label a provider with no `credentialFields` as deliberately authless; the host never gates auth or routing on it. |
| `capabilities` | no | Informational hints driving the Preferences "supports: …" display only; the host does not interpret them. Behavior gates on whether the runtime capability field is present. |
| `credentialFields` | no | Array of `{ id, label, type, placeholder?, helpText? }` declaring the auth fields this provider needs. Drives the generated credential form in Preferences → Forge Integrations. Each `id` is letters, digits, `.`, `_` and `-`, at most 64 characters, and may not be `__proto__`, `constructor` or `prototype`. |
| `slots` | no | Renderer view ids for the provider's own UI, keyed by slot: `settingsTab`, `icon`, `statsDropdown`, `bulkCreateWorktreeDialog`, `issueSelector`. Checked for non-emptiness only; an id the renderer does not know renders a neutral fallback. |
| `settingsScopeRef` | no | A declared `contributes.settings[].id`, used to group provider settings. Validated at manifest parse time — a dangling ref is rejected (`forge_settings_scope_ref_unknown`). |
| `viewRefs` | no | IDs of `views` contributions shown under this provider's panel section. Each must resolve to a declared `contributes.views[].id`, else the manifest is rejected (`forge_view_ref_unknown`). |

The manifest entry is read eagerly so the provider populates Preferences and the remote-routing table before any plugin code runs; the implementation binds lazily in `activate()` via [`registerForgeProvider`](./host-api.md#registerforgeprovider). For the end-to-end walkthrough — implementing `ForgeProviderImpl`, state normalization, capabilities, and tests — see [Implementing a forge provider](./forge-provider.md).

**Built-in only in practice.** `ForgeProviderImpl` has synchronous methods (`parseRemote`, the URL builders) that cannot cross the plugin worker's asynchronous message port, and every plugin that is not built in runs in a worker. An installed plugin's `forgeProviders` entry is accepted and appears in Preferences, but `registerForgeProvider` from its worker only logs a warning and registers nothing, so the provider never becomes routable. A project plugin's entry is rejected at the manifest gate (`forge_provider_project_scope_forbidden`).

## File decoration providers — _Shipped_

Registers a provider that decorates files (or other scoped resources) with status badges, colors, and tooltips. The manifest declares which **scopes** the provider handles so the renderer can route decoration pulls before the plugin's code has run. The first-party GitHub plugin (`plugins/builtin/github/`) uses one to decorate the worktree diff/review surface.

```json
{
  "contributes": {
    "fileDecorationProviders": [
      {
        "id": "worktree-diff-review",
        "scopes": ["worktree-diff:*"]
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}`. Must match the `id` passed when the provider binds at runtime. |
| `scopes` | yes | Non-empty list of scope patterns the provider answers for: an exact scope string, or a prefix ending in `*` — `worktree-diff:*` matches every resource the host routes under the `worktree-diff` namespace, and `*` alone matches every scope. A decoration pull goes to every provider with a matching pattern, activating its plugin first if needed, and their answers are merged (below). |

**Host-routed scopes:**

| Scope | Surface | Notes |
| --- | --- | --- |
| `worktree-diff:<worktreePath>` | Review Hub changed-file rows (base-branch diff, linked PR) | Used by the first-party GitHub plugin to badge PR-review state. |
| `worktree-files:<worktreePath>` | Local worktree file-change list (`FileChangeList` in the worktree card) | Local-only — no PR or remote required. Use this to badge a worktree's changed files from a lint/leak/status plugin. The file browser tree requests the same scope for its visible rows, with paths relative to the worktree or workspace root. |

Keep these scopes distinct: a provider registered for `worktree-diff:*` is **not** invoked on the local `worktree-files:*` list and vice versa, so PR-review badges don't leak onto the plain change list. The path strings the host passes (and that your provider keys its returned map by) are the worktree's changed-file paths as the surface renders them.

The manifest entry is read eagerly so the host's decoration-routing table (`electron/services/fileDecorationRegistry.ts`) knows which provider owns a scope before any plugin code runs; the implementation binds lazily in `activate()`. See [Host API](./host-api.md) for the runtime registration signature.

When more than one provider matches a scope, their decorations merge per path and per field (`badge`, `tooltip`, `color`, `url`), first writer wins, with a project-local plugin ahead of installed ones and load order within each group — so the second provider's badge for a shared path is silently dropped. A provider that rejects, or doesn't answer within 3 seconds, is skipped for that pull, and entries for paths the host didn't ask about are discarded. When two plugins declare the **same exact scope string**, the host emits a `console.warn` at registration time naming both plugins and the duplicated scope so the collision is detectable. A request only reaches plugins visible in the requesting project: a project-local plugin decorates its own project's files and no other's, and an installed plugin switched off for a project neither decorates it nor is started by it. (Broad/narrow coexistence — a `worktree-files:*` provider alongside a `worktree-files:/some/path` one — is intentional and not warned, though the two still merge the same way.)

From your `activate()` subscriptions and timers, call `host.invalidateFileDecorations(scope, paths?)` to signal that a scope's decorations changed and any renderer showing them should re-pull.

On the worktree card, a decoration renders as the app's count pill in its own column at the end of the row, with the `tooltip` text added under the file path in the row's own tooltip (on hover and on keyboard focus) and read out as the row's description. Keep `badge` to two characters; a longer badge widens the column for the whole list. A decoration with a `url` is underlined, opens the link when its badge is clicked, and adds **Open in browser** to the row's context menu, which is how keyboard users reach it. If you pass a `color`, you own its contrast: a status wash under primary text (`bg-status-error/20 text-text-primary`) holds 4.5:1 across the built-in themes, while status-coloured text on its own wash does not.

## Worktree setup steps — _Shipped_

Work a plugin does for each worktree Daintree creates, after the project's own setup: provisioning a preview database, seeding fixtures, registering the branch with an outside service. The step is declared here and its handler bound in `activate()` with `host.registerWorktreeSetupStep` (see [Host API](./host-api.md#worktree-setup-steps)).

```json
{
  "contributes": {
    "worktreeSetupSteps": [{ "id": "provision-db", "label": "Provision DB", "timeoutMs": 120000 }]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Unique within the plugin. The handler registers under it; an undeclared id is rejected. |
| `label` | yes | Up to 80 characters. Shown on the worktree card while the step runs ("Running setup: Provision DB (Acme)") and when asking the user to allow it. |
| `timeoutMs` | no | 1 second to 30 minutes, default 5 minutes. When it passes, the handler's `signal` aborts and the step is recorded as timed out. |

At most 10 steps per plugin.

**When steps run.** After config copy, submodules and the project's setup script, and only when that script succeeded: a step may depend on what it installed. Steps run one at a time, ordered by plugin id and then as the manifest lists them. Each one's failure is recorded and the next still runs, so one plugin can't hold another's setup up. The worktree's setup stays `running` until every step settles, so `worktree.waitUntilReady`, a new worktree's first agent, and a recipe that starts an agent all wait for them.

**What the worktree records.** Every step is recorded against the worktree with its own outcome: succeeded, failed, timed out, waiting for approval, or skipped. A step is skipped when its plugin couldn't run it: it would not activate, never bound a handler, or is no longer loaded for the project when setup is retried. A skipped step is never a success. Setup is `ready` only when every step succeeded; otherwise it settles `failed` or `timed-out` with stage `plugin-steps` and an error naming the plugin and step, or `needs-approval` when a step hasn't been allowed. Retry setup from the worktree card (or `worktree.lifecycle.retrySetup`) reruns only the steps that didn't succeed, without rerunning the setup script, so a handler must tolerate running again. A step whose plugin was upgraded since it succeeded runs again, once its new version is allowed.

**Consent.** The user allows each step once per project, from the worktree card: "Acme will run "Provision DB" when worktrees are created". Until then the step doesn't run and setup waits at `needs-approval`; the setup script and other allowed steps still run. A new plugin version, label or timeout asks again. See [Trust model](./trust-model.md#worktree-setup-steps).

**Where the code comes from.** The step runs from the plugin as it is loaded for the project, never from the new worktree's branch. A project plugin's step is the copy in the project root, not whatever the branch being checked out carries, and a worktree whose branch changes the plugin still gets the version that was loaded.

**Not a teardown hook.** Nothing calls a plugin back when the worktree is deleted; a step still running is cancelled through its `signal`. A resource that costs money while it runs belongs in a resource environment (`resources` in `.daintree/config.json`), which pairs provision with teardown and is torn down with the worktree. Use a setup step for work that is cheap to leave behind, or that the plugin cleans up on its own schedule.

## File editors — _Shipped_

Declares an editor the host's file panel offers for matching files. An entry takes one of two forms.

A **view-backed** editor names one of the plugin's own `location: "fileEditor"` views. `"mode": "edit"` fills the file panel's writable **Edit** mode; `"mode": "view"` fills **Rendered** for a type the host can't render itself (CSV, data exports). Any plugin may declare one. Installed plugins match by extension; a `"scope": "project"` plugin may also match project-relative `paths`, and its editors only ever appear in its own project.

```json
{
  "contributes": {
    "views": [
      { "id": "records-editor", "componentPath": "dist/editor.js", "location": "fileEditor" }
    ],
    "fileEditors": [
      {
        "id": "records",
        "view": "records-editor",
        "mode": "edit",
        "extensions": ["json"],
        "paths": ["content/entries/*.json"],
        "maxBytes": 1048576
      }
    ]
  }
}
```

A **slot-backed** editor names a builtin view the plugin's renderer registers with `registerBuiltinView`. It is built-in only: the builtin view registry is compiled into the host bundle, which no other plugin's renderer reaches, so the manifest is refused (`fileEditors_slot_builtin_only`) from any other origin. The first-party Markdown editor (`plugins/builtin/markdown-editor/`) is the one slot-backed contributor.

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}`. |
| `view` | one of `view`/`slot` | Id of one of this plugin's `location: "fileEditor"` views. Such a view needs no panel and may not share an id with one, and neither a surface nor a toolbar popover can claim it (`surface_view_ref_file_editor`, `toolbar_popover_view_file_editor`). |
| `mode` | with `view` | `"edit"` or `"view"`. A `view` editor's document is read-only. |
| `slot` | one of `view`/`slot` | Built-in plugins only. The builtin view id the plugin's renderer registers; always an Edit mode matched by extension. |
| `extensions` | `extensions` and/or `paths` | Bare lower-case suffixes without the dot (`[a-z0-9]+`, 1–16 characters each, 1–20 entries), matched case-insensitively against the file name. |
| `paths` | `extensions` and/or `paths` | `"scope": "project"` plugins only (`fileEditors_paths_project_only`). Up to 20 globs relative to the project or worktree root, forward slashes only: `**` as a whole segment matches any number of directories, `*` any run within one segment, `?` one character; everything else is literal and case-sensitive. No leading `/`, drive letter, `..`, backslash or `!` negation. |
| `maxBytes` | no | Largest file the editor accepts, a positive integer. Above it the file stays viewable and the editor is not offered; the host document also refuses larger reads and saves. Defaults to 2 MiB; capped at 64 MiB. |

**Choosing an editor.** The host's own editor or renderer stays the default; an installed or project editor adds a choice rather than displacing it. When more than one editor can fill a mode, the panel's toolbar shows **Edit with…** (or **View with…** for Rendered), and the pick is remembered per project and per file type in Daintree's own settings, never in the repository. A mode a plugin fills is labelled with the plugin's name (`Edit · Acme records`), and Source is always one click away.

**The host-owned document.** A view-backed editor's view receives `PanelViewProps.fileDocument` (`PluginFileDocument` in the SDK): `read()` returns the text and an opaque revision; `save(text, { expectedRevision })` writes only if the file is still at that revision, checked in the main process at write time, and otherwise returns `conflict` without writing; `setDraft(text | null)` reports unsaved text, and `setConflict` raises a conflict the editor detected itself; `onDidChange` reports a disk change, a save made by the host, or a discard. The host keeps the draft, so it survives a switch to Source and back, and the dirty mark, the draft-aware Rendered preview and the Save / Discard / Cancel prompt on close apply exactly as for the built-in editor. Text is UTF-8 with lines joined by `\n`; a save keeps the file's BOM, dominant line ending and mode.

The host offers editors inside the file browser’s existing content area (built-in editors only) and in standalone file panels (the standalone file viewer dialog stays read-only), only inside a project or worktree root. Plugin editors load only when chosen, so they never weigh on the file panel's first render.

## Preview tools — _Shipped (built-in only)_

Declares a tool the dev-preview panel offers in its toolbar: a toggle, a strip under the toolbar and a drawer beside the page, with the host owning the chrome and the session lifecycle. SvelteKit Tools (`plugins/builtin/sveltekit-builder/`) is the one contributor.

The components stay a renderer-side registration — `registerDevPreviewTool` in the plugin's renderer entry, because they are compiled into the host bundle and nothing else can supply them. This declaration is what makes the tool **admissible**: `src/registry/devPreviewToolRegistry.ts` hides a registered tool whose plugin's manifest does not name its id, so a module side effect alone can no longer put a tool in the preview toolbar. [Views → Dev preview tools](./views.md#dev-preview-tools) is the lifecycle.

```json
{
  "contributes": {
    "previewTools": [
      {
        "id": "daintree.sveltekit-builder.builder",
        "title": "SvelteKit Tools",
        "iconId": "square-dashed-mouse-pointer",
        "guestAdapter": "daintree.sveltekit-builder.guest"
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | **Not** namespaced by the host — the renderer entry registers with this same literal, so the manifest declares the qualified form: the plugin's own name plus exactly one more segment (`daintree.sveltekit-builder.builder`), at most 200 characters. |
| `title` | yes | The tool's name, trimmed, 1–64 characters. The registration supplies the rendered label; this states what the plugin ships. |
| `iconId` | no | At most 64 characters. Advisory, like `views[].iconId` — the tool's own `Button` owns the rendered glyph. |
| `guestAdapter` | no | A [guest adapter](#guest-adapters--shipped-built-in-only) id **this same manifest** declares. A tool naming an adapter nothing declares is a manifest error. |

**Built-in only.** The toolbar button, drawer and session all resolve out of the host bundle, which an installed plugin's renderer cannot register into — the same obstacle as [file editors](#file-editors--shipped-built-in-only). Unlike that one the refusal is in the manifest schema rather than at load, because the schema is built per discovery root, so a sample or project manifest fails `npm run check:plugin-manifests` instead of only at runtime. [The preview-extension boundary is deliberate](#the-preview-extension-boundary-is-deliberate) says why it stands.

## Guest adapters — _Shipped (built-in only)_

Declares a browser bundle the host reads back as text and installs into a previewed page through the site-preview bridge. A binding names an adapter id and the host loads that adapter's body itself; there is no way for a caller to put source on the wire (`electron/services/sitePreview/guestAdapters.ts`).

```json
{
  "contributes": {
    "guestAdapters": [
      {
        "id": "daintree.sveltekit-builder.guest",
        "entry": "renderer/guest/entry.ts"
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | The literal the page runtime binds with, so it is not namespaced by the host — the plugin's own name plus exactly one more segment, at most 200 characters. That segment also names the built asset (below). |
| `entry` | yes | Plugin-relative POSIX path to the bundle's source, at most 256 characters, ending in `.ts`, `.tsx`, `.js` or `.mjs`. No absolute path, backslash, NUL or `:`; no empty, `.` or `..` segment; and it may not start with `guest/` in any case, the directory the build writes the bundle into. |

**The built asset's path is derived, never declared.** `guestAdapterAssetPath` (`electron/services/sitePreview/guestAdapterAssets.ts`) turns the adapter id into `guest/<id suffix>.js` under the plugin's output dir. `scripts/build-main.mjs` bundles `entry` to exactly that path — as a standalone browser IIFE, not a main entry and not part of the renderer bundle — and `registerBuiltinGuestAdapters` reads it back from the same place at startup, so there is no second path for the two to disagree about. A declared adapter whose bundle did not land fails the build.

**Built-in only.** The body is emitted by Daintree's own build and then runs with full DOM access inside whatever site the user is previewing. The registry exists precisely so that only main, from an asset it shipped, chooses that code.

### The preview-extension boundary is deliberate

Preview tools, guest adapters and the workspace-scoped `fsForWorkspace` handle (`BuiltinPluginHostApi` in `shared/types/plugin.ts`, handed out only by the in-process built-in loader) are first-party by design, not a third-party surface left half-built. What makes them safe for a built-in is that its code ships with the app: its renderer half is compiled into the host bundle — which is also why a built-in's renderer may import host store modules directly, rather than only the shared React the import map provides — and its guest body is bundled by Daintree's own build. An installed plugin has neither, and the pieces that would replace them do not exist: no build that produces a browser bundle the host is willing to inject, no API narrow enough to hand a third party a page the user is developing under their own session, and no consent vocabulary that would let the user judge the request. `contributes.previewTools` and `contributes.guestAdapters` are therefore refused by the manifest schema outside a built-in discovery root, and none of these capabilities is advertised to installed plugins until that build, API and trust model exists.

## Agents — _Shipped (minimal tier)_

Teaches Daintree about a launchable agent CLI it doesn't ship in-tree, so the CLI shows up as a named, selectable agent rather than a generic shell. Requires the `agent:register` capability, which is surfaced to the user at install time.

```json
{
  "capabilities": ["agent:register"],
  "contributes": {
    "agents": [
      {
        "id": "acme",
        "name": "Acme Agent",
        "command": "acme",
        "args": ["--interactive"],
        "color": "#3366ff",
        "iconId": "claude",
        "supportsContextInjection": true
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Bare agent id (alphanumerics, `.`, `-`, `_`; ≤64 chars), and not `__proto__`, `constructor` or `prototype`. Additive for **new** IDs only — a collision with a built-in agent id is rejected at the manifest gate, and built-in entries always shadow plugin entries. Cross-plugin id conflicts resolve first-registered-wins. |
| `name` | yes | Display label for the agent, 1–100 characters. |
| `command` | yes | At most 256 characters, in one of two forms: a bare binary name resolved on `PATH`, with the same safe-id pattern as `id` (no shell metacharacters), or a `./`-prefixed path to a file inside the plugin, resolved against the plugin directory when the agent registers (`"./bin/agent.mjs"`). Absolute paths, backslashes, NUL, and empty, `.` or `..` segments are rejected. Supports `${settings:settingId}` — see below. |
| `args` | no | Default launch arguments (≤20 entries, each ≤256 characters, no `\r`, `\n` or NUL). Supports `${settings:settingId}` — see below. |
| `color` | yes | Brand color as a 6-digit hex (`#rrggbb`). |
| `iconId` | yes | At most 64 characters. **A different namespace from panel/toolbar icon IDs** — agents render bundled brand marks, so this must name one of Daintree's built-in agent IDs (`claude`, `codex`, `gemini`, …). A panel icon ID like `terminal` doesn't resolve here; unrecognized values silently fall back to the Claude mark. Shipping a custom icon asset isn't supported yet. |
| `supportsContextInjection` | no | Whether copy-tree context injection targets this agent. Defaults to `false`. |
| `launchMcp` | no | `{ "format": … }`, one of the additive mechanisms in [Agent MCP endpoints](./agent-extensions.md#agent-mcp-endpoints): `claude-mcp-config`, `codex-config-overrides`, `gemini-system-defaults`, `qwen-mcp-config`, `opencode-config-content`, `copilot-additional-mcp-config`, `amp-mcp-config`, `vibe-mcp-servers-env`. Declare the one your CLI actually merges over the user's own servers. It grants nothing: the agent gets the orchestration server and plugin endpoints only as the project's MCP tier and plugin access allow. Daintree owns any environment variable the format uses, so a manifest cannot name one. |

A plugin agent is launchable and selectable as a named entry in the effective registry. It launches as a named terminal. Without a `detection` block it runs as a plain named terminal whose working/waiting state Daintree doesn't track; declare `detection` (below) to wire it into the agent-state UI like a built-in agent. Without a `launchMcp` block a plugin agent is never handed Daintree's own MCP servers or any plugin's agent MCP credentials at launch; declare one (below) to receive them the way a built-in agent with the same mechanism does.

`command` and `args` support the same `${settings:settingId}` syntax as MCP servers — e.g. `"args": ["--token", "${settings:apiToken}"]`. Templates resolve at spawn time against the plugin's **user-scope** setting with that ID (project scope is never read). If a referenced setting is unset, the launch fails with a clear error rather than spawning the agent with a literal `${settings:…}` (or a silently blanked value) on its command line — so a missing credential surfaces as a spawn error instead of an opaque auth failure inside the agent. Unlike MCP server tokens, `${settings:*}` tokens in agent `command`/`args` are **not** validated at manifest parse time — an undeclared setting id only surfaces as a spawn-time error, not a load error.

**Output-pattern detection** is supported (#10587). An optional `detection` block on an agent contribution lets the plugin describe its working/waiting/completed states with regex patterns and confidence weights, so the agent joins the same agent-state UI as built-in agents instead of running as an untracked named terminal. The block is `strict` — a typo'd field is a loud manifest error.

| Field | Required | Notes |
| --- | --- | --- |
| `primaryPatterns` | yes | Non-empty array of regex strings that mark the agent as working. A `detection` block with no `primaryPatterns` is rejected. |
| `fallbackPatterns` / `bootCompletePatterns` / `promptPatterns` / `promptHintPatterns` / `completionPatterns` | no | Additional regex arrays for the corresponding detection tiers. |
| `scanLineCount` / `promptScanLineCount` | no | Integer line-window bounds (1–1000) for the matcher. |
| `debounceMs` / `promptFastPathMinQuietMs` | no | Integer millisecond timings (0–600000). |
| `primaryConfidence` / `fallbackConfidence` / `promptConfidence` / `completionConfidence` | no | Confidence weights in `[0, 1]` for a matched tier. |
| `titleStatePatterns` | no | `{ working, waiting }`, both required: arrays (≤50 entries, each 1–256 characters) of plain, case-sensitive substrings matched against the terminal title — not regular expressions. `working` is checked first. |

Every other pattern array holds at most 50 entries, and each entry is 1–256 characters and must compile as a JavaScript regular expression.

**Session resume** is supported (#13687). An optional `resume` block lets a restored or restarted pane reopen the agent's conversation instead of starting a new one. It's plain data, `strict`, and takes one of two kinds:

```json
"resume": {
  "kind": "session-id",
  "args": ["--resume", "{sessionId}"],
  "sessionIdPattern": "Resume this session with:\\s+\\S+ --resume (\\S+)",
  "quitCommand": "/exit"
}
```

```json
"resume": { "kind": "project-scoped", "args": ["--continue"] }
```

| Field | Kinds | Notes |
| --- | --- | --- |
| `kind` | both | `session-id` for a CLI that resumes by an id it prints, `project-scoped` for one that resumes the latest session in the launch directory. |
| `args` | both | Resume arguments, under the same rules as `args` above. In a `session-id` block exactly one entry contains `{sessionId}`, which is replaced by the captured id (it can be the whole entry or part of one, such as `--session={sessionId}`). No other field may contain it. |
| `sessionIdPattern` | `session-id` | Regex matched against the output the agent prints after `quitCommand`. Exactly one capture group, which is the id. Same bounds as a detection pattern, and it needs a `quitCommand`. Omit it when the agent prints no id: the pane then resumes only through `resumeLatestArgs`. |
| `quitCommand` | both | Text sent to the running agent at shutdown so it exits cleanly and prints its resume hint. Same rules as an `args` entry. |
| `resumeLatestArgs` | `session-id` | Arguments that reopen the most recent session in the launch directory, used when no id was captured. |

When a pane has no captured id, `project-scoped` args and `resumeLatestArgs` reopen the latest session in that directory. Only one pane per agent and directory gets that slot on restore; the others start fresh, so two panes never reopen the same conversation. A plugin agent's conversation is never described as surviving a project-folder move, whatever it declares.

## Process tools — _Shipped_

Teaches Daintree to recognize a CLI running inside a terminal pane, so the tab shows the plugin's icon instead of the generic terminal glyph. Detection normally runs off a fixed built-in list (npm, Vite, Docker, …); this is how a plugin that ships or wraps its own CLI gets the same treatment. Inert declarative data — no capability required.

```json
{
  "contributes": {
    "processTools": [
      { "command": "acme-cli", "iconId": "sparkles" },
      { "command": "acmec", "iconId": "sparkles" }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `command` | yes | Bare executable name to match (≤64 chars), lowercase, starting with a letter or digit and otherwise limited to letters, digits, `.`, `-`, `_`. Lowercase is enforced rather than normalized: the detector lower-cases every process name before lookup, so a mixed-case entry would silently never fire. **Omit the extension** — write `acme`, not `acme.exe` or `acme.py`; detection strips launcher and script suffixes before matching, so the suffixed form would never fire and is rejected. Additive for **new** commands only — a collision with a built-in tool command or a built-in agent CLI is rejected at the manifest gate, as are the package-manager exec subcommands (`exec`, `dlx`, `x`), which name a launcher rather than a tool. Shells and launcher wrappers are rejected for the same reason — they name the process that _runs_ a tool, so `sudo vite` or `bash -c "vite build"` would report the plugin instead of Vite: `sh`, `bash`, `zsh`, `fish`, `dash`, `ash`, `ksh`, `csh`, `tcsh`, `nu`, `pwsh`, `powershell`, `cmd`, `env`, `sudo`, `doas`, `su`, `command`, `nohup`, `setsid`, `xargs`, `time`, `timeout`, `nice`, `stdbuf`. Built-in entries always win at runtime. Declaring the same command twice in one manifest is rejected; a collision with _another plugin_ resolves first-registered-wins with a warning. |
| `iconId` | yes | Same namespace as `panels[].iconId` / `toolbarButtons[].iconId` — one of the generic plugin icon IDs (`terminal`, `package`, `sparkles`, `globe`, …) or a [custom SVG](#custom-icons) inside your plugin (`"./icons/acme.svg"`). **Not** the agent brand-mark namespace. A detected process with a custom icon is labelled with your plugin's display name. Advisory rather than enum-validated, so a manifest written for a newer host still loads: an ID outside the generic set falls back to `terminal` at load time, and `daintree-plugin validate` warns about it. The fallback is why naming a built-in ID (`claude`, `npm`) doesn't borrow that tool's mark, label, or detection priority. |

A tool with several aliases declares one entry per alias, each pointing at the same `iconId`. Up to 100 entries per manifest. There is no `tier` field: plugin detections rank at the same `tool` tier as named built-in tools, so `npm exec acme-cli` reports the plugin's CLI rather than npm.

`__proto__`, `constructor`, and `prototype` are rejected as command names.

Detections are registered at plugin load and mirrored into the pty-host process where detection actually runs, including across a pty-host restart. Unloading or disabling the plugin removes them; a terminal already running the command keeps its icon until the next detection pass, which reclassifies it to whatever else matches — a built-in tool, or the generic terminal chrome.

**No `label` field — yet.** Daintree currently derives a detected process's display name from its icon ID, and panel state retains only that ID, not the matched command. Since generic plugin icon IDs are shared across plugins, there is nowhere today to attribute a plugin-supplied label to. The visible effect is narrow: the terminal tab and panel header show the panel's own title, so the icon — the point of this contribution — is what changes. Only the send-to-agent palette renders the derived name, where a plugin-detected process reads as its icon ID.

This is a wiring gap rather than a hard limit — the detector already computes the matched process name and forwards it to the renderer, which discards it. Adding an optional `label` later is a backwards-compatible addition to the entry shape once panel state carries a process label.

## What's missing and why

A few surfaces I've decided **not** to expose as dedicated contribution points:

- **Agent provider SDKs.** Registering a launchable agent CLI is a contribution point (see [Agents](#agents--shipped-minimal-tier)), but a full model-provider SDK is not. Adding a new model backend is handled via OpenAI-compatible base URL configuration in Daintree's settings — the complexity of a full provider SDK isn't justified when 95% of users just need to point Daintree at a different endpoint.
- **Agent lifecycle hooks (PreToolUse, PostToolUse, Stop).** Not offered, and nothing else intercepts an agent's tool calls either. A plugin that wants agents to route work through it serves its own tools from an [agent MCP endpoint](#agent-mcp-endpoints--shipped); those tools can refuse or annotate what they are asked to do, but they never see the agent's calls to anything else. This is simpler than a dedicated hook API and reuses the MCP ecosystem.
- **Subagents.** Daintree spawns fresh agents natively. Plugins that want to compose agents use skills + MCP to drive the orchestration, not a dedicated subagent contribution.
- **Status bar items, tree views, editor decorations.** Daintree isn't an editor; these surfaces don't map cleanly to what we render. Revisit if a specific need emerges.

If you think a contribution point is missing, open an issue at [daintreehq/daintree](https://github.com/daintreehq/daintree/issues).
