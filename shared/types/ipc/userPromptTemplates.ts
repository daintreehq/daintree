import type { PromptTemplateContribution } from "../plugin.js";

/**
 * Something in the person's templates folder that was left out, and why.
 * `fileName` is null when the problem is with the folder rather than one file.
 */
export interface UserPromptTemplateProblem {
  fileName: string | null;
  reason: string;
}

/** The templates folder as it stood when it was read (#16398). */
export interface UserPromptTemplatesSnapshot {
  directory: string;
  /** In file name order; each `id` is the file's name without `.md`. */
  templates: PromptTemplateContribution[];
  problems: UserPromptTemplateProblem[];
}

/** Where the folder is, for a person the OS opener couldn't take there. */
export interface UserPromptTemplatesFolderResult {
  directory: string;
  opened: boolean;
}
