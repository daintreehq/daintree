// The manifest's field shape, before the cross-contribution validators in `./validation/` run.

import * as semver from "semver";
import { z } from "zod";
import { SCOPED_PLUGIN_NAME_PATTERN } from "../pluginIdentifiers.js";
import {
  AGENT_MCP_MAX_ENDPOINTS_PER_PLUGIN,
  PLUGIN_CATEGORY_IDS,
  PLUGIN_EVENT_ROUTE_EVENTS,
} from "../../../shared/types/plugin.js";
import { TERMINAL_LINK_MAX_PER_PLUGIN } from "../../../shared/utils/pluginTerminalLinks.js";
import {
  AgentContributionSchema,
  AgentMcpContributionSchema,
  McpServerContributionSchema,
  ProcessToolContributionSchema,
} from "./agents.js";
import {
  AssistantKnowledgeContributionSchema,
  ProjectTemplateContributionSchema,
  PromptTemplateContributionSchema,
  SkillContributionSchema,
  ThemeContributionSchema,
} from "./content.js";
import {
  CommandContributionSchema,
  ContextMenuContributionSchema,
  EventRouteSchema,
  KeybindingContributionSchema,
  MenuItemContributionSchema,
  PluginCapabilitySchema,
} from "./actions.js";
import {
  ContextProviderContributionSchema,
  ElementPickerProviderContributionSchema,
  FileDecorationContributionSchema,
  FileEditorContributionSchema,
  ForgeProviderContributionSchema,
  WorktreeDeleteNotesContributionSchema,
} from "./providers.js";
import { DatabaseContributionSchema } from "./databases.js";
import {
  LaunchEntryContributionSchema,
  LayoutContributionSchema,
  PanelContributionSchema,
  SearchProviderContributionSchema,
  ToolbarButtonContributionSchema,
} from "./panels.js";
import {
  PluginAccountContributionSchema,
  PluginConnectionContributionSchema,
  PluginServicesContributionSchema,
} from "./accounts.js";
import { PluginApplicationSchema } from "./application.js";
import { PluginAuthorSchema, PluginManifestScopesSchema } from "./permissions.js";
import {
  RecipeContributionSchema,
  TerminalLinkContributionSchema,
  WorktreeSetupStepContributionSchema,
} from "./terminals.js";
import { SettingDefinitionSchema, SetupStepContributionSchema } from "./settings.js";
import { SurfaceContributionsSchema, ViewContributionSchema } from "./views.js";
import { TourContributionSchema } from "./tours.js";

/** Values of a manifest's `platforms`: Node's `process.platform` names. */
export const PLUGIN_PLATFORMS = ["darwin", "linux", "win32"] as const;

/**
 * Per-array upper bounds for `contributes.*`. A crafted manifest with tens of
 * thousands of entries would otherwise exhaust the registration loops in
 * `PluginService.loadPlugin`. These caps are generous relative to any plausible
 * real plugin — they exist to reject pathological/adversarial manifests, not to
 * constrain legitimate authors. Exported so tests reference the values without
 * magic numbers. Keyed by the stable (canonical) contribution names — the
 * deprecated `experimental_*` aliases are normalized to these before the cap
 * check runs (see `normalizeDeprecatedContributionAliases`).
 */
export const MANIFEST_CONTRIBUTION_CAPS = {
  panels: 50,
  toolbarButtons: 100,
  // Small on purpose, unlike the rest: these are rows in a shared launcher, and
  // one plugin must not be able to bury everyone else's.
  launchEntries: 20,
  layouts: 20,
  // Each claims a keyword in a shared switcher, so a plugin gets a handful.
  searchProviders: 5,
  menuItems: 200,
  keybindings: 200,
  contextMenus: 200,
  commands: 200,
  views: 50,
  mcpServers: 20,
  skills: 50,
  themes: 20,
  promptTemplates: 50,
  terminalLinks: TERMINAL_LINK_MAX_PER_PLUGIN,
  contextProviders: 10,
  forgeProviders: 20,
  elementPickerProviders: 20,
  fileDecorationProviders: 50,
  // One check per plugin: the confirmation shows one attributed answer (or one
  // "didn't answer") per plugin, never a partial answer.
  worktreeDeleteNotes: 1,
  fileEditors: 10,
  agents: 50,
  processTools: 100,
  settings: 200,
  recipes: 50,
  agentMcp: AGENT_MCP_MAX_ENDPOINTS_PER_PLUGIN,
  tours: 10,
  // Each is a choice in the Create project dialog's template list.
  projectTemplates: 10,
  databases: 16,
  // Each one runs, in sequence, before a new worktree is ready.
  worktreeSetupSteps: 10,
  // A checklist the user reads through; a long one isn't setup any more.
  setup: 10,
  // Each is a row the user signs in to by hand.
  connections: 8,
} as const;

