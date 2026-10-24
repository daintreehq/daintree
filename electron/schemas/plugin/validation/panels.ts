import { z } from "zod";
import { BUILT_IN_ACTION_ID_SET, PANEL_MENU_ACTION_ID } from "../actions.js";
import type { ManifestValidationContext } from "./context.js";
import type { ParsedPluginManifest } from "../manifestShape.js";
import { isHttpUrl } from "../panels.js";

// A panel's `menu` offers only the plugin's OWN actions: each entry is
// dispatched with `{ panelId }`, which no built-in takes, and the panel
// menus already carry the host's commands. So a built-in id, allowed on
// the surfaces above, is refused here; the own-namespace rules match
// theirs, including the imperative escape hatch when no commands exist.
// A panel's `toolbar` follows the same rule, for the same reason.
export function validatePanelActionSurfaces(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { ownNamespacePrefix, declaredCommandActionIds } = context;
  manifest.contributes.panels.forEach((panel, panelIndex) => {
    const surfaces = [
      { key: "menu", noun: "menu", items: panel.menu ?? [] },
      { key: "toolbar", noun: "toolbar", items: panel.toolbar ?? [] },
    ] as const;
    for (const surface of surfaces) {
      surface.items.forEach((item, itemIndex) => {
        const { actionId } = item;
        const issuePath = ["contributes", "panels", panelIndex, surface.key, itemIndex, "actionId"];
        if (
          !actionId.startsWith(ownNamespacePrefix) ||
          actionId.length === ownNamespacePrefix.length ||
          !PANEL_MENU_ACTION_ID.test(actionId)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: issuePath,
            message: `Panel ${surface.noun} actionId "${actionId}" must be one of this plugin's own actions, written "${manifest.name}.<id>" — a panel's ${surface.noun} can't offer built-in or other plugins' actions.`,
            params: { errorCode: `panel_${surface.key}_action_not_own` },
          });
          return;
        }
        if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: issuePath,
            message: `Panel ${surface.noun} actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
            params: { errorCode: "action_id_undeclared_command" },
          });
        }
      });
    }
  });
}

// A toolbar button does one thing on click. With neither it is a dead
// button; with both, the host would have to pick one and silently drop
// the other.
export function validateToolbarButtons(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const {
    ownNamespacePrefix,
    declaredCommandActionIds,
    viewIds,
    settingsViewIds,
    fileEditorViewIds,
    sidebarViewIds,
    ptyPanelIds,
  } = context;
  manifest.contributes.toolbarButtons.forEach((button, index) => {
    const path = ["contributes", "toolbarButtons", index] as const;
    const menu = button.menu ?? [];
    // A menu is the button's whole behaviour when it has no action: the
    // button opens it instead of dispatching.
    if (button.actionId === undefined && button.popover === undefined && menu.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path],
        message: `Toolbar button "${button.id}" declares none of actionId, popover or menu — give it one, or it does nothing when clicked.`,
        params: { errorCode: "toolbar_button_behavior_missing" },
      });
      return;
    }
    if (button.popover !== undefined && menu.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "menu"],
        message: `Toolbar button "${button.id}" declares both popover and menu — a popover button's click opens its popover, so keep one.`,
        params: { errorCode: "toolbar_button_menu_popover_conflict" },
      });
      return;
    }
    // Held to the plugin's own actions exactly as a panel's menu is: each
    // item is dispatched on its own, with nothing the plugin supplies.
    const seenMenuActions = new Set<string>();
    let menuRejected = false;
    menu.forEach((item, itemIndex) => {
      const { actionId } = item;
      const issuePath = [...path, "menu", itemIndex, "actionId"];
      if (
        !actionId.startsWith(ownNamespacePrefix) ||
        actionId.length === ownNamespacePrefix.length ||
        !PANEL_MENU_ACTION_ID.test(actionId)
      ) {
        menuRejected = true;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: issuePath,
          message: `Toolbar button menu actionId "${actionId}" must be one of this plugin's own actions, written "${manifest.name}.<id>" — a button's menu can't offer built-in or other plugins' actions.`,
          params: { errorCode: "toolbar_button_menu_action_not_own" },
        });
        return;
      }
      if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: issuePath,
          message: `Toolbar button menu actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
          params: { errorCode: "action_id_undeclared_command" },
        });
      }
      if (seenMenuActions.has(actionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: issuePath,
          message: `Duplicate menu action "${actionId}" — each action appears at most once in a button's menu.`,
          params: { errorCode: "toolbar_button_menu_duplicate_action" },
        });
      }
      seenMenuActions.add(actionId);
    });
    if (menuRejected) return;
    if (button.actionId !== undefined && button.popover !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "popover"],
        message: `Toolbar button "${button.id}" declares both actionId and popover — a button either dispatches an action or opens a popover, so keep one.`,
        params: { errorCode: "toolbar_button_behavior_conflict" },
      });
      return;
    }
    if (button.popover === undefined) return;
    // The popover mounts the view's panel kind, exactly as a surface does,
    // so the same dead ends apply.
    const { viewId } = button.popover;
    const viewPath = [...path, "popover", "viewId"];
    if (!viewIds.has(viewId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: viewPath,
        message: `toolbarButtons "${button.id}" popover.viewId "${viewId}" matches no contributes.views[].id.`,
        params: { errorCode: "toolbar_popover_view_unknown" },
      });
    } else if (settingsViewIds.has(viewId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: viewPath,
        message: `toolbarButtons "${button.id}" popover.viewId "${viewId}" names a location: "settings" view — a popover draws a panel view, and a settings view renders only in the plugin's settings.`,
        params: { errorCode: "toolbar_popover_view_settings" },
      });
    } else if (sidebarViewIds.has(viewId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: viewPath,
        message: `toolbarButtons "${button.id}" popover.viewId "${viewId}" names a location: "sidebar" view — a popover draws a panel view, and a sidebar view renders only in the sidebar.`,
        params: { errorCode: "toolbar_popover_view_sidebar" },
      });
    } else if (fileEditorViewIds.has(viewId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: viewPath,
        message: `toolbarButtons "${button.id}" popover.viewId "${viewId}" names a location: "fileEditor" view — a popover draws a panel view, and a file editor view renders only in the file panel.`,
        params: { errorCode: "toolbar_popover_view_file_editor" },
      });
    } else if (ptyPanelIds.has(viewId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: viewPath,
        message: `toolbarButtons "${button.id}" popover.viewId "${viewId}" names a panel with hasPty: true — PTY panels are rendered by the terminal host and never load the view module, so the popover would open empty.`,
        params: { errorCode: "toolbar_popover_view_pty" },
      });
    }
  });
}

