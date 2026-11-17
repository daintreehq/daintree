// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { MergedWorktreeCleanupPreview } from "@shared/types/mergedWorktreeCleanup";
import { MergedWorktreeCleanupSection } from "../MergedWorktreeCleanupSection";

const HOUR = 60 * 60 * 1000;
const CHECKED_AT = Date.UTC(2026, 10, 17, 12);

function preview(enabled: boolean): MergedWorktreeCleanupPreview {
  return {
    enabled,
    checkedAt: CHECKED_AT,
    worktrees: [
      {
        worktreePath: "/wt/done",
        branch: "feature/done",
        status: "removable",
        head: "a".repeat(40),
        pr: { number: 5, title: "Done", url: "u", mergedAt: CHECKED_AT - 30 * HOUR },
      },
      {
        worktreePath: "/wt/soon",
        branch: "feature/soon",
        status: "waiting",
        head: "b".repeat(40),
        pr: { number: 6, title: "Soon", url: "u", mergedAt: CHECKED_AT - 2 * HOUR },
        removableAt: CHECKED_AT + 22 * HOUR,
      },
      {
        worktreePath: "/wt/dirty",
        branch: "feature/dirty",
        status: "skipped",
        reason: "has-changes",
      },
    ],
  };
}

const previewMock =
  vi.fn<(payload: { projectId: string }) => Promise<MergedWorktreeCleanupPreview>>();
const setEnabledMock = vi.fn<(payload: { projectId: string; enabled: boolean }) => Promise<void>>();

beforeEach(() => {
  previewMock.mockReset().mockResolvedValue(preview(false));
  setEnabledMock.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { mergedWorktreeCleanup: { preview: previewMock, setEnabled: setEnabledMock } },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
});

describe("MergedWorktreeCleanupSection (#17321)", () => {
  it("lists what qualifies before the switch is on, with skipped reasons behind a disclosure", async () => {
    const { findByText, getByText, queryByText, getByRole } = render(
      <MergedWorktreeCleanupSection projectId="p1" />
    );

    await findByText("feature/done");
    expect(previewMock).toHaveBeenCalledWith({ projectId: "p1" });
    expect(getByText("feature/soon")).toBeTruthy();
    expect(getByText(/removable in 22 hours/)).toBeTruthy();
    expect(queryByText("feature/dirty")).toBeNull();
    expect(getByRole("switch").getAttribute("aria-checked")).toBe("false");

    fireEvent.click(getByText("Show reasons"));
    expect(getByText("feature/dirty")).toBeTruthy();
    expect(getByText("Has uncommitted changes")).toBeTruthy();
  });

  it("turns the rule on through its own setter and reads the list again", async () => {
    previewMock.mockResolvedValueOnce(preview(false)).mockResolvedValueOnce(preview(true));
    const { findByText, getByRole } = render(<MergedWorktreeCleanupSection projectId="p1" />);
    await findByText("feature/done");

    await act(async () => {
      fireEvent.click(getByRole("switch"));
    });

    expect(setEnabledMock).toHaveBeenCalledWith({ projectId: "p1", enabled: true });
    expect(previewMock).toHaveBeenCalledTimes(2);
    await findByText("What the next check removes");
    expect(getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("shows a failed check as an error with a Retry, not as nothing to remove", async () => {
    previewMock.mockRejectedValueOnce(new Error("forge unreachable"));
    const { findByText, queryByText, getByText } = render(
      <MergedWorktreeCleanupSection projectId="p1" />
    );

    await findByText(/forge unreachable/);
    expect(queryByText("No worktrees qualify right now")).toBeNull();

    await act(async () => {
      fireEvent.click(getByText("Retry"));
    });
    await findByText("feature/done");
  });

  it("says when nothing qualifies", async () => {
    previewMock.mockResolvedValue({ enabled: true, checkedAt: CHECKED_AT, worktrees: [] });
    const { findByText } = render(<MergedWorktreeCleanupSection projectId="p1" />);
    await findByText("No worktrees qualify right now");
  });
});
