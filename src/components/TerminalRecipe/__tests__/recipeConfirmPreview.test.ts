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
      { agentTerminalCap: 3, spawns: true }
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
      { agentTerminalCap: 3, spawns: true }
    ).join("\n");
    expect(lines).toContain("API_TOKEN");
    expect(lines).toContain("REGION");
    expect(lines).not.toContain("sk-secret");
    expect(lines).not.toContain("eu");
  });

  it("marks the terminals the agent cap will not start", () => {
    const lines = formatRecipePreviewLines(
      recipe({
        terminals: [
          { type: "terminal", command: "one" },
          { type: "terminal", command: "two" },
          { type: "terminal", command: "three" },
          { type: "terminal", command: "four" },
        ],
      }),
      { agentTerminalCap: 2, spawns: true }
    );
    const skipped = lines.filter((line) => line.includes("not started"));
    expect(skipped).toHaveLength(2);
    expect(skipped.every((line) => /three|four/.test(line))).toBe(true);
    expect(lines.join("\n")).toContain("2 of 4");
  });

  it("does not claim a cap applies when every terminal runs", () => {
    const lines = formatRecipePreviewLines(recipe(), { agentTerminalCap: 3, spawns: true }).join(
      "\n"
    );
    expect(lines).not.toContain("of 1");
    expect(lines).not.toContain("not started");
  });

  it("shows agent flags and prompt for an agent terminal", () => {
    const lines = formatRecipePreviewLines(
      recipe({
        terminals: [{ type: "claude", args: "--model opus", initialPrompt: "fix the bug" }],
      }),
      { agentTerminalCap: 3, spawns: true }
    ).join("\n");
    expect(lines).toContain("claude --model opus");
    expect(lines).toContain("fix the bug");
  });

  it("elides an overlong command rather than flooding the dialog", () => {
    const long = "x".repeat(500);
    const lines = formatRecipePreviewLines(
      recipe({ terminals: [{ type: "terminal", command: long }] }),
      { agentTerminalCap: 3, spawns: true }
    );
    const commandLine = lines.find((line) => line.includes("x"))!;
    expect(commandLine.length).toBeLessThan(long.length);
    expect(commandLine).toContain("…");
  });

  it("says so explicitly when the recipe could not be resolved", () => {
    // An empty preview would read as "this recipe does nothing".
    const lines = formatRecipePreviewLines(null, { agentTerminalCap: 3, spawns: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/couldn't resolve/i);
  });

  it("does not claim a non-spawning dispatch will start anything", () => {
    // recipe.delete and recipe.saveToRepo are gated and preview the same
    // content; telling the approver those terminals are about to run would be
    // false, and the agent cap does not apply to them at all.
    const lines = formatRecipePreviewLines(
      recipe({
        terminals: [
          { type: "terminal", command: "one" },
          { type: "terminal", command: "two" },
          { type: "terminal", command: "three" },
          { type: "terminal", command: "four" },
        ],
      }),
      { agentTerminalCap: 2, spawns: false }
    );
    const joined = lines.join("\n");
    expect(joined).not.toContain("Starts");
    expect(joined).not.toContain("not started");
    expect(joined).toContain("Defines 4 terminals");
    // The commands are still shown — a delete confirm needs real content, not a count.
    expect(joined).toContain("four");
  });
});
