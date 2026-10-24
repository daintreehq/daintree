import { z } from "zod";
import type { ManifestValidationContext } from "./context.js";
import { PANEL_MENU_ACTION_ID } from "../actions.js";
import type { ParsedPluginManifest } from "../manifestShape.js";

// A tour's Finish opens the same two targets a setup step does, held to
// the same rules: a declared setting, or one of this plugin's own commands.
export function validateTourFinishActions(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { ownNamespacePrefix, declaredCommandActionIds, settingIds } = context;
  manifest.contributes.tours.forEach((tour, index) => {
    const action = tour.finish?.action;
    const path = ["contributes", "tours", index, "finish", "action"];
    if (action?.kind === "settings" && action.key !== undefined && !settingIds.has(action.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "key"],
        message: `Tour "${tour.id}" finishes by opening setting "${action.key}", but no contributes.settings[].id matches it.`,
        params: { errorCode: "tour_finish_setting_unknown" },
      });
    }
    if (action?.kind === "command") {
      const { actionId } = action;
      if (
        !actionId.startsWith(ownNamespacePrefix) ||
        actionId.length === ownNamespacePrefix.length ||
        !PANEL_MENU_ACTION_ID.test(actionId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "actionId"],
          message: `Tour "${tour.id}" finish action.actionId "${actionId}" must be one of this plugin's own commands, written "${manifest.name}.<id>".`,
          params: { errorCode: "tour_finish_command_not_own" },
        });
      } else if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "actionId"],
          message: `Tour "${tour.id}" finish action.actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
          params: { errorCode: "action_id_undeclared_command" },
        });
      }
    }
  });
}

// A view renders into a `contributes.panels` entry with a matching id; a
// view whose id matches no panel can never be shown (#10620). This is a
// hard error now — it previously silently no-op'd at load.
// A panel tour opens from its panel's menu, so it may only name a panel
// kind this plugin declares — never a built-in or another plugin's kind.
export function validateTourPanelKinds(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { panelIds } = context;
  manifest.contributes.tours.forEach((tour, index) => {
    if (tour.panelKind !== undefined && !panelIds.has(tour.panelKind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "tours", index, "panelKind"],
        message: `Tour "${tour.id}" panelKind "${tour.panelKind}" matches no contributes.panels[].id — a panel tour can only attach to one of this plugin's own panels.`,
        params: { errorCode: "tour_panel_kind_unknown" },
      });
    }
  });
}