// A launch entry targets exactly one thing, and only something of this
// plugin's own (#13788): one of its panels, one of its commands, or an
// agent given a prompt. A built-in or another plugin's action is never a
// target — the launcher is not a side door to dispatch.
export function validateLaunchEntries(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { ownNamespacePrefix, declaredCommandActionIds } = context;
  manifest.contributes.launchEntries.forEach((entry, index) => {
    const path = ["contributes", "launchEntries", index] as const;
    const targets = [entry.panel, entry.command, entry.agent].filter(
      (target) => target !== undefined
    );
    if (targets.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path],
        message: `Launch entry "${entry.id}" declares no target — give it one of panel, command or agent.`,
        params: { errorCode: "launch_entry_target_missing" },
      });
      return;
    }
    if (targets.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path],
        message: `Launch entry "${entry.id}" declares more than one of panel, command and agent — an entry launches one thing, so keep one.`,
        params: { errorCode: "launch_entry_target_conflict" },
      });
      return;
    }

    if (entry.command !== undefined) {
      const { actionId } = entry.command;
      const actionPath = [...path, "command", "actionId"];
      // A built-in is refused even when it starts with the plugin's name: a
      // plugin named `env.global` must not reach `env.global.set` this way.
      if (
        !actionId.startsWith(ownNamespacePrefix) ||
        actionId.length === ownNamespacePrefix.length ||
        !PANEL_MENU_ACTION_ID.test(actionId) ||
        BUILT_IN_ACTION_ID_SET.has(actionId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: actionPath,
          message: `Launch entry "${entry.id}" command.actionId "${actionId}" must be one of this plugin's own actions, written "${manifest.name}.<id>" — a launch entry can't run built-in or other plugins' actions.`,
          params: { errorCode: "launch_entry_command_not_own" },
        });
      } else if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: actionPath,
          message: `Launch entry "${entry.id}" command.actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
          params: { errorCode: "action_id_undeclared_command" },
        });
      }
      return;
    }

    if (entry.panel === undefined) return;
    const { id: panelId, placement, args } = entry.panel;
    const panel = manifest.contributes.panels.find((candidate) => candidate.id === panelId);
    if (panel === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "panel", "id"],
        message: `Launch entry "${entry.id}" panel.id "${panelId}" matches no contributes.panels[].id — an entry opens only this plugin's own panels.`,
        params: { errorCode: "launch_entry_panel_unknown" },
      });
      return;
    }
    // The same refusals `panel.openPluginPanel` makes at runtime, moved to
    // the gate so the author hears about them before any user clicks.
    const placementProblem =
      placement === "grid" && panel.scope === "project"
        ? 'a scope: "project" panel opens in the dock or a dialog, never the grid'
        : placement === "dock" && panel.dockable === false
          ? "the panel opts out of the dock with dockable: false"
          : placement === "dialog" && panel.hasPty === true
            ? "a PTY-backed panel (hasPty: true) can't open as a dialog"
            : undefined;
    if (placementProblem !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "panel", "placement"],
        message: `Launch entry "${entry.id}" can't open panel "${panelId}" with placement "${placement}": ${placementProblem}.`,
        params: { errorCode: "launch_entry_panel_placement" },
      });
    }
    // A PTY panel becomes an ordinary terminal and has no view to hand
    // arguments to, so they would be dropped without a word.
    if (args !== undefined && panel.hasPty === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "panel", "args"],
        message: `Launch entry "${entry.id}" passes args to panel "${panelId}", which is PTY-backed (hasPty: true) and has no view to receive them.`,
        params: { errorCode: "launch_entry_panel_args_pty" },
      });
    }
  });
}

