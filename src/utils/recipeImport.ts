import { displaySafeText } from "@shared/utils/displaySafeText";
import { pluralize } from "@/lib/pluralize";
import {
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

/** What a file import came to; a refused one keeps its JSON so it can be fixed. */
export type RecipeFileImportResult =
  | { status: "cancelled" }
  | { status: "imported" }
  | { status: "refused"; json: string; error: unknown };

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
