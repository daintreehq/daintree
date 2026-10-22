import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import { MAX_TERMINALS_PER_RECIPE } from "../../../shared/utils/recipeSanitizer.js";

function parseManifest(contributes: Record<string, unknown>, capabilities: string[] = []) {
  return getPluginManifestSchema("user").safeParse({
    name: "acme.recipes-test",
    version: "1.0.0",
    capabilities,
    contributes,
  });
}

const terminal = (overrides: Record<string, unknown> = {}) => ({
  type: "terminal",
  command: "npm run dev",
  ...overrides,
});

const recipe = (i: number, overrides: Record<string, unknown> = {}) => ({
  id: `recipe-${i}`,
  name: `Recipe ${i}`,
  terminals: [terminal()],
  ...overrides,
});

describe("contributes.recipes manifest shape (#11860)", () => {
  it("accepts a recipe contribution with no capability declared", () => {
    // Recipes follow the `skills` precedent: inert declarative content, so
    // requiring a capability would gate nothing an unsandboxed runtime enforces.
    // Contrast `agents`, which does require `agent:register`.
    const result = parseManifest({ recipes: [recipe(1)] });
    expect(result.success).toBe(true);
    const agentsWithoutCapability = parseManifest({
      agents: [{ id: "acme-agent", name: "Acme", command: "acme" }],
    });
    expect(agentsWithoutCapability.success).toBe(false);
  });

  it("rejects unknown fields on the contribution and on a terminal", () => {
    expect(parseManifest({ recipes: [recipe(1, { scope: "inrepo" })] }).success).toBe(false);
    expect(
      parseManifest({ recipes: [recipe(1, { terminals: [terminal({ location: "dock" })] })] })
        .success
    ).toBe(false);
  });

  it("rejects the transient per-launch fields a recipe editor strips on persist", () => {
    // agentModelId / agentLaunchFlags are session state — accepting them in a
    // manifest would advertise a field the registry silently drops.
    for (const field of ["agentModelId", "agentLaunchFlags"]) {
      const result = parseManifest({
        recipes: [recipe(1, { terminals: [terminal({ [field]: "x" })] })],
      });
      expect(result.success, field).toBe(false);
    }
  });

  it("requires at least one terminal and stops at the shared per-recipe cap", () => {
    expect(parseManifest({ recipes: [recipe(1, { terminals: [] })] }).success).toBe(false);
    const atCap = Array.from({ length: MAX_TERMINALS_PER_RECIPE }, () => terminal());
    expect(parseManifest({ recipes: [recipe(1, { terminals: atCap })] }).success).toBe(true);
    expect(
      parseManifest({ recipes: [recipe(1, { terminals: [...atCap, terminal()] })] }).success
    ).toBe(false);
  });

  it("rejects two recipes sharing an id within one manifest", () => {
    // A duplicate would first-wins silently in the registry's qualified-id map,
    // so the second contribution would vanish with no diagnostic.
    const result = parseManifest({ recipes: [recipe(1), recipe(1)] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((issue) => issue.path.join(".").startsWith("contributes.recipes"))
    ).toBe(true);
  });

  it("keeps the metadata defaults a plugin declares", () => {
    const result = parseManifest({
      recipes: [recipe(1, { showInEmptyState: true, autoAssign: "never" })],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const parsed = result.data.contributes.recipes[0]!;
    expect(parsed.showInEmptyState).toBe(true);
    expect(parsed.autoAssign).toBe("never");
    expect(parseManifest({ recipes: [recipe(1, { autoAssign: "sometimes" })] }).success).toBe(
      false
    );
  });

  it("accepts recipes from a project plugin (#13796)", () => {
    // The broadcaster narrows a recipe to its owning plugin's project, so a
    // project plugin's recipes no longer leak into every project's launcher.
    const result = getPluginManifestSchema("project").safeParse({
      name: "acme.recipes-test",
      version: "1.0.0",
      scope: "project",
      contributes: { recipes: [recipe(1, { showInEmptyState: true })] },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.contributes.recipes.map((r) => r.id)).toEqual(["recipe-1"]);
  });
});

describe("plugin panels, variables and agent tools in recipes (#13797)", () => {
  const panels = [
    { id: "records", name: "Records", iconId: "puzzle", color: "#ffffff" },
    { id: "shell", name: "Shell", iconId: "puzzle", color: "#ffffff", hasPty: true },
  ];

  function errorCodes(result: ReturnType<typeof parseManifest>): string[] {
    if (result.success) return [];
    return result.error.issues.map(
      (issue) => (issue as { params?: { errorCode?: string } }).params?.errorCode ?? "zod"
    );
  }

  const withRecipe = (overrides: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parseManifest({ panels, recipes: [recipe(1, overrides)], ...extra });

  it("accepts a panel beside an agent, with variables in both prompts", () => {
    const result = withRecipe({
      variables: ["record_id", "record_title"],
      terminals: [
        { type: "plugin-panel", panelId: "records", panelArgs: { recordId: "x" } },
        {
          type: "claude",
          initialPrompt: "Review {{plugin.record_title}} on {{branch_name}}",
          systemPrompt: "You are working on record {{plugin.record_id}}.",
        },
      ],
    });
    expect(errorCodes(result)).toEqual([]);
  });

  it("refuses a panel step naming a panel the plugin doesn't declare, or none", () => {
    expect(
      errorCodes(withRecipe({ terminals: [{ type: "plugin-panel", panelId: "nope" }] }))
    ).toContain("recipe_panel_unknown");
    expect(errorCodes(withRecipe({ terminals: [{ type: "plugin-panel" }] }))).toContain(
      "recipe_panel_unknown"
    );
  });

  it("refuses fields that one step kind would never use on another", () => {
    expect(
      errorCodes(
        withRecipe({
          terminals: [{ type: "plugin-panel", panelId: "records", command: "rm -rf /" }],
        })
      )
    ).toContain("recipe_panel_step_fields");
    expect(
      errorCodes(withRecipe({ terminals: [{ type: "terminal", panelId: "records" }] }))
    ).toContain("recipe_panel_step_fields");
    expect(
      errorCodes(withRecipe({ terminals: [{ type: "terminal", systemPrompt: "x" }] }))
    ).toContain("recipe_system_prompt_not_agent");
  });

  it("refuses panel args for a PTY-backed panel, which has no view to receive them", () => {
    expect(
      errorCodes(
        withRecipe({ terminals: [{ type: "plugin-panel", panelId: "shell", panelArgs: { a: 1 } }] })
      )
    ).toContain("recipe_panel_args_pty");
  });

  it("refuses a plugin variable the recipe doesn't declare", () => {
    expect(
      errorCodes(
        withRecipe({
          variables: ["record_id"],
          terminals: [{ type: "claude", initialPrompt: "Open {{plugin.record_title}}" }],
        })
      )
    ).toContain("recipe_variable_undeclared");
  });

  it("holds variable names to the prompt-template grammar, without repeats", () => {
    expect(withRecipe({ variables: ["Record-Id"] }).success).toBe(false);
    expect(withRecipe({ variables: ["a", "a"] }).success).toBe(false);
  });

  it("allows requiresAgentTools only for a plugin that offers tools, on a recipe with an agent", () => {
    expect(
      errorCodes(withRecipe({ requiresAgentTools: true, terminals: [{ type: "claude" }] }))
    ).toContain("recipe_requires_agent_tools_none");
    const withTools = (terminals: unknown[]) =>
      getPluginManifestSchema("user").safeParse({
        name: "acme.recipes-test",
        version: "1.0.0",
        capabilities: ["mcp:expose"],
        contributes: {
          agentMcp: [{ id: "data", name: "Ledger", mode: "tools" }],
          recipes: [recipe(1, { requiresAgentTools: true, terminals })],
        },
      });
    expect(errorCodes(withTools([{ type: "claude" }]))).toEqual([]);
    expect(errorCodes(withTools([{ type: "terminal", command: "ls" }]))).toContain(
      "recipe_requires_agent_tools_no_agent"
    );
  });
});
