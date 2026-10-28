import {
  selectContributionsForProject,
  recipeOwner,
  getPluginHostedViewsForProject,
  getPluginCustomIconsForProject,
} from "../../../services/plugin/PluginContributionBroadcaster.js";
import type { PluginCustomIconAsset } from "../../../../shared/config/pluginCustomIcon.js";
import { getPluginThemeSchemes } from "../../../services/plugin/PluginThemeRegistry.js";
import type { AppColorScheme } from "../../../../shared/theme/types.js";
import { getPluginAgentRegistry } from "../../../../shared/config/pluginAgentRegistry.js";
import type { AgentConfig } from "../../../../shared/config/agentRegistry.js";
import type {
  PluginRecipeMetadataPatch,
  TerminalRecipe,
} from "../../../../shared/types/project.js";
import {
  type RegisteredForgeProvider,
  getRegisteredForgeProviders,
} from "../../../services/forgeProviderRegistry.js";
import type {
  PluginTourDescriptor,
  ProjectTemplateDescriptor,
  ProjectTemplatePreview,
  PluginHostedViewDescriptor,
} from "../../../../shared/types/plugin.js";
import type { IpcContext } from "../../types.js";
import { getPluginService } from "./service.js";

export async function handleForgeProvidersGet(): Promise<RegisteredForgeProvider[]> {
  // Same init-race guard as the surrounding pull-on-mount handlers (#9285) —
  // forge descriptors register during the deferred initialize().
  await (await getPluginService()).waitForCatalog();
  return getRegisteredForgeProviders();
}

export async function handleAgentsGet(): Promise<Record<string, AgentConfig>> {
  await (await getPluginService()).waitForCatalog();
  return getPluginAgentRegistry();
}

const AUTO_ASSIGN_VALUES: ReadonlySet<string> = new Set(["always", "never", "prompt"]);

function assertQualifiedRecipeId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("recipeId must be a non-empty string");
  }
  return value;
}

/**
 * Validate the preference patch in main rather than trusting the renderer's
 * shape. `null` clears an override; an absent key is not part of the patch.
 * Provenance is deliberately NOT accepted here — the handler resolves the
 * owning plugin from the registry (#11860).
 */
function parseRecipeMetadataPatch(value: unknown): PluginRecipeMetadataPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("updates must be an object");
  }
  const raw = value as Record<string, unknown>;
  const patch: PluginRecipeMetadataPatch = {};
  if ("showInEmptyState" in raw) {
    const next = raw.showInEmptyState;
    if (next !== null && typeof next !== "boolean") {
      throw new Error("showInEmptyState must be a boolean or null");
    }
    patch.showInEmptyState = next;
  }
  if ("autoAssign" in raw) {
    const next = raw.autoAssign;
    if (next !== null && (typeof next !== "string" || !AUTO_ASSIGN_VALUES.has(next))) {
      throw new Error("autoAssign must be one of always/never/prompt, or null");
    }
    patch.autoAssign = next as PluginRecipeMetadataPatch["autoAssign"];
  }
  return patch;
}

export async function handleRecipesGet(ctx: IpcContext): Promise<TerminalRecipe[]> {
  const service = await getPluginService();
  await service.waitForCatalog();
  return selectContributionsForProject(service.getPluginRecipes(), recipeOwner, ctx.projectId);
}

export async function handleToursGet(ctx: IpcContext): Promise<PluginTourDescriptor[]> {
  const service = await getPluginService();
  await service.waitForCatalog();
  return selectContributionsForProject(
    service.getPluginTours(),
    (tour) => tour.pluginId,
    ctx.projectId
  );
}

/**
 * Every installed plugin's project templates (#13825), for the Create project
 * dialog. Not narrowed to the sender's project: a template starts a new
 * project, so which plugins the current one shows has no bearing on it.
 */
export async function handleProjectTemplatesGet(): Promise<ProjectTemplateDescriptor[]> {
  await (await getPluginService()).waitForCatalog();
  const { getPluginProjectTemplates } =
    await import("../../../services/plugin/PluginProjectTemplateRegistry.js");
  return getPluginProjectTemplates();
}

/**
 * Every file a template would write (#13825), read from the plugin folder main
 * registered for it — the renderer names the template, never a path. A
 * template that can't be copied comes back as data with the reason, so the
 * dialog can say why rather than show a generic failure.
 */
export async function handleProjectTemplatePreview(payload: {
  pluginId: string;
  templateId: string;
}): Promise<ProjectTemplatePreview> {
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.pluginId !== "string" ||
    typeof payload.templateId !== "string"
  ) {
    throw new Error("Invalid project template");
  }
  await (await getPluginService()).waitForCatalog();
  const { previewProjectTemplate } =
    await import("../../../services/plugin/projectTemplateFiles.js");
  return previewProjectTemplate(payload.pluginId, payload.templateId);
}

/**
 * Plugin views that mount outside the panel grid (#13770), as the sender's
 * project may see them: a project plugin's only in its own project, an
 * installed plugin's wherever it is visible. The project comes from the
 * sender, never an argument.
 */
export async function handleHostedViewsGet(ctx: IpcContext): Promise<PluginHostedViewDescriptor[]> {
  await (await getPluginService()).waitForCatalog();
  return getPluginHostedViewsForProject(ctx.projectId);
}

/**
 * Every theme an installed plugin offers (#13832). Not project-scoped: the
 * app theme is one machine-wide selection.
 */
export async function handleThemesGet(): Promise<AppColorScheme[]> {
  await (await getPluginService()).waitForCatalog();
  return getPluginThemeSchemes();
}

export async function handleIconsGet(ctx: IpcContext): Promise<PluginCustomIconAsset[]> {
  await (await getPluginService()).waitForCatalog();
  return getPluginCustomIconsForProject(ctx.projectId);
}

/**
 * A metadata write names its recipe by id, so it gets the same narrowing as
 * `plugin:recipes-get`: a recipe the sender's project cannot see — another
 * project's plugin's, or one hidden here — is not found (#13796). Checked
 * before the write only. A project plugin's scope is fixed for its instance,
 * so the one thing that can change mid-write is an installed plugin being
 * hidden, and the scoped push that follows removes it from the sender anyway;
 * failing a write that already persisted would only report a false failure.
 */
function assertRecipeVisibleToSender(
  recipes: readonly TerminalRecipe[],
  recipeId: string,
  projectId: string | null
): void {
  const recipe = recipes.find((candidate) => candidate.id === recipeId);
  if (!recipe || selectContributionsForProject([recipe], recipeOwner, projectId).length === 0) {
    throw new Error(`Plugin recipe ${recipeId} not found`);
  }
}

export async function handleRecipeRecordUse(
  ctx: IpcContext,
  recipeId: string,
  timestamp: number
): Promise<TerminalRecipe> {
  const service = await getPluginService();
  await service.waitForCatalog();
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error("timestamp must be a positive finite number");
  }
  const id = assertQualifiedRecipeId(recipeId);
  assertRecipeVisibleToSender(service.getPluginRecipes(), id, ctx.projectId);
  return service.recordPluginRecipeUse(id, timestamp);
}

export async function handleRecipeMetadataUpdate(
  ctx: IpcContext,
  recipeId: string,
  updates: PluginRecipeMetadataPatch
): Promise<TerminalRecipe> {
  const service = await getPluginService();
  await service.waitForCatalog();
  const id = assertQualifiedRecipeId(recipeId);
  const patch = parseRecipeMetadataPatch(updates);
  assertRecipeVisibleToSender(service.getPluginRecipes(), id, ctx.projectId);
  return service.updatePluginRecipeMetadata(id, patch);
}
