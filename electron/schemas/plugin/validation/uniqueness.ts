import { z } from "zod";
import type { ParsedPluginManifest } from "../manifestShape.js";

// Duplicate contribution ids — within each contribution array, the bare
// `id` is the lookup key the runtime keys its registries on (panel kind,
// command descriptor, MCP server, agent, view, setting, forge provider,
// file-decoration provider). A duplicate silently first-wins at load, so
// the second contribution vanishes with no diagnostic. Reject it at the
// manifest gate instead. The check is per-array (ids in different arrays
// are namespaced independently and never collide).
export function reportDuplicateIds(
  ctx: z.RefinementCtx,
  arrayName: string,
  entries: ReadonlyArray<{ id: string }>
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", arrayName, index, "id"],
        message: `Duplicate id "${entry.id}" in contributes.${arrayName} — each contribution id must be unique within its array.`,
        params: { errorCode: "duplicate_contribution_id" },
      });
    } else {
      seen.add(entry.id);
    }
  });
}

export function validateUniqueIds(manifest: ParsedPluginManifest, ctx: z.RefinementCtx): void {
  reportDuplicateIds(ctx, "panels", manifest.contributes.panels);
  reportDuplicateIds(ctx, "toolbarButtons", manifest.contributes.toolbarButtons);
  reportDuplicateIds(ctx, "launchEntries", manifest.contributes.launchEntries);
  reportDuplicateIds(ctx, "layouts", manifest.contributes.layouts);
  reportDuplicateIds(ctx, "searchProviders", manifest.contributes.searchProviders);
  reportDuplicateIds(ctx, "commands", manifest.contributes.commands);
  reportDuplicateIds(ctx, "views", manifest.contributes.views);
  reportDuplicateIds(ctx, "mcpServers", manifest.contributes.mcpServers);
  reportDuplicateIds(ctx, "skills", manifest.contributes.skills);
  reportDuplicateIds(ctx, "themes", manifest.contributes.themes);
  reportDuplicateIds(ctx, "promptTemplates", manifest.contributes.promptTemplates);
  reportDuplicateIds(ctx, "terminalLinks", manifest.contributes.terminalLinks);
}

export function validateUniqueIdsAfterContextProviders(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx
): void {
  reportDuplicateIds(ctx, "forgeProviders", manifest.contributes.forgeProviders);
  reportDuplicateIds(ctx, "elementPickerProviders", manifest.contributes.elementPickerProviders);
  reportDuplicateIds(ctx, "fileDecorationProviders", manifest.contributes.fileDecorationProviders);
  reportDuplicateIds(ctx, "fileEditors", manifest.contributes.fileEditors);
  reportDuplicateIds(ctx, "projectTemplates", manifest.contributes.projectTemplates);
  reportDuplicateIds(ctx, "agents", manifest.contributes.agents);
  reportDuplicateIds(ctx, "settings", manifest.contributes.settings);
  reportDuplicateIds(ctx, "recipes", manifest.contributes.recipes);
  reportDuplicateIds(ctx, "agentMcp", manifest.contributes.agentMcp);
  reportDuplicateIds(ctx, "tours", manifest.contributes.tours);
  reportDuplicateIds(ctx, "databases", manifest.contributes.databases);
  reportDuplicateIds(ctx, "worktreeSetupSteps", manifest.contributes.worktreeSetupSteps);
  reportDuplicateIds(ctx, "setup", manifest.contributes.setup);
}
