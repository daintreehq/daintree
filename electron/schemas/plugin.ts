import { z } from "zod";
import {
  SAFE_ID_PATTERN,
  SCOPED_PLUGIN_NAME_PATTERN,
  isPrivateOrLoopbackHostname,
} from "./pluginIdentifiers.js";
import type {
  McpServerContribution,
  MenuItemContribution,
  PanelContribution,
  PluginCapability,
  PluginManifest,
  PluginOrigin,
  PromptTemplateContribution,
  SkillContribution,
  ThemeContribution,
  ToolbarButtonContribution,
  ViewContribution,
} from "../../shared/types/plugin.js";
import type {
  FileDecorationContribution,
  ForgeProviderContribution,
} from "../../shared/types/forge.js";
import { buildPluginManifestObjectSchema } from "./plugin/manifestShape.js";
import { validatePluginManifest } from "./plugin/validation/index.js";

// Identifier patterns + hostname classification live in the dependency-light
// `./pluginIdentifiers.ts` so boot-path modules can use them without pulling
// this file's zod schema construction into the eager graph. Re-exported here
// because the install/validate consumers of the schemas below use them too.
export { SAFE_ID_PATTERN, SCOPED_PLUGIN_NAME_PATTERN, isPrivateOrLoopbackHostname };

export {
  isBuiltInActionId,
  MenuItemContributionSchema,
  KeybindingContributionSchema,
  ContextMenuContributionSchema,
  PluginCapabilitySchema,
  CommandContributionSchema,
  EventRouteSchema,
} from "./plugin/actions.js";
export {
  PanelMenuItemSchema,
  PanelToolbarItemSchema,
  PanelContributionObjectSchema,
  PanelContributionSchema,
  ToolbarButtonPopoverSchema,
  ToolbarButtonContributionSchema,
  LAUNCH_ENTRY_PROMPT_MAX_LENGTH,
  LAUNCH_ENTRY_ARGS_MAX_BYTES,
  LaunchEntryPanelTargetSchema,
  LaunchEntryCommandTargetSchema,
  LaunchEntryAgentTargetSchema,
  LaunchEntryContributionSchema,
  LAYOUT_MAX_ENTRIES,
  LayoutEntryContributionSchema,
  LayoutContributionSchema,
  SearchProviderTargetSchema,
  SearchProviderContributionSchema,
} from "./plugin/panels.js";
export {
  PLUGIN_PLATFORMS,
  MANIFEST_CONTRIBUTION_CAPS,
  MANIFEST_AUTHORS_CAP,
  MANIFEST_WORKS_WITH_CAP,
  DEPRECATED_CONTRIBUTION_ALIASES,
} from "./plugin/manifestShape.js";
export {
  FILE_EDITOR_MAX_PATH_PATTERNS,
  FileEditorPathPatternSchema,
  FileExtensionListSchema,
  CredentialFieldSchema,
  ForgeProviderContributionSchema,
  ElementPickerDetectionRuleSchema,
  ElementPickerProviderContributionSchema,
  ContextProviderContributionSchema,
  FileDecorationContributionSchema,
  WorktreeDeleteNotesContributionSchema,
  FILE_EDITOR_MAX_BYTES_CEILING,
  FileEditorContributionSchema,
} from "./plugin/providers.js";
export {
  ViewContributionSchema,
  SurfaceViewSlotSchema,
  SurfaceContributionsSchema,
} from "./plugin/views.js";
export {
  McpServerContributionSchema,
  AgentMcpToolGroupSchema,
  AgentMcpServerSourceToolSchema,
  AgentMcpServerSourceSchema,
  AgentMcpContributionSchema,
  ProcessToolContributionSchema,
  AgentDetectionConfigSchema,
  AgentResumeConfigSchema,
  AgentContributionSchema,
} from "./plugin/agents.js";
export {
  DATABASE_QUERY_MAX_PARAMS,
  DATABASE_QUERY_PARAM_FORMATS,
  DatabaseQueryParamSchema,
  DatabaseQueryContributionSchema,
  DatabaseContributionSchema,
} from "./plugin/databases.js";
export {
  SkillContributionSchema,
  AssistantKnowledgeSkillSchema,
  AssistantKnowledgeReferenceSchema,
  AssistantKnowledgeContributionSchema,
  ThemeContributionSchema,
  PromptTemplateArgumentSchema,
  PromptTemplateContributionSchema,
  ProjectTemplateContributionSchema,
} from "./plugin/content.js";
export {
  RecipeContributionTerminalSchema,
  RecipeContributionSchema,
  WorktreeSetupStepContributionSchema,
  TerminalLinkUrlSchema,
  TerminalLinkContributionSchema,
} from "./plugin/terminals.js";
export {
  PluginAccountContributionSchema,
  PluginConnectionContributionSchema,
  MANIFEST_SERVICE_PROVIDES_CAP,
  MANIFEST_SERVICE_REQUIRES_CAP,
  MANIFEST_SERVICE_METHODS_CAP,
  PluginServiceProvideContributionSchema,
  PluginServiceRequireContributionSchema,
  PluginServicesContributionSchema,
} from "./plugin/accounts.js";
export {
  SetupStepSettingDoneSchema,
  SetupStepAccountDoneSchema,
  SetupStepContextDoneSchema,
  SetupStepSettingsActionSchema,
  SetupStepCommandActionSchema,
  SetupStepContributionSchema,
  SettingDefinitionObjectSchema,
  SettingDefinitionSchema,
} from "./plugin/settings.js";
export {
  TOUR_CONTRIBUTION_LIMITS,
  TourCaptionSchema,
  TourChapterSchema,
  TourFinishSchema,
  TourContributionSchema,
} from "./plugin/tours.js";
export {
  PluginAuthorSchema,
  PluginNetworkScopeSchema,
  PluginFsScopeSchema,
  PluginAllowedSocketPathSchema,
  PluginLocalSocketScopeSchema,
  PluginManifestScopesSchema,
} from "./plugin/permissions.js";
export {
  PluginToastOptionsSchema,
  PluginNotifyOptionsSchema,
  PluginPanelBadgeSchema,
  PluginToolbarButtonRuntimeStateSchema,
} from "./plugin/runtime.js";
export { PROJECT_SCOPE_UNSCOPED_CONTRIBUTIONS } from "./plugin/validation/scope.js";
export {
  PluginApplicationTourRefSchema,
  PluginApplicationNavigationParamSchema,
  PluginApplicationSectionSchema,
  PluginApplicationNavigationSchema,
  PLUGIN_APPLICATION_NAME_MAX,
  PluginApplicationSchema,
} from "./plugin/application.js";

