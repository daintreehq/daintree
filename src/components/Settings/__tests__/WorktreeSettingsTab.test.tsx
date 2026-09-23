// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKTREE_PATH_PATTERN } from "@shared/utils/pathPattern";

const CUSTOM_PATTERN = "{parent-dir}/{branch-slug}";

const dispatch = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatch(...args) },
}));
vi.mock("../SettingsValidationRegistry", () => ({ useSettingsTabValidation: () => {} }));
vi.mock("../FileBrowserVisibilitySettings", () => ({ FileBrowserVisibilitySettings: () => null }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeSettingsTab } from "../WorktreeSettingsTab";

async function renderWithSavedPattern(pathPattern: string) {
  dispatch.mockImplementation(async (id: string) =>
    id === "worktreeConfig.get" ? { ok: true, result: { pathPattern } } : { ok: true, result: {} }
  );
  render(
    <TooltipProvider>
      <WorktreeSettingsTab />
    </TooltipProvider>
  );
  await act(async () => {});
}

const RESET_NAME = "Reset path pattern to default";

beforeEach(() => {
  dispatch.mockReset();
});

describe("WorktreeSettingsTab path pattern", () => {
  it("shows no reset while the pattern is the default", async () => {
    await renderWithSavedPattern(DEFAULT_WORKTREE_PATH_PATTERN);
    expect(screen.queryByRole("button", { name: RESET_NAME })).toBeNull();
  });

  it("resets the field to the default without saving it", async () => {
    await renderWithSavedPattern(CUSTOM_PATTERN);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe(CUSTOM_PATTERN);

    fireEvent.click(screen.getByRole("button", { name: RESET_NAME }));

    expect(input.value).toBe(DEFAULT_WORKTREE_PATH_PATTERN);
    expect(screen.queryByRole("button", { name: RESET_NAME })).toBeNull();
    expect(dispatch).not.toHaveBeenCalledWith(
      "worktreeConfig.setPattern",
      expect.anything(),
      expect.anything()
    );
    // Differing from the default and being unsaved are separate: Save is now live.
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });
});
