import { z } from "zod";
import { pluginVariableReferences } from "../../../../shared/utils/pluginRecipeVariables.js";
import { isAgentRecipeType } from "../../../../shared/types/project.js";
import {
  checkTerminalLinkHost,
  checkTerminalLinkPathPrefix,
  checkTerminalLinkPattern,
} from "../../../../shared/utils/pluginTerminalLinks.js";
import type { ManifestValidationContext } from "./context.js";
import { PANEL_MENU_ACTION_ID } from "../actions.js";
import type { ParsedPluginManifest } from "../manifestShape.js";

// A terminal link hands the matched text to the plugin, so it may only
// dispatch the plugin's OWN command — never a built-in or another
// plugin's — under the same own-namespace rules as a panel menu.
export function validateTerminalLinks(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { ownNamespacePrefix, declaredCommandActionIds } = context;
  manifest.contributes.terminalLinks.forEach((link, index) => {
    const path = ["contributes", "terminalLinks", index] as const;
    const issue = (field: string, message: string, errorCode: string) =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, field],
        message,
        params: { errorCode },
      });
    const { actionId } = link;
    if (
      !actionId.startsWith(ownNamespacePrefix) ||
      actionId.length === ownNamespacePrefix.length ||
      !PANEL_MENU_ACTION_ID.test(actionId)
    ) {
      issue(
        "actionId",
        `Terminal link actionId "${actionId}" must be one of this plugin's own actions, written "${manifest.name}.<id>" — a link's text can only go to the plugin that declared it.`,
        "terminal_link_action_not_own"
      );
    } else if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
      issue(
        "actionId",
        `Terminal link actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
        "action_id_undeclared_command"
      );
    }

    if ((link.pattern === undefined) === (link.url === undefined)) {
      issue(
        link.pattern === undefined ? "pattern" : "url",
        "A terminal link sets exactly one of pattern or url.",
        "terminal_link_target"
      );
      return;
    }
    if (link.url !== undefined) {
      if (link.ignoreCase !== undefined) {
        issue(
          "ignoreCase",
          "ignoreCase applies to a pattern; a URL's host is already matched without regard to case.",
          "terminal_link_ignore_case"
        );
      }
      const hostProblem = checkTerminalLinkHost(link.url.host);
      if (hostProblem !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "url", "host"],
          message: `Terminal link ${hostProblem}.`,
          params: { errorCode: "terminal_link_host" },
        });
      }
      const pathProblem =
        link.url.pathPrefix === undefined ? null : checkTerminalLinkPathPrefix(link.url.pathPrefix);
      if (pathProblem !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "url", "pathPrefix"],
          message: `Terminal link ${pathProblem}.`,
          params: { errorCode: "terminal_link_path_prefix" },
        });
      }
      return;
    }
    const patternProblem = checkTerminalLinkPattern(link.pattern!, link.ignoreCase === true);
    if (patternProblem !== null) {
      issue("pattern", `Terminal link ${patternProblem}.`, "terminal_link_pattern");
    }
  });
}

// Recipes (#13797): a `plugin-panel` step opens only this plugin's own
// panels, the fields of one step kind are refused on another rather than
// dropped, and every `{{plugin.<name>}}` is a declared variable.
export function validateRecipes(manifest: ParsedPluginManifest, ctx: z.RefinementCtx): void {
  const declaresAgentTools =
    manifest.contributes.agentMcp.length > 0 || manifest.contributes.databases.length > 0;
  manifest.contributes.recipes.forEach((recipe, recipeIndex) => {
    const recipePath = ["contributes", "recipes", recipeIndex] as const;
    const declared = new Set(recipe.variables ?? []);
    let hasAgentStep = false;
    recipe.terminals.forEach((step, stepIndex) => {
      const path = [...recipePath, "terminals", stepIndex] as const;
      const isPanel = step.type === "plugin-panel";
      const isAgent = isAgentRecipeType(step.type);
      if (isAgent) hasAgentStep = true;
      if (isPanel) {
        const stray = (
          ["command", "env", "initialPrompt", "systemPrompt", "args", "devCommand"] as const
        ).filter((field) => step[field] !== undefined);
        if (stray.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path],
            message: `Recipe "${recipe.id}" step ${stepIndex + 1} opens a panel, so ${stray.join(", ")} would never be used — a plugin-panel step takes panelId and panelArgs.`,
            params: { errorCode: "recipe_panel_step_fields" },
          });
        }
        const panel =
          step.panelId === undefined
            ? undefined
            : manifest.contributes.panels.find((candidate) => candidate.id === step.panelId);
        if (panel === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "panelId"],
            message:
              step.panelId === undefined
                ? `Recipe "${recipe.id}" step ${stepIndex + 1} is a plugin-panel step with no panelId.`
                : `Recipe "${recipe.id}" step ${stepIndex + 1} panelId "${step.panelId}" matches no contributes.panels[].id — a recipe opens only this plugin's own panels.`,
            params: { errorCode: "recipe_panel_unknown" },
          });
        } else if (step.panelArgs !== undefined && panel.hasPty === true) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "panelArgs"],
            message: `Recipe "${recipe.id}" step ${stepIndex + 1} passes panelArgs to panel "${panel.id}", which is PTY-backed (hasPty: true) and has no view to receive them.`,
            params: { errorCode: "recipe_panel_args_pty" },
          });
        }
      } else if (step.panelId !== undefined || step.panelArgs !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path],
          message: `Recipe "${recipe.id}" step ${stepIndex + 1} sets panelId or panelArgs on a "${step.type}" step — only type "plugin-panel" opens a panel.`,
          params: { errorCode: "recipe_panel_step_fields" },
        });
      }
      if (step.systemPrompt !== undefined && !isAgent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "systemPrompt"],
          message: `Recipe "${recipe.id}" step ${stepIndex + 1} sets systemPrompt on a "${step.type}" step — only an agent step has a system prompt.`,
          params: { errorCode: "recipe_system_prompt_not_agent" },
        });
      }
      for (const field of ["initialPrompt", "systemPrompt"] as const) {
        const text = step[field];
        if (text === undefined) continue;
        for (const name of pluginVariableReferences(text)) {
          if (declared.has(name)) continue;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, field],
            message: `Recipe "${recipe.id}" step ${stepIndex + 1} uses {{plugin.${name}}}, which isn't in the recipe's variables.`,
            params: { errorCode: "recipe_variable_undeclared" },
          });
        }
      }
    });
    if (recipe.requiresAgentTools === true && !declaresAgentTools) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...recipePath, "requiresAgentTools"],
        message: `Recipe "${recipe.id}" requires agent tools, but this plugin offers none — declare contributes.agentMcp or contributes.databases.`,
        params: { errorCode: "recipe_requires_agent_tools_none" },
      });
    } else if (recipe.requiresAgentTools === true && !hasAgentStep) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...recipePath, "requiresAgentTools"],
        message: `Recipe "${recipe.id}" requires agent tools but starts no agent.`,
        params: { errorCode: "recipe_requires_agent_tools_no_agent" },
      });
    }
  });
}