// Search providers (#13792): a declarative one names a read-only declared
// query with one string parameter, a runtime one names none, and every
// target opens only something of this plugin's own — the switcher is not
// a side door to dispatch either.
export function validateSearchProviders(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { ownNamespacePrefix, declaredCommandActionIds } = context;
  const seenKeywords = new Set<string>();
  manifest.contributes.searchProviders.forEach((provider, index) => {
    const path = ["contributes", "searchProviders", index] as const;
    if (seenKeywords.has(provider.keyword)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "keyword"],
        message: `Search provider "${provider.id}" keyword "${provider.keyword}" is already used by another of this plugin's search providers — each needs its own keyword.`,
        params: { errorCode: "search_provider_keyword_duplicate" },
      });
    }
    seenKeywords.add(provider.keyword);

    if (provider.kind === "declarative") {
      if (provider.query === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "query"],
          message: `Search provider "${provider.id}" is declarative but names no query — give it the name of one of contributes.databases[].queries.`,
          params: { errorCode: "search_provider_query_missing" },
        });
      } else {
        const query = manifest.contributes.databases
          .flatMap((database) => database.queries ?? [])
          .find((candidate) => candidate.name === provider.query);
        const params = query ? Object.values(query.params) : [];
        if (query === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "query"],
            message: `Search provider "${provider.id}" query "${provider.query}" matches no contributes.databases[].queries[].name.`,
            params: { errorCode: "search_provider_query_unknown" },
          });
        } else if (query.mode !== "read") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "query"],
            message: `Search provider "${provider.id}" query "${provider.query}" is a write — a search runs as the user types, so it may only name a mode: "read" query.`,
            params: { errorCode: "search_provider_query_not_read" },
          });
        } else if (params.length !== 1 || params[0]!.type !== "string") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "query"],
            message: `Search provider "${provider.id}" query "${provider.query}" must declare exactly one param, of type "string", to receive what the user typed.`,
            params: { errorCode: "search_provider_query_params" },
          });
        }
      }
      if (provider.target === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "target"],
          message: `Search provider "${provider.id}" is declarative but declares no target — its rows open one of this plugin's panels or commands, so name one.`,
          params: { errorCode: "search_provider_target_missing" },
        });
      }
    } else if (provider.query !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "query"],
        message: `Search provider "${provider.id}" is a runtime provider, so it can't also name a query — use kind: "declarative" to answer from the query instead.`,
        params: { errorCode: "search_provider_query_runtime" },
      });
    }

    const { target } = provider;
    if (target === undefined) return;
    if ((target.panel === undefined) === (target.command === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "target"],
        message: `Search provider "${provider.id}" target must name exactly one of panel and command.`,
        params: { errorCode: "search_provider_target_conflict" },
      });
      return;
    }
    if (target.command !== undefined) {
      const actionId = target.command;
      if (
        !actionId.startsWith(ownNamespacePrefix) ||
        actionId.length === ownNamespacePrefix.length ||
        !PANEL_MENU_ACTION_ID.test(actionId) ||
        BUILT_IN_ACTION_ID_SET.has(actionId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "target", "command"],
          message: `Search provider "${provider.id}" target.command "${actionId}" must be one of this plugin's own actions, written "${manifest.name}.<id>" — a search result can't run built-in or other plugins' actions.`,
          params: { errorCode: "search_provider_command_not_own" },
        });
      } else if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "target", "command"],
          message: `Search provider "${provider.id}" target.command "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
          params: { errorCode: "action_id_undeclared_command" },
        });
      }
      return;
    }
    const panel = manifest.contributes.panels.find((candidate) => candidate.id === target.panel);
    if (panel === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "target", "panel"],
        message: `Search provider "${provider.id}" target.panel "${target.panel}" matches no contributes.panels[].id — a search result opens only this plugin's own panels.`,
        params: { errorCode: "search_provider_panel_unknown" },
      });
    } else if (panel.hasPty === true) {
      // A result's args are the point of opening it, and a PTY panel has no
      // view to hand them to.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "target", "panel"],
        message: `Search provider "${provider.id}" target.panel "${target.panel}" is PTY-backed (hasPty: true) and has no view to receive a result's args.`,
        params: { errorCode: "search_provider_panel_pty" },
      });
    }
  });
}

