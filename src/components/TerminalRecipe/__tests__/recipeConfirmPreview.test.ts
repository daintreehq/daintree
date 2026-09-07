import { describe, expect, it } from "vitest";
import { formatRecipePreviewLines, recipeOriginLabel } from "../recipeConfirmPreview";
import type { TerminalRecipe } from "@shared/types";

const recipe = (overrides: Partial<TerminalRecipe> = {}): TerminalRecipe => ({
  id: "r1",
  name: "Deploy stack",
  terminals: [{ type: "terminal", command: "npm run dev" }],
  createdAt: 0,
  ...overrides,
});

describe("recipeOriginLabel (#11860)", () => {
  it("reports plugin provenance ahead of the global inference", () => {
    // A plugin recipe carries no projectId either, so provenance has to win or
    // it would be labelled as one the user owns.
    const label = recipeOriginLabel(
      recipe({ origin: { kind: "plugin", pluginId: "acme.tools", contributionId: "deploy" } })
    );
    expect(label).toContain("acme.tools");
    expect(label).not.toContain("global");
  });

  it("distinguishes the three user tiers", () => {
    expect(recipeOriginLabel(recipe())).toContain("global");
    expect(recipeOriginLabel(recipe({ projectId: "p1" }))).toContain("project");
    expect(recipeOriginLabel(recipe({ projectId: "p1", scope: "inrepo" }))).toContain("team");
  });
});

describe("formatRecipePreviewLines (#11860)", () => {
  it("prints each terminal's command verbatim", () => {
    const lines = formatRecipePreviewLines(
      recipe({
        terminals: [
          { type: "terminal", command: "npm run dev -- --port 5173" },
          { type: "dev-preview", devCommand: "npm run preview" },
        ],
      }),
      { spawns: true }
    ).join("\n");
    expect(lines).toContain("npm run dev -- --port 5173");
    expect(lines).toContain("npm run preview");
  });

  it("shows env keys but never their values", () => {
    // A recipe is a plausible home for a token; the approver needs to know one
    // is being injected, not what it is.
    const lines = formatRecipePreviewLines(
      recipe({
        terminals: [
          { type: "terminal", command: "deploy", env: { API_TOKEN: "sk-secret", REGION: "eu" } },
        ],
      }),
      { spawns: true }
    ).join("\n");
    expect(lines).toContain("API_TOKEN");
    expect(lines).toContain("REGION");
    expect(lines).not.toContain("sk-secret");
    expect(lines).not.toContain("eu");
  });

  it("offers every terminal, with none struck off the tail (#12263)", () => {
    // Approving this dialog is what lifts the unapproved agent cap, so the
    // offer is the whole recipe. The old "Starts 2 of 4 … at most 2" framing
    // with a struck-through tail would now understate what the click buys,
    // which misleads an approver exactly as badly as overstating it.
    const lines = formatRecipePreviewLines(
      recipe({
        terminals: [
          { type: "terminal", command: "one" },
          { type: "terminal", command: "two" },
          { type: "terminal", command: "three" },
          { type: "terminal", command: "four" },
        ],
      }),
      { spawns: true }
    );
    const joined = lines.join("\n");
    expect(joined).toContain("Starts 4 terminals");
    expect(joined).not.toContain("not started");
    expect(joined).not.toContain("of 4");
    expect(joined).not.toContain("at most");
    // Every command is still listed — the count is the claim, the commands are
    // the evidence for it.
    for (const command of ["one", "two", "three", "four"]) {
      expect(joined).toContain(command);
    }
  });

  it("says one terminal, not one terminals", () => {
    const lines = formatRecipePreviewLines(recipe(), { spawns: true }).join("\n");
    expect(lines).toContain("Starts 1 terminal:");
    expect(lines).not.toContain("not started");
  });

  it("shows agent flags and prompt for an agent terminal", () => {
    const lines = formatRecipePreviewLines(
      recipe({
        terminals: [{ type: "claude", args: "--model opus", initialPrompt: "fix the bug" }],
      }),
      { spawns: true }
    ).join("\n");
    expect(lines).toContain("claude --model opus");
    expect(lines).toContain("fix the bug");
  });

  it("elides an overlong command rather than flooding the dialog", () => {
    const long = "x".repeat(500);
    const lines = formatRecipePreviewLines(
      recipe({ terminals: [{ type: "terminal", command: long }] }),
      { spawns: true }
    );
    const commandLine = lines.find((line) => line.includes("x"))!;
    expect(commandLine.length).toBeLessThan(long.length);
    expect(commandLine).toContain("…");
  });

  it("says so explicitly when the recipe could not be resolved", () => {
    // An empty preview would read as "this recipe does nothing".
    const lines = formatRecipePreviewLines(null, { spawns: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/couldn't resolve/i);
  });

  it("does not claim a non-spawning dispatch will start anything", () => {
    // recipe.delete and recipe.saveToRepo are gated and preview the same
    // content; telling the approver those terminals are about to run would be
    // false, since these dispatches start nothing at all.
    const lines = formatRecipePreviewLines(
      recipe({
        terminals: [
          { type: "terminal", command: "one" },
          { type: "terminal", command: "two" },
          { type: "terminal", command: "three" },
          { type: "terminal", command: "four" },
        ],
      }),
      { spawns: false }
    );
    const joined = lines.join("\n");
    expect(joined).not.toContain("Starts");
    expect(joined).not.toContain("not started");
    expect(joined).toContain("Defines 4 terminals");
    // The commands are still shown — a delete confirm needs real content, not a count.
    expect(joined).toContain("four");
  });
});
