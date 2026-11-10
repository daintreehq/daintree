import type { RecipeTerminal, TerminalRecipe } from "@shared/types";
import { displaySafeText } from "@shared/utils/displaySafeText";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { pluralize } from "@/lib/pluralize";
import { importedRecipeUsesPluginOnlyFeatures } from "@/utils/pluginRecipeCopy";
import {
  inspectRecipeTerminals,
  MAX_TERMINALS_PER_RECIPE,
  RECIPE_PANEL_ARGS_MAX_BYTES,
  type RecipeTerminalRejection,
  type RejectedRecipeTerminal,
} from "@shared/utils/recipeSanitizer";

/**
 * Thrown by `importRecipe` when the sanitizer would drop terminals the file
 * describes, so nothing is saved until the user has seen which and why (#15044).
 * Carries positions and reasons only, never the JSON or a rejected value.
 */
export class RecipeImportDropsTerminalsError extends Error {
  readonly acceptedCount: number;
  readonly rejected: readonly RejectedRecipeTerminal[];

  constructor(acceptedCount: number, rejected: readonly RejectedRecipeTerminal[]) {
    super(
      acceptedCount === 0
        ? "None of the recipe's terminals can be imported"
        : `${pluralize(rejected.length, "terminal")} can't be imported`
    );
    this.name = "RecipeImportDropsTerminalsError";
    this.acceptedCount = acceptedCount;
    this.rejected = rejected;
  }
}

export function isRecipeImportDropsTerminalsError(
  error: unknown
): error is RecipeImportDropsTerminalsError {
  return error instanceof RecipeImportDropsTerminalsError;
}

/**
 * Thrown by `importRecipe` when the JSON can't become a recipe at all. Its own
 * kind so a dialog can tell content the user has to change from a save that
 * failed and may work if tried again.
 */
export class RecipeImportInvalidError extends Error {
  readonly title: string;
  readonly detail: string;

  constructor(title: string, detail: string) {
    super(`${title}. ${detail}`);
    this.name = "RecipeImportInvalidError";
    this.title = title;
    this.detail = detail;
  }
}

export function isRecipeImportInvalidError(error: unknown): error is RecipeImportInvalidError {
  return error instanceof RecipeImportInvalidError;
}

/** What an import would save, from the same validation the save runs. */
export interface RecipeImportPreview {
  name: string;
  terminals: RecipeTerminal[];
}

/**
 * A recipe file read for import. Nothing has been saved: the user still picks
 * where it goes. A refused one keeps its JSON so it can be fixed.
 */
export type RecipeFileRead =
  | { status: "cancelled" }
  | { status: "ready"; fileName: string; json: string; recipe: RecipeImportPreview }
  | { status: "refused"; fileName: string; json: string; error: unknown };

/** A file the import dialog opens on: one to confirm, or one to fix. */
export type RecipeFileImport = Exclude<RecipeFileRead, { status: "cancelled" }>;

/**
 * Everything an import checks before it saves, run alone so a recipe can be
 * shown as it would be saved before the user has chosen where it goes.
 */
