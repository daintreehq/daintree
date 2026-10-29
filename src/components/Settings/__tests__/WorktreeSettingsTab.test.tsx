// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useContext } from "react";
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
import {
  SettingsFlushContext,
  SettingsFlushProvider,
  type FailedSettingsFlush,
} from "../SettingsFlushRegistry";

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

// The tab under the dialog's flush registry; `flushAll` is the close-time flush.
let flushAll: () => Promise<FailedSettingsFlush[]> = async () => [];
async function renderInDialog(setPattern: () => Promise<unknown>) {
  dispatch.mockImplementation((id: string) =>
    id === "worktreeConfig.get"
      ? Promise.resolve({ ok: true, result: { pathPattern: CUSTOM_PATTERN } })
      : setPattern()
  );
  const { result } = renderHook(() => useContext(SettingsFlushContext)!, {
    wrapper: ({ children }) => (
      <SettingsFlushProvider>
        <TooltipProvider>
          <WorktreeSettingsTab />
        </TooltipProvider>
        {children}
      </SettingsFlushProvider>
    ),
  });
  flushAll = () => result.current.flushAll();
  await act(async () => {});
}

async function closeFlush() {
  let failed: FailedSettingsFlush[] = [];
  await act(async () => {
    failed = await flushAll();
  });
  return failed;
}

function setPatternCalls() {
  return dispatch.mock.calls.filter(([id]) => id === "worktreeConfig.setPattern");
}

describe("WorktreeSettingsTab close-time save", () => {
  it("keeps an invalid pattern and points the close at the field and its error", async () => {
    await renderInDialog(() => Promise.resolve({ ok: true, result: {} }));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "{parent-dir}/../{branch-slug}" } });

    const failed = await closeFlush();

    expect(failed).toHaveLength(1);
    expect(failed[0]!.tab).toBe("worktree");
    const landing = document.getElementById(failed[0]!.landOn);
    expect(landing?.contains(input)).toBe(true);
    expect(landing?.contains(screen.getByText(/Path traversal/))).toBe(true);
    expect(input.value).toBe("{parent-dir}/../{branch-slug}");
    expect(setPatternCalls()).toHaveLength(0);
  });

  it("keeps a pattern whose save was refused, with the reason under the field", async () => {
    await renderInDialog(() =>
      Promise.resolve({ ok: false, error: { message: "Config is read-only" } })
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    const next = "{parent-dir}/{repo-name}-{branch-slug}";
    fireEvent.change(input, { target: { value: next } });

    const failed = await closeFlush();

    expect(failed).toHaveLength(1);
    const landing = document.getElementById(failed[0]!.landOn);
    expect(landing?.contains(input)).toBe(true);
    expect(landing?.contains(screen.getByRole("alert"))).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Config is read-only");
    expect(input.value).toBe(next);
  });

  it("saves a valid pattern and lets the close through", async () => {
    const next = "{parent-dir}/{repo-name}-{branch-slug}";
    await renderInDialog(() => Promise.resolve({ ok: true, result: { pathPattern: next } }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: next } });

    expect(await closeFlush()).toEqual([]);
    expect(setPatternCalls()).toEqual([
      ["worktreeConfig.setPattern", { pattern: next }, { source: "user" }],
    ]);
  });

  it("answers a close during a Save with that Save's outcome, without saving twice", async () => {
    let answer: (value: unknown) => void = () => {};
    await renderInDialog(() => new Promise((resolve) => (answer = resolve)));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "{parent-dir}/{repo-name}-{branch-slug}" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    let failed: FailedSettingsFlush[] | null = null;
    await act(async () => {
      void flushAll().then((result) => (failed = result));
      await Promise.resolve();
    });
    expect(failed).toBeNull();

    await act(async () => answer({ ok: false, error: { message: "Config is read-only" } }));

    expect(failed).toHaveLength(1);
    expect(setPatternCalls()).toHaveLength(1);
  });
});
