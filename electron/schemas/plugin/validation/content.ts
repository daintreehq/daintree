import { z } from "zod";
import { findPromptTemplatePlaceholders } from "../../../../shared/utils/pluginPromptTemplates.js";
import type { PromptTemplateContribution } from "../../../../shared/types/plugin.js";
import type { ParsedPluginManifest } from "../manifestShape.js";

// Assistant knowledge describes the plugin's agent tools and is only
// delivered alongside them, so a plugin with none could never deliver it.
export function validateAssistantKnowledge(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx
): void {
  if (
    manifest.contributes.assistantKnowledge !== undefined &&
    manifest.contributes.agentMcp.length === 0 &&
    manifest.contributes.databases.length === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contributes", "assistantKnowledge"],
      message:
        "contributes.assistantKnowledge describes agent tools, but this plugin offers none — declare contributes.agentMcp or contributes.databases.",
      params: { errorCode: "assistant_knowledge_requires_agent_tools" },
    });
  }
}

/**
 * What a prompt template's arguments and body get wrong together, which neither
 * field's own schema can see. Paths are relative to the template.
 */
export function findPromptTemplateProblems(
  template: Pick<PromptTemplateContribution, "id" | "body" | "args">
): { path: (string | number)[]; message: string }[] {
  const problems: { path: (string | number)[]; message: string }[] = [];
  const declared = new Set<string>();
  template.args.forEach((arg, argIndex) => {
    if (declared.has(arg.name)) {
      problems.push({
        path: ["args", argIndex, "name"],
        message: `Duplicate argument "${arg.name}" in prompt template "${template.id}".`,
      });
    }
    declared.add(arg.name);
  });
  for (const reference of new Set(findPromptTemplatePlaceholders(template.body))) {
    if (declared.has(reference)) continue;
    problems.push({
      path: ["body"],
      message: `Prompt template "${template.id}" references {{${reference}}}, which is not a declared argument name.`,
    });
  }
  return problems;
}

export function validatePromptTemplates(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx
): void {
  manifest.contributes.promptTemplates.forEach((template, templateIndex) => {
    for (const problem of findPromptTemplateProblems(template)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "promptTemplates", templateIndex, ...problem.path],
        message: problem.message,
      });
    }
  });
}
