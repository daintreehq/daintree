import { z } from "zod";
import type { PluginOrigin } from "../../../../shared/types/plugin.js";
import type { ParsedPluginManifest } from "../manifestShape.js";
import { buildManifestValidationContext } from "./context.js";
import { validateAccountConnections, validateServiceNames } from "./accounts.js";
import {
  validateAgentIds,
  validateAgentMcp,
  validateAgentRegistration,
  validateMcpServerSettingsTokens,
  validateProcessTools,
} from "./agents.js";
import { validateApplication } from "./application.js";
import { validateAssistantKnowledge, validatePromptTemplates } from "./content.js";
import {
  validateContextProviders,
  validateElementPickerProviders,
  validateFileEditorViews,
  validateFileEditors,
  validateForgeProviderRefs,
} from "./providers.js";
import { validateContributedActionIds, validateEventRoutes } from "./actions.js";
import { validateDatabases } from "./databases.js";
import { validateDefaultLayout, validateSurfaceViews, validateViews } from "./views.js";
import {
  validateLaunchEntries,
  validateLayouts,
  validatePanelActionSurfaces,
  validateSearchProviders,
  validateToolbarButtons,
} from "./panels.js";
import {
  validateProjectRuntimeContributions,
  validateReservedNamespace,
  validateScopeAndInstanceMode,
  validateSurfacesScope,
  validateWorksWith,
} from "./scope.js";
import { validateRecipes, validateTerminalLinks } from "./terminals.js";
import { validateSetupSteps } from "./settings.js";
import { validateTourFinishActions, validateTourPanelKinds } from "./tours.js";
import { validateUniqueIds, validateUniqueIdsAfterContextProviders } from "./uniqueness.js";

/**
 * The manifest-wide rules, run as the manifest schema's `superRefine`. Each
 * validator owns one contribution domain; they run in a fixed order because
 * the order is the order a manifest's issues are reported in.
 */
export function validatePluginManifest(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  origin: PluginOrigin
): void {
  const context = buildManifestValidationContext(manifest, origin);
  validateScopeAndInstanceMode(manifest, ctx, context);
  validateWorksWith(manifest, ctx);
  validateServiceNames(manifest, ctx);
  validateProjectRuntimeContributions(manifest, ctx, context);
  validateDatabases(manifest, ctx, context);
  validateAccountConnections(manifest, ctx, context);
  validateSurfacesScope(manifest, ctx);
  validateReservedNamespace(manifest, ctx, context);
  validateFileEditors(manifest, ctx, context);
  validateEventRoutes(manifest, ctx, context);
  validateAgentRegistration(manifest, ctx, context);
  validateElementPickerProviders(manifest, ctx, context);
  validateAgentMcp(manifest, ctx, context);
  validateAssistantKnowledge(manifest, ctx);
  validateAgentIds(manifest, ctx);
  validateProcessTools(manifest, ctx);
  validateContributedActionIds(manifest, ctx, context);
  validatePanelActionSurfaces(manifest, ctx, context);
  validateTerminalLinks(manifest, ctx, context);
  // Duplicate ids are reported in two passes, either side of the prompt
  // template and context provider checks, because that is where they have
  // always been reported.
  validateUniqueIds(manifest, ctx);
  validatePromptTemplates(manifest, ctx);
  validateContextProviders(manifest, ctx);
  validateUniqueIdsAfterContextProviders(manifest, ctx);
  validateSetupSteps(manifest, ctx, context);
  validateTourFinishActions(manifest, ctx, context);
  validateForgeProviderRefs(manifest, ctx, context);
  validateSurfaceViews(manifest, ctx, context);
  validateDefaultLayout(manifest, ctx);
  validateApplication(manifest, ctx, context);
  validateToolbarButtons(manifest, ctx, context);
  validateLaunchEntries(manifest, ctx, context);
  validateSearchProviders(manifest, ctx, context);
  validateRecipes(manifest, ctx);
  validateLayouts(manifest, ctx);
  validateTourPanelKinds(manifest, ctx, context);
  validateFileEditorViews(manifest, ctx, context);
  validateViews(manifest, ctx, context);
  validateMcpServerSettingsTokens(manifest, ctx, context);
}
