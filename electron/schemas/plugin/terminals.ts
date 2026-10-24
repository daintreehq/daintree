// Terminal-facing contributions: recipes, worktree setup steps and terminal links.

import { z } from "zod";
import { SAFE_ID_PATTERN } from "../pluginIdentifiers.js";
import {
  PLUGIN_WORKTREE_SETUP_STEP_LABEL_MAX,
  PLUGIN_WORKTREE_SETUP_STEP_MAX_TIMEOUT_MS,
  PLUGIN_WORKTREE_SETUP_STEP_MIN_TIMEOUT_MS,
} from "../../../shared/types/plugin.js";
import {
  MAX_TERMINALS_PER_RECIPE,
  RECIPE_PANEL_ARGS_MAX_BYTES,
} from "../../../shared/utils/recipeSanitizer.js";
import {
  MAX_PLUGIN_RECIPE_VARIABLES,
  PLUGIN_RECIPE_VARIABLE_NAME_MAX_LENGTH,
  PLUGIN_RECIPE_VARIABLE_NAME_PATTERN,
} from "../../../shared/utils/pluginRecipeVariables.js";
import { SYSTEM_PROMPT_MAX_LENGTH } from "../../../shared/utils/agentSystemPrompt.js";
import {
  TERMINAL_LINK_HOST_MAX_LENGTH,
  TERMINAL_LINK_PATH_PREFIX_MAX_LENGTH,
  TERMINAL_LINK_PATTERN_MAX_LENGTH,
} from "../../../shared/utils/pluginTerminalLinks.js";
import { utf8 } from "./common.js";

/**
 * One terminal inside a `contributes.recipes` entry (#11860). Only the
 * authorable fields — the transient per-launch overrides (`agentModelId`,
 * `agentLaunchFlags`, `location`) are session state that the recipe editor
 * already strips on persist, so a manifest declaring them is rejected loudly
 * rather than having them silently dropped.
 *
 * This validates SHAPE only. Content (control characters, an unknown `type`,
 * a non-string env value) is the sanitizer's job — `sanitizeRecipeTerminals`
 * runs over every contributed terminal at registration, which is also where a
 * `type` naming the same plugin's contributed agent is admitted.
 */
export const RecipeContributionTerminalSchema = z
  .object({
    type: z.string().min(1).max(64),
    title: z.string().max(200).optional(),
    command: z.string().max(4096).optional(),
    env: z.record(z.string(), z.string()).optional(),
    initialPrompt: z.string().max(8192).optional(),
    systemPrompt: z.string().max(SYSTEM_PROMPT_MAX_LENGTH).optional(),
    args: z.string().max(4096).optional(),
    devCommand: z.string().max(4096).optional(),
    exitBehavior: z.enum(["keep", "trash", "remove"]).optional(),
    panelId: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    panelArgs: z
      .record(z.string(), z.unknown())
      .refine((args) => utf8.encode(JSON.stringify(args)).length <= RECIPE_PANEL_ARGS_MAX_BYTES, {
        message: `panelArgs must be at most ${RECIPE_PANEL_ARGS_MAX_BYTES} bytes of JSON`,
      })
      .optional(),
  })
  .strict();

/**
 * `contributes.recipes` manifest entry (#11860). A recipe is a named
 * multi-terminal launch layout registered under `{pluginId}.{id}` and merged
 * into the recipe list as a plugin-owned tier: in every project for an
 * installed plugin, in its own project only for a `scope: "project"` one.
 *
 * Terminals are inline rather than a path to a shipped JSON file: the
 * install-time confirmation reads the manifest WITHOUT extracting the archive,
 * so an out-of-line file could never be disclosed before the user approves.
 *
 * Like {@link SkillContributionSchema}, recipes carry no capability
 * requirement. `showInEmptyState` / `autoAssign` are defaults the user's
 * sidecar overrides. Strict so unknown fields fail loudly.
 */
export const RecipeContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1).max(200),
    terminals: z.array(RecipeContributionTerminalSchema).min(1).max(MAX_TERMINALS_PER_RECIPE),
    showInEmptyState: z.boolean().optional(),
    autoAssign: z.enum(["always", "never", "prompt"]).optional(),
    variables: z
      .array(
        z
          .string()
          .max(PLUGIN_RECIPE_VARIABLE_NAME_MAX_LENGTH)
          .regex(PLUGIN_RECIPE_VARIABLE_NAME_PATTERN, {
            message:
              "variable names are lowercase letters, digits and underscores, starting with a letter",
          })
      )
      .max(MAX_PLUGIN_RECIPE_VARIABLES)
      .refine((names) => new Set(names).size === names.length, {
        message: "variables must not repeat a name",
      })
      .optional(),
    requiresAgentTools: z.boolean().optional(),
  })
  .strict();

/**
 * `contributes.worktreeSetupSteps` manifest entry (#13807). Declared here, not
 * at runtime, so the label and timeout the user allows are the ones that run:
 * the handler registers by id alone. Strict so unknown fields fail loudly.
 */
export const WorktreeSetupStepContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    label: z.string().trim().min(1).max(PLUGIN_WORKTREE_SETUP_STEP_LABEL_MAX),
    timeoutMs: z
      .number()
      .int()
      .min(PLUGIN_WORKTREE_SETUP_STEP_MIN_TIMEOUT_MS)
      .max(PLUGIN_WORKTREE_SETUP_STEP_MAX_TIMEOUT_MS)
      .optional(),
  })
  .strict();

/**
 * The URLs a `contributes.terminalLinks` entry claims (#13798). Host and path
 * rules that JSON Schema can't express — no IP, nothing loopback, private or
 * local-only — are applied by the manifest-level `superRefine`.
 */
export const TerminalLinkUrlSchema = z
  .object({
    scheme: z.enum(["https", "http"]).default("https"),
    host: z.string().min(1).max(TERMINAL_LINK_HOST_MAX_LENGTH),
    pathPrefix: z.string().min(1).max(TERMINAL_LINK_PATH_PREFIX_MAX_LENGTH).optional(),
  })
  .strict();

/**
 * `contributes.terminalLinks` manifest entry (#13798): terminal text a plugin
 * makes clickable, dispatching one of its own commands. Exactly one of
 * `pattern` or `url`; that rule, the pattern's safety rules and the action's
 * ownership are checked by the manifest-level `superRefine`. Declarative and
 * matched by the host on hover, so no capability is required. Strict so
 * unknown fields fail loudly.
 */
export const TerminalLinkContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    actionId: z.string().min(1).max(200),
    pattern: z.string().min(1).max(TERMINAL_LINK_PATTERN_MAX_LENGTH).optional(),
    ignoreCase: z.boolean().optional(),
    url: TerminalLinkUrlSchema.optional(),
  })
  .strict();
