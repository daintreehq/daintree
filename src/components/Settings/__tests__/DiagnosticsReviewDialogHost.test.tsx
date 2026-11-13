// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsReviewPayload } from "@shared/types/ipc/system";

const { collectMock, saveMock, openExternalMock, notifyMock } = vi.hoisted(() => ({
  collectMock: vi.fn(),
  saveMock: vi.fn(),
  openExternalMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  systemClient: {
    collectDiagnosticsForReview: collectMock,
    saveDiagnosticsBundle: saveMock,
    openExternal: openExternalMock,
  },
}));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

// Radix Select does not open in jsdom, and no test here touches the window.
vi.mock("@/components/ui/select", () => {
  const Empty = () => null;
  return {
    Select: Empty,
    SelectTrigger: Empty,
    SelectValue: Empty,
    SelectContent: Empty,
    SelectItem: Empty,
  };
});

import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";
import { DiagnosticsReviewDialogHost } from "../DiagnosticsReviewDialogHost";

const reviewPayload: DiagnosticsReviewPayload = {
  payload: { metadata: { appVersion: "1.2.3" }, os: {} },
  sectionKeys: ["metadata", "os"],
  previewJson: "",
  appLaunchTimestamp: 0,
  versionFirstRun: null,
  oldestRetainedLogMs: null,
  collectedAtMs: 10_000_000,
  logMembers: {},
};

async function openReview() {
  collectMock.mockResolvedValueOnce(reviewPayload);
  await act(() => useDiagnosticsReviewStore.getState().openReview());
}

async function clickSave() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
  });
}

describe("DiagnosticsReviewDialogHost", () => {
  beforeEach(() => {
    collectMock.mockReset();
    saveMock.mockReset();
    openExternalMock.mockReset().mockResolvedValue(undefined);
    notifyMock.mockReset();
    useDiagnosticsReviewStore.setState({
      isOpen: false,
      isCollecting: false,
      isSaving: false,
      reviewPayload: null,
      scope: null,
      downloadError: null,
      saveError: null,
      savedIssueUrl: null,
    });
  });

  it("shows a failed save inside the open dialog, and a successful retry clears it", async () => {
    render(<DiagnosticsReviewDialogHost />);
    await openReview();

    saveMock.mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));
    await clickSave();
    expect(screen.getByRole("alert").textContent).toContain("ENOSPC: no space left on device");
    expect(useDiagnosticsReviewStore.getState().isOpen).toBe(true);

    saveMock.mockResolvedValueOnce(true);
    await clickSave();
    expect(useDiagnosticsReviewStore.getState().isOpen).toBe(false);
    expect(useDiagnosticsReviewStore.getState().saveError).toBeNull();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("over the crash screen, confirms the save in the dialog and opens the issue from it", async () => {
    render(<DiagnosticsReviewDialogHost zIndex="nested" confirmation="inline" />);
    await openReview();

    saveMock.mockResolvedValueOnce(true);
    await clickSave();
    expect(screen.getByText("Diagnostics saved")).toBeTruthy();
    expect(notifyMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue to GitHub issue" }));
    expect(openExternalMock).toHaveBeenCalledTimes(1);
    expect(openExternalMock.mock.calls[0]![0]).toContain("1.2.3");
    expect(useDiagnosticsReviewStore.getState().isOpen).toBe(false);
  });

  it("over the crash screen, a cancelled save leaves the review as it was", async () => {
    render(<DiagnosticsReviewDialogHost zIndex="nested" confirmation="inline" />);
    await openReview();

    saveMock.mockResolvedValueOnce(false);
    await clickSave();
    expect(screen.queryByText("Diagnostics saved")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Save report" })).toBeTruthy();
  });

  it("stacks above the dialog it opens over when asked for the nested tier", async () => {
    render(<DiagnosticsReviewDialogHost zIndex="nested" confirmation="inline" />);
    await openReview();
    const scrim = screen.getByTestId("diagnostics-review-dialog");
    expect(scrim.closest('[aria-modal="true"]')?.className).toContain("--z-nested-dialog");
  });
});
