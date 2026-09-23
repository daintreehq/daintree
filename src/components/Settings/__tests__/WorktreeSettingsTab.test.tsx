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

describe("WorktreeSettingsTab load failure", () => {
  it("keeps the pattern unavailable, unvalidated and unmodified, and retries the load", async () => {
    dispatch.mockImplementation(async (id: string) =>
      id === "worktreeConfig.get"
        ? { ok: false, error: { message: "IPC unavailable" } }
        : { ok: true, result: {} }
    );
    render(
      <TooltipProvider>
        <WorktreeSettingsTab />
      </TooltipProvider>
    );
    await act(async () => {});

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(screen.queryByText("Pattern cannot be empty")).toBeNull();
    expect(screen.queryByRole("button", { name: RESET_NAME })).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Path pattern didn't load")).toBeTruthy();
    expect(screen.getByText("IPC unavailable")).toBeTruthy();

    dispatch.mockImplementation(async (id: string) =>
      id === "worktreeConfig.get"
        ? { ok: true, result: { pathPattern: CUSTOM_PATTERN } }
        : { ok: true, result: {} }
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    expect(screen.queryByText("Path pattern didn't load")).toBeNull();
    expect(input.disabled).toBe(false);
    expect(input.value).toBe(CUSTOM_PATTERN);
    expect(screen.getByRole("button", { name: RESET_NAME })).toBeTruthy();
  });
});

describe("WorktreeSettingsTab draft", () => {
  it("offers Discard only for an unsaved change, and Discard restores the saved pattern", async () => {
    await renderWithSavedPattern(CUSTOM_PATTERN);
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();

    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "{parent-dir}/{repo-name}-{branch-slug}" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(input.value).toBe(CUSTOM_PATTERN);
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("drops the Saved status as soon as the field changes again", async () => {
    await renderWithSavedPattern(CUSTOM_PATTERN);
    dispatch.mockImplementation(async (id: string, args?: { pattern?: string }) =>
      id === "worktreeConfig.setPattern"
        ? { ok: true, result: { pathPattern: args?.pattern } }
        : { ok: true, result: { pathPattern: CUSTOM_PATTERN } }
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "{parent-dir}/{repo-name}-{branch-slug}" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(screen.getByText("Saved")).toBeTruthy();

    fireEvent.change(input, { target: { value: "{parent-dir}/{branch-slug}-x" } });

    expect(screen.queryByText("Saved")).toBeNull();
  });
});

describe("WorktreeSettingsTab save in flight", () => {
  it("locks the field until the save answers, so the reply can't overwrite newer typing", async () => {
    await renderWithSavedPattern(CUSTOM_PATTERN);
    let answer: (value: unknown) => void = () => {};
    dispatch.mockImplementation((id: string) =>
      id === "worktreeConfig.setPattern"
        ? new Promise((resolve) => (answer = resolve))
        : Promise.resolve({ ok: true, result: { pathPattern: CUSTOM_PATTERN } })
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    const next = "{parent-dir}/{repo-name}-{branch-slug}";
    fireEvent.change(input, { target: { value: next } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(input.readOnly).toBe(true);

    await act(async () => answer({ ok: true, result: { pathPattern: next } }));
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe(next);
  });
});
