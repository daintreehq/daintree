// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TerminalRecipe } from "@shared/types/project";
import { HostSetupRecipeConfirm } from "../HostSetupRecipeConfirm";

const RECIPE = {
  id: "setup",
  name: "Install dependencies",
  createdAt: 0,
  terminals: [
    { type: "terminal", command: "npm install", env: { ZDOTDIR: "." } },
    { type: "claude", args: "--model sonnet", initialPrompt: "Run the setup script" },
    { type: "dev-preview", devCommand: "npm run dev" },
  ],
} as TerminalRecipe;

describe("HostSetupRecipeConfirm", () => {
  it("shows everything that decides what runs: commands, settings and prompts", () => {
    render(<HostSetupRecipeConfirm recipe={RECIPE} onAnswer={() => {}} />);
    expect(screen.getByText('Run "Install dependencies"?')).toBeTruthy();
    for (const line of [
      "$ npm install",
      "env: ZDOTDIR (values hidden)",
      "claude --model sonnet",
      "prompt: Run the setup script",
      "$ npm run dev",
    ]) {
      expect(screen.getByText(line)).toBeTruthy();
    }
  });

  it("names env vars without their values, which may be another machine's secrets", () => {
    render(
      <HostSetupRecipeConfirm
        recipe={{
          ...RECIPE,
          terminals: [
            {
              type: "terminal",
              command: "npm test",
              env: { OPENAI_API_KEY: "sk-live-123", DATABASE_URL: "postgres://u:p@db/app" },
            },
          ],
        }}
        onAnswer={() => {}}
      />
    );
    expect(screen.getByText("env: DATABASE_URL, OPENAI_API_KEY (values hidden)")).toBeTruthy();
    expect(document.body.textContent).not.toContain("sk-live-123");
    expect(document.body.textContent).not.toContain("postgres://");
  });

  it("lists an agent's system prompt and the panel a plugin step opens", () => {
    render(
      <HostSetupRecipeConfirm
        recipe={{
          ...RECIPE,
          terminals: [
            { type: "claude", systemPrompt: "Always push to main" },
            { type: "plugin-panel", panelKindId: "acme.md.preview" },
          ],
        }}
        onAnswer={() => {}}
      />
    );
    expect(screen.getByText("system prompt: Always push to main")).toBeTruthy();
    expect(screen.getByText("opens Plugin panel (acme.md.preview)")).toBeTruthy();
    expect(screen.queryByText("plugin-panel")).toBeNull();
  });

  it("shows a long command whole rather than eliding what runs", () => {
    const command = `curl -fsSL https://example.com/install.sh | sh && ${"x".repeat(300)} && rm -rf ~/x`;
    render(
      <HostSetupRecipeConfirm
        recipe={{ ...RECIPE, terminals: [{ type: "terminal", command }] }}
        onAnswer={() => {}}
      />
    );
    expect(screen.getByText(`$ ${command}`)).toBeTruthy();
  });

  it("answers no when dismissed and yes only on Run recipe", () => {
    const onAnswer = vi.fn();
    render(<HostSetupRecipeConfirm recipe={RECIPE} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Don't run" }));
    expect(onAnswer).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Run recipe" }));
    expect(onAnswer).toHaveBeenLastCalledWith(true);
  });
});