/** The schema {@link getPluginManifestSchema} hands back, for the overloads. */
type PluginManifestSchema = ReturnType<typeof buildPluginManifestSchema>;

/**
 * Builds the manifest schema for a given discovery root.
 *
 * `origin` is what the three-way rules key off: the reserved `daintree.*`
 * namespace (builtin only), and the `scope: "project"` gate in both directions
 * (required under `"project"`, rejected under the other two).
 */
export function getPluginManifestSchema(origin: PluginOrigin): PluginManifestSchema;
/**
 * @deprecated Pass a {@link PluginOrigin}. Transitional bridge for call sites
 * still on the old two-valued flag — `true` maps to `"builtin"`, `false` to
 * `"user"`, which is exactly what the boolean meant. It cannot express
 * `"project"`, so every caller that needs to must move to the string form; the
 * overload goes away once the last boolean caller does.
 */
export function getPluginManifestSchema(isBuiltin: boolean): PluginManifestSchema;
export function getPluginManifestSchema(origin: PluginOrigin | boolean): PluginManifestSchema {
  const key = typeof origin === "boolean" ? (origin ? "builtin" : "user") : origin;
  let schema = manifestSchemaCache.get(key);
  if (!schema) {
    schema = buildPluginManifestSchema(key);
    manifestSchemaCache.set(key, schema);
  }
  return schema;
}

/**
 * One schema per origin. Zod schemas are immutable, and rebuilding the ~800-line
 * tree per parse also threw away the parser zod compiles on first use.
 */
const manifestSchemaCache = new Map<PluginOrigin, PluginManifestSchema>();

/**
 * Parse a manifest for loading, isolating malformed `contributes.tours` entries
 * (#12768): a tour is optional polish, so a bad one is dropped and its issues
 * returned as `droppedTourIssues` rather than refusing the whole plugin. Only
 * issues addressed to a single tour entry are isolated — a cap overflow or the
 * project-scope refusal sits on the array itself and still fails the parse, as
 * does any other issue. Authoring surfaces (`daintree-plugin validate`, the
 * installer) keep the strict parse so the author still sees every error.
 */
export function parsePluginManifestForLoad(
  origin: PluginOrigin,
  json: unknown
): {
  result: ReturnType<PluginManifestSchema["safeParse"]>;
  droppedTourIssues: z.core.$ZodIssue[];
} {
  const schema = getPluginManifestSchema(origin);
  const result = schema.safeParse(json);
  const raw = json as { contributes?: { tours?: unknown } } | null;
  if (result.success || !Array.isArray(raw?.contributes?.tours)) {
    return { result, droppedTourIssues: [] };
  }

  // Manifest-level refinements (duplicate ids, panelKind) may be withheld while
  // an entry is still malformed, so a drop can surface another round. Each
  // round removes at least one entry, which bounds the loop by the array length.
  let tours: unknown[] = raw.contributes.tours;
  let originalIndex = tours.map((_tour, index) => index);
  let current: ReturnType<PluginManifestSchema["safeParse"]> = result;
  const dropped: z.core.$ZodIssue[] = [];
  while (!current.success) {
    const bad = new Set<number>();
    for (const issue of current.error.issues) {
      const [root, group, index, ...rest] = issue.path;
      if (root !== "contributes" || group !== "tours" || typeof index !== "number") {
        return { result, droppedTourIssues: [] };
      }
      bad.add(index);
      dropped.push({ ...issue, path: ["contributes", "tours", originalIndex[index], ...rest] });
    }
    tours = tours.filter((_tour, index) => !bad.has(index));
    originalIndex = originalIndex.filter((_original, index) => !bad.has(index));
    current = schema.safeParse({ ...raw, contributes: { ...raw.contributes, tours } });
  }
  return { result: current, droppedTourIssues: dropped };
}