/**
 * Upper bound on the top-level `authors` array. Attribution is metadata, not a
 * registration loop, so the cap is small — generous for any real plugin's
 * credits list while rejecting pathological manifests. Exported so tests
 * reference it without a magic number.
 */
export const MANIFEST_AUTHORS_CAP = 10;

/**
 * Upper bound on the top-level `worksWith` array. It names plugins to disclose
 * beside this one, never ones the host loads, so a short list is all it needs.
 */
export const MANIFEST_WORKS_WITH_CAP = 16;

/**
 * Deprecated `contributes` keys promoted to stable names in the 1.0 freeze.
 * Old manifests are still accepted (the value is migrated to the canonical key);
 * `PluginService` surfaces a deprecation warning when an alias is encountered.
 */
export const DEPRECATED_CONTRIBUTION_ALIASES = {
  experimental_views: "views",
  experimental_mcpServers: "mcpServers",
} as const;

/**
 * Normalizes deprecated `contributes` aliases to their canonical names before
 * strict validation, so the frozen schema never carries an `experimental_*`
 * field while old manifests keep parsing. The canonical key wins when both are
 * present; the deprecated key is always stripped so `strictObject` accepts it.
 */
function normalizeDeprecatedContributionAliases(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const [deprecated, canonical] of Object.entries(DEPRECATED_CONTRIBUTION_ALIASES)) {
    if (!(deprecated in obj)) {
      continue;
    }
    next ??= { ...obj };
    // Canonical wins when present — an explicit `views: []` is canonical and is
    // NOT overwritten by a deprecated value. Only fall back to the deprecated
    // value when the canonical key is missing (`undefined`/`null`), so a manifest
    // mixing `views: null` with `experimental_views: [...]` recovers gracefully
    // instead of failing on the null.
    if (next[canonical] == null) {
      next[canonical] = next[deprecated];
    }
    delete next[deprecated];
  }
  return next ?? obj;
}

/**
 * `z.record` skips an own `__proto__` key before validating it, so a cue named
 * that would vanish from `contributes.tours[].chapters[].cues` without a word.
 * Refuse it while the raw JSON still carries it. This runs in the `contributes`
 * preprocess rather than on the `cues` field because a preprocess below a
 * `.default()` makes the JSON Schema emitter drop every default above it.
 */
function reportReservedTourCueNames(raw: unknown, ctx: z.RefinementCtx): void {
  const tours = (raw as { tours?: unknown } | null)?.tours;
  if (!Array.isArray(tours)) return;
  tours.forEach((tour, tourIndex) => {
    const chapters = (tour as { chapters?: unknown } | null)?.chapters;
    if (!Array.isArray(chapters)) return;
    chapters.forEach((chapter, chapterIndex) => {
      const cues = (chapter as { cues?: unknown } | null)?.cues;
      if (typeof cues === "object" && cues !== null && Object.hasOwn(cues, "__proto__")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tours", tourIndex, "chapters", chapterIndex, "cues"],
          message: 'Cue name "__proto__" is reserved.',
          params: { errorCode: "tour_cue_name_reserved" },
        });
      }
    });
  });
}

// `docs`, `runbooks` and `decisions` would name a plugin's server
// `daintree-docs`, `daintree-runbooks` or `daintree-decisions`: the Daintree
// Assistant's own servers, and the one agents ask the person through. Excluded
// in the pattern itself, not a refinement, so the generated JSON Schema
// rejects them too.
const PLUGIN_MCP_NAME_PATTERN = /^(?!(?:docs|runbooks|decisions)$)[a-z0-9][a-z0-9-]{0,15}$/;

/**
 * The manifest object with every field's own validation and defaults. The
 * cross-contribution rules run over its output in `./validation/`.
 */
