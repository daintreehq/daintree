import { z } from "zod";
import { BUILT_IN_ACTION_ID_SET, DENY_PLUGIN_DISPATCH_SET } from "../actions.js";
import type { ManifestValidationContext } from "./context.js";
import type { ParsedPluginManifest } from "../manifestShape.js";

// A route runs one of the plugin's own manifest commands with nobody
// present: the target must be declared (an imperative action dies with
// the worker a route exists to outlive), must not ask for confirmation
// no one is there to give, and an event must carry the same capability
// its live subscription requires (#13816).
export function validateEventRoutes(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { capabilities } = context;
  const routedEvents = new Set<string>();
  manifest.eventRoutes.forEach((route, index) => {
    if (routedEvents.has(route.event)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eventRoutes", index, "event"],
        message: `eventRoutes already routes "${route.event}"; each event may be routed once.`,
        params: { errorCode: "event_route_duplicate_event" },
      });
    }
    routedEvents.add(route.event);
    const command = manifest.contributes.commands.find((cmd) => cmd.id === route.command);
    if (!command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eventRoutes", index, "command"],
        message: `eventRoutes command "${route.command}" matches no entry in contributes.commands.`,
        params: { errorCode: "event_route_unknown_command" },
      });
    } else if (command.danger === "confirm") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eventRoutes", index, "command"],
        message: `eventRoutes command "${route.command}" is declared danger "confirm", and a routed command runs without anyone to confirm it.`,
        params: { errorCode: "event_route_confirm_command" },
      });
    }
    if (route.event === "agentWaiting" && !capabilities.has("agent:read")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eventRoutes", index, "event"],
        message:
          'eventRoutes "agentWaiting" requires the "agent:read" capability to be declared in capabilities.',
        params: { errorCode: "event_route_capability_required" },
      });
    }
  });
}

// Every contributed `actionId` (toolbar buttons, menu items, keybindings,
// context menus) must resolve to a real, dispatchable action at runtime,
// else the contribution paints an inert button/binding that silently does
// nothing when invoked (#10565, #10580). The resolution rules, in order:
//
//  1. A built-in flagged `denyPluginDispatch: true` is rejected outright —
//     the host refuses plugin dispatch for it, so the button is dead even
//     though the id exists (#10580). This precedes the allowlist check
//     because these ids ARE in `BUILT_IN_ACTION_ID_SET`.
//  2. Any other built-in action id resolves.
//  3. An id in the plugin's own namespace is cross-checked against the
//     declared `contributes.commands` (namespaced `{name}.{id}` at load).
//     If commands are declared, an own-namespace id that matches none of
//     them is a typo for a command that will never exist, so it is rejected
//     (#10580). If NO commands are declared, the plugin registers actions
//     imperatively via `host.registerAction` (invisible at parse time), so
//     any own-namespace id is allowed — the imperative escape hatch.
//  4. A reference into a foreign namespace can never resolve and is rejected.
export function validateContributedActionIds(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { ownNamespacePrefix, declaredCommandActionIds } = context;
  const actionIdContributions = [
    ["toolbarButtons", manifest.contributes.toolbarButtons],
    ["menuItems", manifest.contributes.menuItems],
    ["keybindings", manifest.contributes.keybindings],
    ["contextMenus", manifest.contributes.contextMenus],
  ] as const;
  for (const [arrayName, entries] of actionIdContributions) {
    entries.forEach((entry, index) => {
      const { actionId } = entry;
      // A popover button has no action; `toolbar_button_behavior_*` below
      // reports a button with neither.
      if (actionId === undefined) return;
      const issuePath = ["contributes", arrayName, index, "actionId"] as const;

      if (DENY_PLUGIN_DISPATCH_SET.has(actionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...issuePath],
          message: `Contributed actionId "${actionId}" is a built-in action closed to plugin dispatch — the host refuses it at runtime, so the contribution can never fire.`,
          params: { errorCode: "action_id_plugin_dispatch_denied" },
        });
        return;
      }

      if (BUILT_IN_ACTION_ID_SET.has(actionId)) {
        return;
      }

      if (actionId.startsWith(ownNamespacePrefix)) {
        // Cross-check own-namespace ids against declared commands only when
        // commands exist; an empty set means the plugin is fully imperative.
        if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...issuePath],
            message: `Contributed actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
            params: { errorCode: "action_id_undeclared_command" },
          });
        }
        return;
      }

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...issuePath],
        message: `Contributed actionId "${actionId}" does not reference a built-in action or an action in this plugin's "${manifest.name}" namespace — it can never resolve.`,
        params: { errorCode: "action_id_unknown_namespace" },
      });
    });
  }
}
