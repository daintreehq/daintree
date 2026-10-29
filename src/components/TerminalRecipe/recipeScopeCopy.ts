// Same vocabulary as a saved recipe's scope (RecipeEditor's savedScope), so the
// choice is legible before saving: "Project" is a tracked repo file.
export const PROJECT_SCOPE_LABEL = "Team (shared in the repository)";
export const GLOBAL_SCOPE_LABEL = "Global (this machine only)";

export function newRecipeScopeDetail(scope: "global" | "project"): string {
  return scope === "global"
    ? "Stays on this machine and is available in every project"
    : "Saved in .daintree/recipes/ and shared with everyone on the repo. It shows up in git status.";
}
