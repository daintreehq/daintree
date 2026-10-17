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
      "npm install",
      "ZDOTDIR=.",
      "claude --model sonnet",
      "prompt: Run the setup script",
      "npm run dev",
    ]) {
      expect(screen.getByText(line)).toBeTruthy();
    }
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
