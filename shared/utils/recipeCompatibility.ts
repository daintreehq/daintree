/**
 * Forward-compatibility detection for in-repo recipe files (#12261).
 *
 * `.daintree/recipes/*.json` is git-tracked and shared across machines that may
 * run different Daintree builds. The read path in
 * `ProjectIdentityFiles.readInRepoRecipesWithHashes` rebuilds every recipe from
 * an explicit field list and drops terminals whose `type` this build does not
 * know — deliberately, since those files are untrusted input (#9160). The write
 * path then serializes that reduced in-memory recipe straight back over the
 * file, so an older build silently deletes whatever a newer one wrote, and the
 * staleness guard cannot see it: the cached hash is taken from the *original*
 * bytes, which have not changed.
 *
 * This module names what the reduction would destroy, so the read path can warn
 * with specifics and the write paths can refuse. It deliberately does NOT call
 * the sanitizer: a terminal rejected for a control-char command is a security
 * drop, not version skew, and folding it in here would both mislabel an attack
 * and let a crafted file permanently block saves.
 */
import type { RecipeTerminal, TerminalRecipe } from "../types/project.js";
import { isAllowedRecipeType, type RecipeSanitizeOptions } from "./recipeSanitizer.js";

/**
 * Every field this build knows on a `RecipeTerminal`, including the three that
 * are *intentionally* absent from disk (`agentModelId`, `agentLaunchFlags`,
 * `location` are transient and stripped before persistence). They must count as
 * known: a file that happens to carry one is ordinary data this build
 * understands, not something a newer build invented (#9654).
 *
 * `satisfies Record<keyof T, true>` is what makes this safe to rely on — adding
 * a field to either interface without listing it here is a compile error, so
 * the reference set cannot silently drift out of date and start reporting our
 * own new fields as foreign.
 */
const KNOWN_TERMINAL_FIELDS = {
  type: true,
  title: true,
  command: true,
  env: true,
  initialPrompt: true,
  args: true,
  devCommand: true,
  exitBehavior: true,
  agentModelId: true,
  agentLaunchFlags: true,
  location: true,
} satisfies Record<keyof RecipeTerminal, true>;

const KNOWN_RECIPE_FIELDS = {
  id: true,
  name: true,
  projectId: true,
  worktreeId: true,
  terminals: true,
  createdAt: true,
  showInEmptyState: true,
  lastUsedAt: true,
  usageHistory: true,
  autoAssign: true,
  shadowedBy: true,
  scope: true,
  origin: true,
} satisfies Record<keyof TerminalRecipe, true>;

const KNOWN_TERMINAL_KEYS: ReadonlySet<string> = new Set(Object.keys(KNOWN_TERMINAL_FIELDS));
const KNOWN_RECIPE_KEYS: ReadonlySet<string> = new Set(Object.keys(KNOWN_RECIPE_FIELDS));

/** A terminal this build cannot represent, identified by its position on disk. */
export interface UnsupportedTerminal {
  /** Index into the file's original `terminals` array, before any filtering. */
  index: number;
  /** The unrecognized `type` string, reported verbatim so the user can place it. */
  type: string;
}

/** Unknown keys found on one terminal, by its position on disk. */
export interface UnsupportedTerminalKeys {
  index: number;
  keys: string[];
}

/**
 * What re-serializing a recipe read by this build would delete from its file.
 * Only ever describes *shape* — key names and the foreign `type` string. Values,
 * commands, prompts and env contents are never captured, so this can be logged
 * and put in front of the user without leaking anything the file holds.
 */
export interface RecipeForwardIncompat {
  /** Top-level recipe keys this build does not know. */
  unknownRecipeKeys: string[];
  /** Unknown keys per terminal, keyed by original index. */
  unknownTerminalKeys: UnsupportedTerminalKeys[];
  /** Terminals whose `type` is well-formed but unknown, so the whole entry drops. */
  unsupportedTerminals: UnsupportedTerminal[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeysOf(value: Record<string, unknown>, known: ReadonlySet<string>): string[] {
  // Sorted so warnings and error copy are stable across runs — `Object.keys`
  // order follows insertion order in the parsed JSON, which varies by file.
  return Object.keys(value)
    .filter((key) => !known.has(key))
    .sort();
}

/**
 * Inspects a recipe parsed by the passthrough schema (so unknown keys are still
 * attached) and reports what this build would drop. Returns `null` when nothing
 * would be lost, which is the overwhelmingly common case — callers can treat a
 * non-null result as "this file was written by something this build does not
 * fully understand".
 *
 * Pass the same {@link RecipeSanitizeOptions} the matching sanitize call uses,
 * or the two will disagree about which terminal types are admissible.
 */
export function detectRecipeForwardIncompat(
  parsed: unknown,
  options?: RecipeSanitizeOptions
): RecipeForwardIncompat | null {
  if (!isPlainObject(parsed)) return null;

  const unknownRecipeKeys = unknownKeysOf(parsed, KNOWN_RECIPE_KEYS);
  const unknownTerminalKeys: UnsupportedTerminalKeys[] = [];
  const unsupportedTerminals: UnsupportedTerminal[] = [];

  if (Array.isArray(parsed.terminals)) {
    parsed.terminals.forEach((raw, index) => {
      if (!isPlainObject(raw)) return;
      const keys = unknownKeysOf(raw, KNOWN_TERMINAL_KEYS);
      if (keys.length > 0) unknownTerminalKeys.push({ index, keys });
      // Only a *well-formed* type that this build doesn't know counts. A missing
      // or non-string type is malformed input, not a newer schema.
      const type = raw.type;
      if (typeof type === "string" && type !== "" && !isAllowedRecipeType(type, options)) {
        unsupportedTerminals.push({ index, type });
      }
    });
  }

  if (
    unknownRecipeKeys.length === 0 &&
    unknownTerminalKeys.length === 0 &&
    unsupportedTerminals.length === 0
  ) {
    return null;
  }
  return { unknownRecipeKeys, unknownTerminalKeys, unsupportedTerminals };
}

/**
 * One-line, user-facing summary of what a save would delete. Terminal positions
 * are rendered 1-based because they are pointing the user at entries in a file
 * they may go and open.
 */
export function describeRecipeForwardIncompat(loss: RecipeForwardIncompat): string {
  const parts: string[] = [];
  if (loss.unsupportedTerminals.length > 0) {
    const described = loss.unsupportedTerminals
      .map((t) => `#${t.index + 1} (type "${t.type}")`)
      .join(", ");
    parts.push(
      `${loss.unsupportedTerminals.length === 1 ? "terminal" : "terminals"} ${described}`
    );
  }
  if (loss.unknownTerminalKeys.length > 0) {
    const described = loss.unknownTerminalKeys
      .map((t) => `#${t.index + 1}: ${t.keys.join(", ")}`)
      .join("; ");
    parts.push(`unknown terminal fields — ${described}`);
  }
  if (loss.unknownRecipeKeys.length > 0) {
    parts.push(`unknown recipe fields — ${loss.unknownRecipeKeys.join(", ")}`);
  }
  return parts.join("; ");
}
