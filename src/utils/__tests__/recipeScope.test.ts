import { describe, it, expect, vi } from "vitest";
import { getRecipeScope } from "../recipeScope";
import type { TerminalRecipe } from "@/types";

function makeRecipe(overrides: Partial<TerminalRecipe> = {}): TerminalRecipe {
  return {
    id: "recipe-1",
    name: "Work",
    terminals: [],
    ...overrides,
  } as TerminalRecipe;
}

describe("getRecipeScope", () => {
  it("classifies a recipe with no projectId as global", () => {
    const scope = getRecipeScope(makeRecipe({ projectId: undefined }));
    expect(scope).toEqual({ label: "Global", isGlobal: true });
  });

  it("classifies a project-scoped recipe without a worktree as project-wide", () => {
    const scope = getRecipeScope(makeRecipe({ projectId: "proj-1" }));
    expect(scope).toEqual({ label: "Project-wide", isGlobal: false });
  });

  it("classifies an in-repo recipe as team, whichever way it is marked", () => {
    const byScopeField = getRecipeScope(makeRecipe({ projectId: "proj-1", scope: "inrepo" }));
    const byLegacyIdPrefix = getRecipeScope(makeRecipe({ id: "inrepo-work", projectId: "proj-1" }));
    expect(byScopeField.label).toBe("Team");
    expect(byLegacyIdPrefix.label).toBe("Team");
  });

  it("treats in-repo as team even when the recipe carries no projectId", () => {
    // ProjectFileStore mirrors can arrive without a projectId; the in-repo check
    // has to win over the global check or a Team recipe reads as Global.
    const scope = getRecipeScope(makeRecipe({ projectId: undefined, scope: "inrepo" }));
    expect(scope).toEqual({ label: "Team", isGlobal: false });
  });

  it("names the worktree when a resolver supplies one", () => {
    const scope = getRecipeScope(makeRecipe({ projectId: "proj-1", worktreeId: "wt-1" }), (id) =>
      id === "wt-1" ? "feature/login" : undefined
    );
    expect(scope.label).toBe("Worktree: feature/login");
  });

  it("falls back to a bare worktree label rather than printing a raw id", () => {
    const withoutResolver = getRecipeScope(makeRecipe({ projectId: "p", worktreeId: "wt-abc123" }));
    const unresolved = getRecipeScope(
      makeRecipe({ projectId: "p", worktreeId: "wt-abc123" }),
      () => undefined
    );
    expect(withoutResolver.label).toBe("Worktree");
    expect(unresolved.label).toBe("Worktree");
  });

  it("does not consult the resolver for non-worktree scopes", () => {
    const resolve = vi.fn<(id: string) => string | undefined>(() => "unused");
    getRecipeScope(makeRecipe({ projectId: undefined }), resolve);
    getRecipeScope(makeRecipe({ projectId: "proj-1" }), resolve);
    getRecipeScope(makeRecipe({ projectId: "proj-1", scope: "inrepo" }), resolve);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("marks only the global scope as global", () => {
    const recipes = [
      makeRecipe({ projectId: undefined }),
      makeRecipe({ projectId: "p" }),
      makeRecipe({ projectId: "p", scope: "inrepo" }),
      makeRecipe({ projectId: "p", worktreeId: "wt-1" }),
    ];
    expect(recipes.map((r) => getRecipeScope(r).isGlobal)).toEqual([true, false, false, false]);
  });

  it("distinguishes same-named recipes that differ only by scope", () => {
    const global = makeRecipe({ id: "g", name: "Work", projectId: undefined });
    const local = makeRecipe({ id: "l", name: "Work", projectId: "proj-1" });
    expect(getRecipeScope(global).label).not.toBe(getRecipeScope(local).label);
  });

  it("classifies a plugin recipe by provenance, not by its missing projectId (#11860)", () => {
    // A plugin recipe carries no projectId either, so the global branch would
    // claim it and label a read-only recipe as one the user can edit.
    const plugin = makeRecipe({
      projectId: undefined,
      origin: { kind: "plugin", pluginId: "acme.tools", contributionId: "deploy" },
    });
    const global = makeRecipe({ projectId: undefined });
    expect(getRecipeScope(plugin).label).not.toBe(getRecipeScope(global).label);
    // Still globally available — the axis it shares with global recipes.
    expect(getRecipeScope(plugin).isGlobal).toBe(true);
  });

  it("plugin provenance wins even when the recipe also looks in-repo", () => {
    const plugin = makeRecipe({
      projectId: "p",
      scope: "inrepo",
      origin: { kind: "plugin", pluginId: "acme.tools", contributionId: "deploy" },
    });
    expect(getRecipeScope(plugin).label).toBe(
      getRecipeScope(
        makeRecipe({
          origin: { kind: "plugin", pluginId: "acme.tools", contributionId: "deploy" },
        })
      ).label
    );
  });
});