// A layout arranges only what this plugin owns (#13780), and terminals
// reach it only through a recipe, which the user confirms before it
// starts. The placement refusals are the ones the panel store would make
// at apply time, moved here so the author hears about them first.
export function validateLayouts(manifest: ParsedPluginManifest, ctx: z.RefinementCtx): void {
  manifest.contributes.layouts.forEach((layout, layoutIndex) => {
    const layoutPath = ["contributes", "layouts", layoutIndex] as const;
    const references = new Set<string>();
    const groups = new Map<
      string,
      { location: string; projectScoped: boolean; size: number; entryIndex: number }
    >();
    let maximizedSeen = false;
    layout.entries.forEach((entry, entryIndex) => {
      const path = [...layoutPath, "entries", entryIndex];
      const targets = [entry.panel, entry.browser, entry.recipe].filter(
        (target) => target !== undefined
      );
      if (targets.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            targets.length === 0
              ? `Layout "${layout.id}" entry ${entryIndex} declares no target — give it one of panel, browser or recipe.`
              : `Layout "${layout.id}" entry ${entryIndex} declares more than one of panel, browser and recipe — an entry places one thing, so keep one.`,
          params: {
            errorCode:
              targets.length === 0 ? "layout_entry_target_missing" : "layout_entry_target_conflict",
          },
        });
        return;
      }

      let location = entry.location ?? "grid";
      let size = 1;
      let projectScoped = false;
      let reference: string;
      if (entry.panel !== undefined) {
        const panelId = entry.panel;
        const panel = manifest.contributes.panels.find((candidate) => candidate.id === panelId);
        if (panel === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "panel"],
            message: `Layout "${layout.id}" panel "${panelId}" matches no contributes.panels[].id — a layout arranges only this plugin's own panels.`,
            params: { errorCode: "layout_panel_unknown" },
          });
          return;
        }
        if (panel.hasPty === true) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "panel"],
            message: `Layout "${layout.id}" panel "${panelId}" is PTY-backed (hasPty: true) — a layout starts terminals only through a recipe, which the user confirms.`,
            params: { errorCode: "layout_panel_pty" },
          });
          return;
        }
        projectScoped = panel.scope === "project";
        location = entry.location ?? (projectScoped ? "dock" : "grid");
        const placementProblem =
          location === "grid" && projectScoped
            ? 'a scope: "project" panel opens in the dock, never the grid'
            : location === "dock" && panel.dockable === false
              ? "the panel opts out of the dock with dockable: false"
              : undefined;
        if (placementProblem !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "location"],
            message: `Layout "${layout.id}" can't place panel "${panelId}" that way: ${placementProblem}.`,
            params: { errorCode: "layout_panel_placement" },
          });
        }
        reference = `panel:${panelId}`;
      } else if (entry.recipe !== undefined) {
        const recipeId = entry.recipe;
        const recipe = manifest.contributes.recipes.find((candidate) => candidate.id === recipeId);
        if (recipe === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "recipe"],
            message: `Layout "${layout.id}" recipe "${recipeId}" matches no contributes.recipes[].id — a layout runs only this plugin's own recipes.`,
            params: { errorCode: "layout_recipe_unknown" },
          });
          return;
        }
        size = recipe.terminals.length;
        reference = `recipe:${recipeId}`;
      } else if (entry.browser !== undefined) {
        // The field's own refinement has already reported a malformed URL,
        // and the manifest checks still run after it.
        if (!isHttpUrl(entry.browser)) return;
        reference = `browser:${new URL(entry.browser).href}`;
      } else {
        return;
      }

      if (references.has(reference)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `Layout "${layout.id}" lists the same ${reference.split(":")[0]} twice — each panel, page and recipe takes one place in a layout.`,
          params: { errorCode: "layout_entry_duplicate" },
        });
      }
      references.add(reference);

      if (entry.maximized === true) {
        if (maximizedSeen || location !== "grid") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "maximized"],
            message: maximizedSeen
              ? `Layout "${layout.id}" maximizes more than one entry — only one panel or group can fill the grid.`
              : `Layout "${layout.id}" maximizes an entry in the dock — only a grid panel can be maximized.`,
            params: { errorCode: "layout_maximized_invalid" },
          });
        }
        maximizedSeen = true;
      }

      if (entry.tabGroup !== undefined) {
        const group = groups.get(entry.tabGroup);
        if (group === undefined) {
          groups.set(entry.tabGroup, { location, projectScoped, size, entryIndex });
        } else if (group.projectScoped !== projectScoped) {
          // A group's tabs share one worktree, and a project panel belongs
          // to none: it can share a group only with other project panels.
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "tabGroup"],
            message: `Layout "${layout.id}" tab group "${entry.tabGroup}" mixes scope: "project" panels with worktree panels — a group's tabs belong to one worktree, or all to the project.`,
            params: { errorCode: "layout_tab_group_scope" },
          });
        } else if (group.location !== location) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "location"],
            message: `Layout "${layout.id}" puts tab group "${entry.tabGroup}" in both the grid and the dock — a group's tabs share one place.`,
            params: { errorCode: "layout_tab_group_location" },
          });
        } else {
          group.size += size;
        }
      }
    });
    for (const [key, group] of groups) {
      if (group.size >= 2) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...layoutPath, "entries", group.entryIndex, "tabGroup"],
        message: `Layout "${layout.id}" tab group "${key}" holds a single panel — a tab group needs at least two.`,
        params: { errorCode: "layout_tab_group_single" },
      });
    }
  });
}
