/**
 * Content-validation for recipe terminals at trust boundaries.
 *
 * Both the user-import path (`recipeStore.importRecipe`) and the in-repo load
 * path (`ProjectIdentityFiles.readInRepoRecipesWithHashes`) feed terminal
 * definitions into the spawn path, where `command`/`args`/`devCommand`/`env`
 * are forwarded verbatim to node-pty. A `type` outside the known set, or a
 * control character in any of those fields, can inject shell commands or
 * manipulate the terminal — so every terminal is validated here before it can
 * reach `addPanel`. Invalid terminals are dropped individually; the caller
 * decides what to do with a recipe left with zero valid terminals, and a
 * caller with a user to tell can ask `inspectRecipeTerminals` which were
 * dropped and why.
 */
import { BUILT_IN_AGENT_IDS } from "../config/agentIds.js";
import { isAgentRecipeType } from "../types/project.js";
import type { RecipeTerminal, RecipeTerminalType } from "../types/project.js";

/**
 * Maximum number of terminals a single recipe may spawn. Enforced at every
 * recipe trust boundary (user import and in-repo load) so no recipe can open an
 * unbounded burst of panels.
 */
export const MAX_TERMINALS_PER_RECIPE = 10;

/** Maximum PTY count admitted as one user-confirmed recipe batch across worktrees. */
export const MAX_TERMINALS_PER_RECIPE_ADMISSION_BATCH = 30;

/**
 * Control characters forbidden in command-like fields (`command`, `args`,
 * `devCommand`, and `env` keys/values). Rejects CR, LF, and all C0 control
 * chars — any of which could break out of an argument or drive the terminal
 * when forwarded to the shell.
 */
// eslint-disable-next-line no-control-regex
export const RECIPE_CONTROL_CHARS = /[\r\n\x00-\x1F]/;

/**
 * Looser set for `initialPrompt`: newlines are legitimate inside a prompt, so
 * `\r`/`\n` are allowed while the remaining C0 chars and DEL are rejected.
 */
// eslint-disable-next-line no-control-regex
export const RECIPE_PROMPT_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

const ALLOWED_RECIPE_TYPES: ReadonlySet<string> = new Set<string>([
  "terminal",
  "dev-preview",
  ...BUILT_IN_AGENT_IDS,
]);

/**
 * Extra terminal types a specific trust boundary admits on top of
 * {@link ALLOWED_RECIPE_TYPES}. Only the plugin-recipe registration path passes
 * one, and only with agent ids the SAME plugin effectively owns — otherwise a
 * plugin shipping both an agent and a recipe that launches it would have every
 * such terminal silently dropped (#11860).
 *
 * Deliberately an explicit argument rather than a live registry read: the
 * in-repo and import boundaries run at times when the plugin agent registry may
 * be empty or half-populated, and a set that changes under them would make the
 * same file sanitize differently depending on startup ordering.
 */
export interface RecipeSanitizeOptions {
  additionalAllowedTypes?: ReadonlySet<string>;
  /**
   * Runtime panel kinds a `plugin-panel` step may open (#13797). Only the
   * plugin-recipe boundary passes it, with the SAME plugin's own kinds; every
   * other boundary drops `plugin-panel` steps, so a user-owned file can never
   * open a plugin's panel.
   */
  pluginPanelKinds?: ReadonlySet<string>;
  /** Keep an agent step's `systemPrompt`. Plugin-recipe boundary only (#13797). */
  allowSystemPrompt?: boolean;
}

/** Largest `panelArgs` a `plugin-panel` step may carry, as JSON — a launch entry's own cap. */
export const RECIPE_PANEL_ARGS_MAX_BYTES = 8192;

/**
 * Whether `type` is admissible at this trust boundary. Exported so the
 * forward-compatibility detector in `recipeCompatibility.ts` can ask the same
 * question without duplicating the allowlist — the two must never disagree
 * about which terminals this build can represent (#12261).
 */
export function isAllowedRecipeType(type: string, options?: RecipeSanitizeOptions): boolean {
  if (type === "plugin-panel") return (options?.pluginPanelKinds?.size ?? 0) > 0;
  return ALLOWED_RECIPE_TYPES.has(type) || options?.additionalAllowedTypes?.has(type) === true;
}