export function buildPluginManifestObjectSchema() {
  return z.strictObject({
    // Editors and agents key completion and inline validation off `$schema`,
    // and the object is strict, so without an explicit slot a manifest that
    // names its own contract is refused for naming it. Accepted, never read:
    // the host's authority is this schema, not whatever the URL resolves to.
    $schema: z.string().optional(),
    name: z.string().min(1).max(64).regex(SCOPED_PLUGIN_NAME_PATTERN, {
      error: 'Plugin name must be in publisher.name format (e.g. "acme.linear-context")',
    }),
    version: z
      .string()
      .trim()
      .min(1)
      .refine((val) => semver.valid(val) !== null, {
        message: "version must be a valid semver (e.g. 1.2.3)",
      }),
    displayName: z.string().optional(),
    // Agents see the plugin's MCP server as `daintree-<mcpName>`, which must
    // fit Claude's 25-character server key and be a bare TOML key for Codex.
    mcpName: z
      .string()
      .regex(PLUGIN_MCP_NAME_PATTERN, {
        error:
          'mcpName must be 1-16 lowercase letters, digits or hyphens, starting with a letter or digit, and not "docs", "runbooks" or "decisions"',
      })
      .optional(),
    description: z.string().optional(),
    tagline: z.string().trim().min(1).max(120).optional(),
    authors: z.array(PluginAuthorSchema).max(MANIFEST_AUTHORS_CAP).optional(),
    // Other plugins this one works with, by manifest id. Disclosure only:
    // nothing is installed, loaded or ordered from it.
    worksWith: z
      .array(z.string().min(1).max(64).regex(SCOPED_PLUGIN_NAME_PATTERN))
      .max(MANIFEST_WORKS_WITH_CAP)
      .refine((list) => new Set(list).size === list.length, {
        message: "worksWith must not repeat an entry",
      })
      .optional(),
    category: z.enum(PLUGIN_CATEGORY_IDS).optional(),
    main: z.string().optional(),
    engines: z
      .object({
        daintree: z
          .string()
          .trim()
          .min(1)
          .refine((val) => semver.validRange(val) !== null, {
            message: "engines.daintree must be a valid semver range",
          })
          .optional(),
      })
      .optional(),
    // Declares the plugin is only ever loaded project-locally. Shape only
    // here — whether it is required, optional-but-rejected, or absent is a
    // function of the discovering `origin`, enforced in `superRefine`.
    scope: z.literal("project").optional(),
    // Opt-in for an INSTALLED package to run as independently bound project
    // instances instead of one app-wide singleton. Absent means singleton, so
    // every existing manifest parses and loads exactly as before. Whether the
    // origin may declare it is enforced in `superRefine`.
    instanceMode: z.literal("project").optional(),
    // Project plugins only; its references are resolved in `superRefine`.
    application: PluginApplicationSchema.optional(),
    // Whether a window attached from another machine may use the plugin.
    // Absent means supported: plugin main code runs on the host either way.
    remote: z.enum(["supported", "unsupported"]).optional(),
    // The operating systems the package has a build for. Absent means any:
    // only a plugin shipping native modules for one OS needs to say so, and
    // installing it on another machine is refused before anything is copied.
    platforms: z
      .array(z.enum(PLUGIN_PLATFORMS))
      .min(1)
      .max(PLUGIN_PLATFORMS.length)
      .refine((list) => new Set(list).size === list.length, {
        message: "platforms must not repeat an entry",
      })
      .optional(),
    capabilities: z.array(PluginCapabilitySchema).default([]),
    scopes: PluginManifestScopesSchema.optional(),
    activationEvents: z.array(z.literal("onStartupFinished")).default([]),
    // One route per event at most, so the cap is the size of the closed list.
    // Cross-checks against `commands` and `capabilities` live in `superRefine`.
    eventRoutes: z.array(EventRouteSchema).max(PLUGIN_EVENT_ROUTE_EVENTS.length).default([]),
    contributes: z.preprocess(
      (raw, ctx) => {
        reportReservedTourCueNames(raw, ctx);
        return normalizeDeprecatedContributionAliases(raw);
      },
      z
        .strictObject({
          panels: z
            .array(PanelContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.panels)
            .default([]),
          toolbarButtons: z
            .array(ToolbarButtonContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.toolbarButtons)
            .default([]),
          launchEntries: z
            .array(LaunchEntryContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.launchEntries)
            .default([]),
          layouts: z
            .array(LayoutContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.layouts)
            .default([]),
          searchProviders: z
            .array(SearchProviderContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.searchProviders)
            .default([]),
          menuItems: z
            .array(MenuItemContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.menuItems)
            .default([]),
          keybindings: z
            .array(KeybindingContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.keybindings)
            .default([]),
          contextMenus: z
            .array(ContextMenuContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.contextMenus)
            .default([]),
          commands: z
            .array(CommandContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.commands)
            .default([]),
          views: z.array(ViewContributionSchema).max(MANIFEST_CONTRIBUTION_CAPS.views).default([]),
          mcpServers: z
            .array(McpServerContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.mcpServers)
            .default([]),
          skills: z
            .array(SkillContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.skills)
            .default([]),
          assistantKnowledge: AssistantKnowledgeContributionSchema.optional(),
          themes: z
            .array(ThemeContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.themes)
            .default([]),
          contextProviders: z
            .array(ContextProviderContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.contextProviders)
            .default([]),
          forgeProviders: z
            .array(ForgeProviderContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.forgeProviders)
            .default([]),
          elementPickerProviders: z
            .array(ElementPickerProviderContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.elementPickerProviders)
            .default([]),
          fileDecorationProviders: z
            .array(FileDecorationContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.fileDecorationProviders)
            .default([]),
          worktreeDeleteNotes: z
            .array(WorktreeDeleteNotesContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.worktreeDeleteNotes)
            .default([]),
          fileEditors: z
            .array(FileEditorContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.fileEditors)
            .default([]),
          agents: z
            .array(AgentContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.agents)
            .default([]),
          processTools: z
            .array(ProcessToolContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.processTools)
            .default([]),
          settings: z
            .array(SettingDefinitionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.settings)
            .default([]),
          promptTemplates: z
            .array(PromptTemplateContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.promptTemplates)
            .default([]),
          terminalLinks: z
            .array(TerminalLinkContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.terminalLinks)
            .default([]),
          recipes: z
            .array(RecipeContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.recipes)
            .default([]),
          agentMcp: z
            .array(AgentMcpContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.agentMcp)
            .default([]),
          tours: z.array(TourContributionSchema).max(MANIFEST_CONTRIBUTION_CAPS.tours).default([]),
          projectTemplates: z
            .array(ProjectTemplateContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.projectTemplates)
            .default([]),
          databases: z
            .array(DatabaseContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.databases)
            .default([]),
          worktreeSetupSteps: z
            .array(WorktreeSetupStepContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.worktreeSetupSteps)
            .default([]),
          setup: z
            .array(SetupStepContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.setup)
            .default([]),
          // Not an array, so it carries no MANIFEST_CONTRIBUTION_CAPS entry —
          // three optional fixed slots are structurally bounded already.
          surfaces: SurfaceContributionsSchema.default({}),
          account: PluginAccountContributionSchema.optional(),
          connections: z
            .array(PluginConnectionContributionSchema)
            .max(MANIFEST_CONTRIBUTION_CAPS.connections)
            .optional(),
          // An object of two capped arrays, so no MANIFEST_CONTRIBUTION_CAPS entry.
          services: PluginServicesContributionSchema.default(() => ({
            provides: [],
            requires: [],
          })),
        })
        // A factory, not a literal: zod only shallow-clones a default value,
        // so a literal's arrays would be shared by every parse of the cached
        // schema.
        .default(() => ({
          panels: [],
          toolbarButtons: [],
          launchEntries: [],
          layouts: [],
          searchProviders: [],
          menuItems: [],
          keybindings: [],
          contextMenus: [],
          commands: [],
          views: [],
          mcpServers: [],
          skills: [],
          themes: [],
          promptTemplates: [],
          terminalLinks: [],
          contextProviders: [],
          forgeProviders: [],
          elementPickerProviders: [],
          fileDecorationProviders: [],
          worktreeDeleteNotes: [],
          fileEditors: [],
          agents: [],
          processTools: [],
          settings: [],
          recipes: [],
          agentMcp: [],
          tours: [],
          projectTemplates: [],
          databases: [],
          worktreeSetupSteps: [],
          setup: [],
          surfaces: {},
          services: { provides: [], requires: [] },
        }))
    ),
  });
}

/** A manifest as the field shape parses it, before the cross-contribution validators. */
export type ParsedPluginManifest = z.output<ReturnType<typeof buildPluginManifestObjectSchema>>;
