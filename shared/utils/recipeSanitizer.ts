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
 * decides what to do with a recipe left with zero valid terminals.
 */
import { BUILT_IN_AGENT_IDS } from "../config/agentIds.js";
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

// "restart" is QuickRun-only and never a valid recipe exit behavior (the recipe
// editor normalizes it away), so it is intentionally excluded here.
const ALLOWED_EXIT_BEHAVIORS: ReadonlySet<string> = new Set<string>(["keep", "trash", "remove"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a single raw terminal and maps it to a clean {@link RecipeTerminal}
 * with only known fields, or returns `null` if it fails any content check.
 */
function sanitizeRecipeTerminal(raw: unknown): RecipeTerminal | null {
  if (!isPlainObject(raw)) return null;

  const type = raw.type;
  if (typeof type !== "string" || !ALLOWED_RECIPE_TYPES.has(type)) return null;

  if (raw.command !== undefined) {
    if (typeof raw.command !== "string") return null;
    if (RECIPE_CONTROL_CHARS.test(raw.command)) return null;
  }
  if (raw.initialPrompt !== undefined) {
    if (typeof raw.initialPrompt !== "string") return null;
    if (RECIPE_PROMPT_CONTROL_CHARS.test(raw.initialPrompt)) return null;
  }
  if (raw.args !== undefined) {
    if (typeof raw.args !== "string") return null;
    if (RECIPE_CONTROL_CHARS.test(raw.args)) return null;
  }
  if (raw.devCommand !== undefined) {
    if (typeof raw.devCommand !== "string") return null;
    if (RECIPE_CONTROL_CHARS.test(raw.devCommand)) return null;
  }

  let env: Record<string, string> | undefined;
  if (raw.env !== undefined) {
    if (!isPlainObject(raw.env)) return null;
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value !== "string") return null;
      if (RECIPE_CONTROL_CHARS.test(key) || RECIPE_CONTROL_CHARS.test(value)) return null;
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
    return null;
  }

  const recipeType = type as RecipeTerminalType;
  const isAgent = recipeType !== "terminal" && recipeType !== "dev-preview";

  return {
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
    devCommand:
      recipeType === "dev-preview" && typeof raw.devCommand === "string"
        ? raw.devCommand.trim() || undefined
        : undefined,
    args: isAgent && typeof raw.args === "string" ? raw.args.trim() || undefined : undefined,
    exitBehavior:
      typeof raw.exitBehavior === "string" && ALLOWED_EXIT_BEHAVIORS.has(raw.exitBehavior)
        ? (raw.exitBehavior as "keep" | "trash" | "remove")
        : undefined,
  };
}

/**
 * Content-validates an array of raw recipe terminals, returning only the valid
 * ones mapped to clean {@link RecipeTerminal} objects (known fields only — no
 * passthrough). Invalid terminals are dropped silently; the caller is
 * responsible for handling a now-empty result.
 */
export function sanitizeRecipeTerminals(terminals: unknown): RecipeTerminal[] {
  if (!Array.isArray(terminals)) return [];
  const result: RecipeTerminal[] = [];
  for (const raw of terminals) {
    const sanitized = sanitizeRecipeTerminal(raw);
    if (sanitized) result.push(sanitized);
  }
  return result;
}