/** A fresh JSON-only copy of a `plugin-panel` step's arguments, or null when they aren't plain JSON within the cap. */
function copyPanelArgs(raw: unknown): Record<string, unknown> | null {
  if (!isPlainObject(raw)) return null;
  let json: string;
  try {
    json = JSON.stringify(raw);
  } catch {
    return null;
  }
  if (new TextEncoder().encode(json).length > RECIPE_PANEL_ARGS_MAX_BYTES) return null;
  const copy: unknown = JSON.parse(json);
  return isPlainObject(copy) ? copy : null;
}

// "restart" is QuickRun-only and never a valid recipe exit behavior (the recipe
// editor normalizes it away), so it is intentionally excluded here.
const ALLOWED_EXIT_BEHAVIORS: ReadonlySet<string> = new Set<string>(["keep", "trash", "remove"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A terminal field the sanitizer can reject a whole terminal over. */
export type RecipeTerminalField =
  | "command"
  | "initialPrompt"
  | "systemPrompt"
  | "args"
  | "devCommand"
  | "env"
  | "exitBehavior"
  | "panelKindId"
  | "panelArgs";

/**
 * Why the sanitizer dropped one terminal. Describes shape only (the field and,
 * for an unknown type, the type string) and never a field's value, which may be
 * the very control-char payload that got it rejected.
 */
export type RecipeTerminalRejection =
  | { kind: "not-an-object" }
  | { kind: "missing-type" }
  | { kind: "unsupported-type"; type: string }
  /** Not the shape the field holds: text, or for `env` an object of text values. */
  | { kind: "wrong-shape"; field: RecipeTerminalField }
  | { kind: "control-char"; field: RecipeTerminalField }
  | { kind: "unsupported-value"; field: RecipeTerminalField };

type TerminalCheck =
  | { terminal: RecipeTerminal; rejection?: undefined }
  | { terminal?: undefined; rejection: RecipeTerminalRejection };

const reject = (rejection: RecipeTerminalRejection): TerminalCheck => ({ rejection });

/** String fields checked in this order, each against the control chars it may not hold. */
const TEXT_FIELDS: readonly (readonly [RecipeTerminalField, RegExp])[] = [
  ["command", RECIPE_CONTROL_CHARS],
  ["initialPrompt", RECIPE_PROMPT_CONTROL_CHARS],
  ["systemPrompt", RECIPE_PROMPT_CONTROL_CHARS],
  ["args", RECIPE_CONTROL_CHARS],
  ["devCommand", RECIPE_CONTROL_CHARS],
];

/**
 * Validates a single raw terminal and maps it to a clean {@link RecipeTerminal}
 * with only known fields, or says which content check it failed.
 */
function checkRecipeTerminal(raw: unknown, options?: RecipeSanitizeOptions): TerminalCheck {
  if (!isPlainObject(raw)) return reject({ kind: "not-an-object" });

  const type = raw.type;
  if (typeof type !== "string") return reject({ kind: "missing-type" });
  if (!isAllowedRecipeType(type, options)) {
    return reject(type === "" ? { kind: "missing-type" } : { kind: "unsupported-type", type });
  }

  if (type === "plugin-panel") {
    const kind = raw.panelKindId;
    if (typeof kind !== "string") return reject({ kind: "wrong-shape", field: "panelKindId" });
    if (options?.pluginPanelKinds?.has(kind) !== true) {
      return reject({ kind: "unsupported-value", field: "panelKindId" });
    }
    let panelArgs: Record<string, unknown> | undefined;
    if (raw.panelArgs !== undefined) {
      const copied = copyPanelArgs(raw.panelArgs);
      if (copied === null) return reject({ kind: "unsupported-value", field: "panelArgs" });
      panelArgs = copied;
    }
    return {
      terminal: {
        type: "plugin-panel",
        title: typeof raw.title === "string" ? raw.title : undefined,
        panelKindId: kind,
        ...(panelArgs !== undefined ? { panelArgs } : {}),
      },
    };
  }

  for (const [field, forbidden] of TEXT_FIELDS) {
    if (field === "systemPrompt" && options?.allowSystemPrompt !== true) continue;
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return reject({ kind: "wrong-shape", field });
    if (forbidden.test(value)) return reject({ kind: "control-char", field });
  }

  let env: Record<string, string> | undefined;
  if (raw.env !== undefined) {
    if (!isPlainObject(raw.env)) return reject({ kind: "wrong-shape", field: "env" });
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value !== "string") return reject({ kind: "wrong-shape", field: "env" });
      if (RECIPE_CONTROL_CHARS.test(key) || RECIPE_CONTROL_CHARS.test(value)) {
        return reject({ kind: "control-char", field: "env" });
      }
      cleaned[key] = value;
    }
    env = cleaned;
  }

  if (
    raw.exitBehavior !== undefined &&
    typeof raw.exitBehavior === "string" &&
    raw.exitBehavior !== "" &&
    !ALLOWED_EXIT_BEHAVIORS.has(raw.exitBehavior)
  ) {
    return reject({ kind: "unsupported-value", field: "exitBehavior" });
  }

  const recipeType = type as RecipeTerminalType;
  const isAgent = isAgentRecipeType(recipeType);
  const systemPrompt =
    isAgent && options?.allowSystemPrompt === true && typeof raw.systemPrompt === "string"
      ? raw.systemPrompt.trim() || undefined
      : undefined;

  return {
    terminal: {
      type: recipeType,
      title: typeof raw.title === "string" ? raw.title : undefined,
      command:
        recipeType === "terminal" && typeof raw.command === "string"
          ? raw.command.trim() || undefined
          : undefined,
      env,
      initialPrompt:
        isAgent && typeof raw.initialPrompt === "string"
          ? raw.initialPrompt.replace(/\r\n/g, "\n").trimEnd()
          : undefined,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      devCommand:
        recipeType === "dev-preview" && typeof raw.devCommand === "string"
          ? raw.devCommand.trim() || undefined
          : undefined,
      args: isAgent && typeof raw.args === "string" ? raw.args.trim() || undefined : undefined,
      exitBehavior:
        typeof raw.exitBehavior === "string" && ALLOWED_EXIT_BEHAVIORS.has(raw.exitBehavior)
          ? (raw.exitBehavior as "keep" | "trash" | "remove")
          : undefined,
    },
  };
}

