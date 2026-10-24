import { z } from "zod";
import type { ManifestValidationContext } from "./context.js";
import type { ParsedPluginManifest } from "../manifestShape.js";

/**
 * `contributes.*` groups a `scope: "project"` plugin may not declare, each with
 * the structural reason it cannot yet be narrowed to one project.
 *
 * The dividing line is {@link
 * ../services/plugin/PluginContributionBroadcaster.js}: the groups it filters by
 * owning plugin id (panels, commands/actions, toolbarButtons, launchEntries, layouts,
 * keybindings, contextMenus, recipes) reach only the owning project's views, and `settings`
 * resolves through the bound instance handle. Everything here registers into a
 * registry with no project axis — a single app menu, one agent roster mirrored
 * into the shared pty-host, one detection table for every terminal — so the
 * contribution is published app-wide no matter which project loaded it.
 *
 * Exported so tests enumerate the set instead of restating it, and so a group
 * that later grows a project axis is removed in exactly one place.
 */
export const PROJECT_SCOPE_UNSCOPED_CONTRIBUTIONS = [
  [
    "menuItems",
    "the application menu is one OS-level menu shared by every window, with no per-project projection — the item would stay on the menu bar while a different project is focused and dispatch into it.",
  ],
  [
    "agents",
    "the plugin agent roster is a single app-wide registry mirrored into the shared pty-host, and an agent's launch identity is persisted into terminals and sessions that outlive the project binding — the agent would be launchable from every project.",
  ],
  [
    "processTools",
    "process-tool detections are mirrored into the shared pty-host as one detection table for every terminal in the app, so the icon mapping would apply to every project's processes.",
  ],
  [
    "mcpServers",
    "contributed MCP servers run under one app-wide supervisor whose tools Daintree and its in-app Assistant call with no project binding to check the contribution against. To serve its tools to this project's agents, name it in a contributes.agentMcp[].source, which every server here must be.",
  ],
  [
    "themes",
    "the app theme is one machine-wide selection painted into every window and every project's view, so there is no per-project theme for the contribution to narrow to.",
  ],
] as const satisfies ReadonlyArray<readonly [string, string]>;

// `scope: "project"` and the discovering root must agree, in BOTH
// directions. A project plugin copied into the user directory would
// otherwise load app-globally with project-shaped assumptions (its fs
// containment root, its per-project settings tier), and a user plugin
// dropped into `.daintree/plugins/` would load with none of the
// project-local guarantees its author never opted into. Neither failure
// is visible at runtime, so both are rejected at the gate.
export function validateScopeAndInstanceMode(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { origin } = context;
  if (origin === "project" && manifest.scope !== "project") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scope"],
      message:
        'A plugin discovered under a project\'s .daintree/plugins/ must declare "scope": "project" — the host will not load a project-local plugin that has not opted in.',
      params: { errorCode: "project_scope_required" },
    });
  } else if (origin !== "project" && manifest.scope === "project") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scope"],
      message: `"scope": "project" declares a plugin that is only ever loaded from a project's .daintree/plugins/, but this manifest was discovered under the ${origin} plugins root.`,
      params: { errorCode: "project_scope_not_allowed" },
    });
  }

  if (manifest.instanceMode === "project") {
    if (origin !== "user") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["instanceMode"],
        message:
          '"instanceMode": "project" opts an installed package into per-project instances; a builtin or project-local plugin has no installed package to instance.',
        params: { errorCode: "instance_mode_installed_only" },
      });
    } else if (manifest.scope === "project") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["instanceMode"],
        message:
          '"instanceMode": "project" and "scope": "project" are mutually exclusive — scope marks a plugin that lives in one repository, instanceMode marks an installed package that runs once per selected project.',
        params: { errorCode: "instance_mode_scope_conflict" },
      });
    }
  }
}

export function validateWorksWith(manifest: ParsedPluginManifest, ctx: z.RefinementCtx): void {
  const selfIndex = manifest.worksWith?.indexOf(manifest.name) ?? -1;
  if (selfIndex !== -1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["worksWith", selfIndex],
      message: "worksWith names other plugins; a plugin can't list itself",
      params: { errorCode: "works_with_self" },
    });
  }
}