export function prepareRecipeImport(
  json: string,
  options?: { allowDroppedTerminals?: boolean }
): { recipe: Partial<TerminalRecipe>; preview: RecipeImportPreview } {
  let recipe: Partial<TerminalRecipe>;
  try {
    recipe = JSON.parse(json);
  } catch (error) {
    throw new RecipeImportInvalidError(
      "That isn't valid JSON",
      formatErrorMessage(error, "parse failed")
    );
  }

  if (!recipe || !recipe.name || !recipe.terminals || !Array.isArray(recipe.terminals)) {
    throw new RecipeImportInvalidError(
      "This JSON isn't a recipe",
      "A recipe needs a name and a list of terminals."
    );
  }

  if (recipe.terminals.length === 0) {
    throw new RecipeImportInvalidError(
      "This recipe has no terminals",
      "Add at least one terminal, then import it again."
    );
  }
  if (recipe.terminals.length > MAX_TERMINALS_PER_RECIPE) {
    throw new RecipeImportInvalidError(
      "This recipe has too many terminals",
      `A recipe can launch up to ${MAX_TERMINALS_PER_RECIPE}, and this one lists ${recipe.terminals.length}.`
    );
  }
  // An exported plugin recipe would import as a copy that quietly does less:
  // the sanitizer below drops its panel steps and system prompts (#13797).
  if (importedRecipeUsesPluginOnlyFeatures(recipe)) {
    throw new RecipeImportInvalidError(
      "This recipe only works in its plugin",
      `"${String(recipe.name)}" opens a plugin's panels, uses its variables or needs its agent tools, which only work in the plugin's own recipe, so it can't be imported.`
    );
  }

  // Content-validate at the import trust boundary. Shared with the in-repo
  // load path (ProjectIdentityFiles.readInRepoRecipesWithHashes) so both
  // entry points apply the same type allowlist, control-char filtering, and
  // explicit field mapping before a terminal can reach the spawn path. A
  // recipe that would lose a terminal is a weaker copy, so it is saved only
  // once the user has seen what goes (#15044).
  const { accepted, rejected } = inspectRecipeTerminals(recipe.terminals);
  if (accepted.length === 0 || (rejected.length > 0 && options?.allowDroppedTerminals !== true)) {
    throw new RecipeImportDropsTerminalsError(accepted.length, rejected);
  }

  return { recipe, preview: { name: String(recipe.name), terminals: accepted } };
}

/**
 * What importing `json` would save, or `null` when it would be refused. With
 * `allowDroppedTerminals`, what "import the rest" keeps.
 */
export function previewRecipeImport(
  json: string,
  options?: { allowDroppedTerminals?: boolean }
): RecipeImportPreview | null {
  try {
    return prepareRecipeImport(json, options).preview;
  } catch {
    return null;
  }
}

const MAX_LABEL_CHARS = 60;

/** A title or type string from the file, made safe and short enough for one line. */
function displayLabel(text: string): string {
  const flat = displaySafeText(text).replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > MAX_LABEL_CHARS ? `${chars.slice(0, MAX_LABEL_CHARS).join("")}…` : flat;
}

function describeRejection(rejection: RecipeTerminalRejection): string {
  switch (rejection.kind) {
    case "not-an-object":
      return "isn't a JSON object";
    case "missing-type":
      return 'has no "type"';
    case "unsupported-type":
      return `this version of Daintree can't launch type "${displayLabel(rejection.type)}"`;
    case "wrong-shape":
      return rejection.field === "env"
        ? '"env" must map names to text values'
        : `"${rejection.field}" must be text`;
    case "control-char":
      return rejection.field === "env"
        ? '"env" has a control character in a name or value'
        : `"${rejection.field}" contains a control character`;
    case "unsupported-value":
      switch (rejection.field) {
        case "exitBehavior":
          return '"exitBehavior" must be keep, trash or remove';
        case "whenDone":
          return '"whenDone" must be keep, background or close';
        case "panelArgs":
          return `"panelArgs" must be a JSON object under ${RECIPE_PANEL_ARGS_MAX_BYTES / 1024} KB`;
        case "panelKindId":
          return '"panelKindId" names a panel this recipe can\'t open';
        default:
          return `"${rejection.field}" has a value this version of Daintree doesn't accept`;
      }
  }
}

/**
 * One dropped terminal as the user should see it: its 1-based position, since
 * that is how they find it in the JSON, its title when it has one, and why.
 */
export function describeRejectedTerminal(terminal: RejectedRecipeTerminal): {
  label: string;
  reason: string;
} {
  const title = terminal.title === undefined ? "" : displayLabel(terminal.title);
  const position = `Terminal ${terminal.index + 1}`;
  return {
    label: title ? `${position} · ${title}` : position,
    reason: describeRejection(terminal.rejection),
  };
}