/** One terminal the sanitizer dropped, by its position in the input array. */
export interface RejectedRecipeTerminal {
  index: number;
  /** The entry's own `title`, when it had a string one. Unvalidated input. */
  title?: string;
  rejection: RecipeTerminalRejection;
}

export interface RecipeTerminalInspection {
  accepted: RecipeTerminal[];
  rejected: RejectedRecipeTerminal[];
}

/**
 * The same validation as {@link sanitizeRecipeTerminals}, keeping a record of
 * every terminal it drops and why, for a boundary that has a user to tell.
 */
export function inspectRecipeTerminals(
  terminals: unknown,
  options?: RecipeSanitizeOptions
): RecipeTerminalInspection {
  const accepted: RecipeTerminal[] = [];
  const rejected: RejectedRecipeTerminal[] = [];
  if (!Array.isArray(terminals)) return { accepted, rejected };
  terminals.forEach((raw, index) => {
    const check = checkRecipeTerminal(raw, options);
    if (check.terminal) {
      accepted.push(check.terminal);
      return;
    }
    const title = isPlainObject(raw) && typeof raw.title === "string" ? raw.title : undefined;
    rejected.push({ index, ...(title !== undefined ? { title } : {}), rejection: check.rejection });
  });
  return { accepted, rejected };
}

/**
 * Content-validates an array of raw recipe terminals, returning only the valid
 * ones mapped to clean {@link RecipeTerminal} objects (known fields only — no
 * passthrough). Invalid terminals are dropped silently; the caller is
 * responsible for handling a now-empty result.
 */
export function sanitizeRecipeTerminals(
  terminals: unknown,
  options?: RecipeSanitizeOptions
): RecipeTerminal[] {
  return inspectRecipeTerminals(terminals, options).accepted;
}