// A project-local plugin runs out-of-process in the plugin worker, and
// `host.registerForgeProvider` is unavailable there: forge providers
// require synchronous host methods (`parseRemote`, the URL builders) that
// cannot cross the worker's async message port — see the same refusal in
// `pluginDevWorkerHostProxy.registerForgeProvider`. The contribution
// would register a descriptor that can never be given an implementation,
// so the provider would sit in Preferences permanently unbacked. Reject
// the declaration rather than ship a forge provider that cannot work.
//
// Deliberately scoped to `scope: "project"` and not to every non-builtin
// origin, even though `PluginService.activatePlugin` routes user plugins
// through the same worker and so leaves their forge providers equally
// unbacked. That is a pre-existing gap with shipped manifests behind it;
// widening the rule would reject plugins that install today, which is its
// own decision with its own migration. Project scope is new surface, so
// it starts closed.
export function validateProjectRuntimeContributions(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { projectRuntime } = context;
  if (projectRuntime && manifest.contributes.forgeProviders.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contributes", "forgeProviders"],
      message:
        'contributes.forgeProviders is not available to a "scope": "project" plugin — forge providers need synchronous host methods (parseRemote, URL builders) that cannot cross the plugin worker\'s async message port, so host.registerForgeProvider would refuse the implementation and the provider could never resolve.',
      params: { errorCode: "forge_provider_project_scope_forbidden" },
    });
  }

  // The contribution groups that are still STRUCTURALLY GLOBAL. Contribution
  // scoping (`PluginContributionBroadcaster`) narrows panels, actions,
  // toolbar buttons, keybindings and context menus to the owning project's
  // views; every group below is registered into an app-wide registry that
  // has no project axis at all, so a project plugin declaring one publishes
  // it to every project in the app — the exact locality violation project
  // scope exists to prevent. That was harmless while nothing could be
  // project-scoped; it is a live leak now, so the declaration is rejected at
  // the gate rather than accepted and silently over-published.
  //
  // Each of these is deferred, not forbidden forever: the reason names the
  // structural obstacle so a later phase knows what it has to build first.
  // Installed and builtin plugins are unaffected — they ARE app-wide, which
  // is what the absent `scope` means.
  if (projectRuntime) {
    // A server an agentMcp endpoint bridges is reached only through that
    // endpoint's project-bound grants, and the host-client IPC refuses a
    // project instance's servers, so only an unbridged one is unscoped.
    const bridgedServers = new Set(
      manifest.contributes.agentMcp.flatMap((endpoint) =>
        endpoint.source ? [endpoint.source.mcpServer] : []
      )
    );
    for (const [group, reason] of PROJECT_SCOPE_UNSCOPED_CONTRIBUTIONS) {
      if (manifest.contributes[group].length === 0) continue;
      if (
        group === "mcpServers" &&
        manifest.contributes.mcpServers.every((server) => bridgedServers.has(server.id))
      ) {
        continue;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", group],
        message: `contributes.${group} is not available to a "scope": "project" plugin — ${reason}`,
        params: { errorCode: `${group}_project_scope_forbidden` },
      });
    }
    // Not deferred like the groups above: a template is offered while a
    // new folder is being created, before there is any project for a
    // project plugin to belong to.
    if (manifest.contributes.projectTemplates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "projectTemplates"],
        message:
          'contributes.projectTemplates is not available to a "scope": "project" plugin — templates are offered when a new project folder is created, before any project exists for a project plugin to belong to. Ship the template from an installed plugin instead.',
        params: { errorCode: "projectTemplates_project_scope_forbidden" },
      });
    }
  }
}

// The inverse asymmetry: `contributes.surfaces` is available to project
// plugins ALONE. An installed plugin taking over a project's empty canvas,
// its home nav entry or its cold-open layout would be reshaping a project
// it was never bound to, from a decision the user made globally — and
// there would be no project whose slot registry could arbitrate the
// claim. Locality is the whole point of the slot, so a manifest without
// `scope: "project"` may not declare one.
export function validateSurfacesScope(manifest: ParsedPluginManifest, ctx: z.RefinementCtx): void {
  if (manifest.scope !== "project" && manifest.contributes.surfaces !== undefined) {
    const claimed = Object.entries(manifest.contributes.surfaces).filter(
      ([, value]) => value !== undefined
    );
    if (claimed.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "surfaces"],
        message:
          'contributes.surfaces is available only to a "scope": "project" plugin — a surface claim replaces one project\'s own chrome, and an installed plugin is bound to no project, so there is nothing to scope the claim to or to arbitrate a second claimant against.',
        params: { errorCode: "surfaces_project_scope_only" },
      });
    }
  }
}

export function validateReservedNamespace(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { origin } = context;
  if (origin !== "builtin" && manifest.name.startsWith("daintree.")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: `Plugin name "${manifest.name}" uses the reserved "daintree.*" namespace, which is restricted to first-party plugins.`,
      params: { errorCode: "namespace_reserved" },
    });
  }
}
