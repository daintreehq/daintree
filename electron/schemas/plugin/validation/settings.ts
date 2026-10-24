import { z } from "zod";
import { declaredPluginConnections } from "../../../../shared/utils/pluginConnections.js";
import { parse as parseWhenClause } from "../../../../shared/utils/whenClause/parser.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import type { ManifestValidationContext } from "./context.js";
import { PANEL_MENU_ACTION_ID } from "../actions.js";
import type { ParsedPluginManifest } from "../manifestShape.js";

// A setup step's check and action must each name something the host can
// see or run, or the step could never be finished (#13824). A command is
// the plugin's own, under the same rules as a panel menu's.
export function validateSetupSteps(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { ownNamespacePrefix, declaredCommandActionIds, settingIds } = context;
  manifest.contributes.setup.forEach((step, index) => {
    const path = ["contributes", "setup", index] as const;
    const { done, action } = step;
    if (done.kind === "setting" && !settingIds.has(done.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "done", "key"],
        message: `Setup step "${step.id}" is done when setting "${done.key}" is set, but no contributes.settings[].id matches it.`,
        params: { errorCode: "setup_setting_unknown" },
      });
    }
    if (done.kind === "account") {
      const declared = declaredPluginConnections(manifest);
      if (declared.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "done", "kind"],
          message: `Setup step "${step.id}" is done when the account is connected, but the plugin declares no contributes.account or contributes.connections.`,
          params: { errorCode: "setup_account_undeclared" },
        });
      } else if (
        done.connection !== undefined &&
        !declared.some((connection) => connection.id === done.connection)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "done", "connection"],
          message: `Setup step "${step.id}" is done when connection "${done.connection}" is connected, but no declared connection has that id.`,
          params: { errorCode: "setup_connection_unknown" },
        });
      }
    }
    if (done.kind === "context") {
      try {
        parseWhenClause(done.when);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "done", "when"],
          message: `Setup step "${step.id}" has a when clause that doesn't parse: ${formatErrorMessage(err, "unparseable expression")}`,
          params: { errorCode: "setup_when_invalid" },
        });
      }
    }
    if (action?.kind === "settings" && action.key !== undefined && !settingIds.has(action.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "action", "key"],
        message: `Setup step "${step.id}" opens setting "${action.key}", but no contributes.settings[].id matches it.`,
        params: { errorCode: "setup_setting_unknown" },
      });
    }
    if (action?.kind === "command") {
      const { actionId } = action;
      const actionPath = [...path, "action", "actionId"];
      if (
        !actionId.startsWith(ownNamespacePrefix) ||
        actionId.length === ownNamespacePrefix.length ||
        !PANEL_MENU_ACTION_ID.test(actionId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: actionPath,
          message: `Setup step "${step.id}" action.actionId "${actionId}" must be one of this plugin's own commands, written "${manifest.name}.<id>".`,
          params: { errorCode: "setup_command_not_own" },
        });
      } else if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: actionPath,
          message: `Setup step "${step.id}" action.actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
          params: { errorCode: "action_id_undeclared_command" },
        });
      }
    }
  });
}
