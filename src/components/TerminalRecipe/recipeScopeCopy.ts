// Same vocabulary as a saved recipe's scope (RecipeEditor's savedScope), so the
// choice is legible before saving: "Project" is a tracked repo file.
export const PROJECT_SCOPE_LABEL = "Team (shared in the repository)";
export const GLOBAL_SCOPE_LABEL = "Global (this machine only)";

// Shared by the editor and the manager's Team section, so the two never describe
// the same file differently.
export const TEAM_SCOPE_DETAIL = "Saved in .daintree/recipes/ and shared with everyone on the repo";

export function newRecipeScopeDetail(scope: "global" | "project"): string {
  return scope === "global"
    ? "Stays on this machine and is available in every project"
    : `${TEAM_SCOPE_DETAIL}. It shows up in git status.`;
}