/**
 * Edit distance, capped: anything past `max` is "not a near miss" and the walk
 * can stop. Only ever run against the handful of manifest field names, so the
 * quadratic table is a few dozen cells.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The manifest field `key` was probably meant to be, or undefined when nothing
 * is close enough to be worth guessing at. A singular/plural slip counts
 * whatever its edit distance — `author` for `authors` is the one this was
 * written for (#12212) — and otherwise a short field name gets one edit of
 * latitude and a longer one gets two.
 */
export function suggestManifestKey(key: string, known: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  // Every candidate is scored before one is chosen. Returning on the first
  // acceptable match let a plural shortcut win over an exact one that came
  // later in the shape — `"Scopes"` matched `scope` and never reached `scopes`.
  let best: string | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const candidateLower = candidate.toLowerCase();
    // Rank, not distance: an exact match beats a plural slip beats an edit.
    const rank =
      candidateLower === lower
        ? 0
        : candidateLower === `${lower}s` || `${candidateLower}s` === lower
          ? 1
          : (() => {
              const budget = Math.min(candidate.length, key.length) >= 5 ? 2 : 1;
              const distance = editDistance(lower, candidateLower, budget);
              return distance <= budget ? 1 + distance : Number.POSITIVE_INFINITY;
            })();
    if (rank < bestRank) {
      best = candidate;
      bestRank = rank;
      if (rank === 0) break;
    }
  }
  return best;
}

/**
 * Turn a rejected manifest into the one line a plugin author can act on.
 *
 * An unrecognized key wins over whatever Zod reported first, because a key the
 * schema has never heard of is almost always a typo, and a typo is the single
 * most fixable thing in the list — `"author"` for `authors` cost a real
 * debugging session with no signal anywhere but a red row in the plugin
 * manager (#12212). Everything else keeps the existing `path: message` shape.
 *
 * Pure formatting over data the parse already produced: it reads nothing from
 * disk and executes nothing, so it is safe on the pre-trust discovery path.
 */
export function describeManifestIssues(
  issues: readonly z.core.$ZodIssue[],
  schema: PluginManifestSchema
): string {
  // Only a ROOT unrecognized key can be scored against the manifest's own
  // shape. A stray key nested under `contributes` is a different vocabulary
  // entirely, and matching it against the root would suggest a field that is
  // invalid exactly where the author put it — `version` inside `contributes`
  // "did you mean version?" being the absurd case.
  // An explicit type predicate: narrowing on `code` alone would be inferred,
  // but adding the path test to the same expression loses it.
  const unrecognized = issues.find(
    (issue): issue is Extract<z.core.$ZodIssue, { code: "unrecognized_keys" }> =>
      issue.code === "unrecognized_keys" && issue.path.length === 0
  );
  if (unrecognized) {
    const suggestions = unrecognized.keys
      .map((key) => {
        const suggestion = suggestManifestKey(key, Object.keys(schema.shape));
        return suggestion ? `did you mean "${suggestion}" instead of "${key}"?` : null;
      })
      .filter((hint): hint is string => hint !== null);
    // A key nothing resembles is not more actionable than whatever Zod
    // reported first, so it does not get to displace it.
    if (suggestions.length > 0) {
      return `${unrecognized.message} — ${suggestions.join(" ")}`;
    }
  }

  const first = issues[0];
  const where = first?.path.length ? `${first.path.join(".")}: ` : "";
  return `${where}${first?.message ?? "manifest failed validation"}`;
}

function buildPluginManifestSchema(origin: PluginOrigin) {
  return buildPluginManifestObjectSchema().superRefine((manifest, ctx) =>
    validatePluginManifest(manifest, ctx, origin)
  );
}

export type {
  PluginManifest,
  PanelContribution,
  ToolbarButtonContribution,
  MenuItemContribution,
  ViewContribution,
  McpServerContribution,
  SkillContribution,
  ThemeContribution,
  PromptTemplateContribution,
  PluginCapability,
};
export type { ForgeProviderContribution, FileDecorationContribution };
