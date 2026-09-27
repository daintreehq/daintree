// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsReviewDialog } from "../DiagnosticsReviewDialog";
import type { DiagnosticsReviewPayload } from "@shared/types/ipc/system";

const payload: DiagnosticsReviewPayload = {
  payload: { whySlow: {}, os: {} },
  sectionKeys: ["whySlow", "os"],
  previewJson: "",
  appLaunchTimestamp: 0,
  versionFirstRun: null,
  oldestRetainedLogMs: null,
};

function renderDialog(reviewPayload: DiagnosticsReviewPayload = payload, onSave = vi.fn()) {
  return render(
    <DiagnosticsReviewDialog
      isOpen
      onClose={vi.fn()}
      reviewPayload={reviewPayload}
      onSave={onSave}
      isSaving={false}
    />
  );
}

const updatedPayload: DiagnosticsReviewPayload = {
  ...payload,
  payload: {
    logs: {
      recentEntries: [
        { timestamp: 1_000, message: "before-update" },
        { timestamp: 5_000, message: "after-update" },
      ],
    },
  },
  sectionKeys: ["logs"],
  appLaunchTimestamp: 8_000,
  versionFirstRun: { version: "0.39.0", firstRunAtMs: 4_000 },
  oldestRetainedLogMs: 500,
};

function timeWindowSelect(): HTMLSelectElement {
  return screen.getByLabelText("Logs from") as HTMLSelectElement;
}

function optionLabels(): string[] {
  return Array.from(timeWindowSelect().options).map((o) => o.textContent ?? "");
}

describe("DiagnosticsReviewDialog", () => {
  it("names each section in words, not its payload key", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^Sections/ }));
    expect(screen.getByRole("checkbox", { name: "Slowness snapshot" })).toBeTruthy();
    expect(screen.queryByText("whySlow")).toBeNull();
  });

  it("labels every find-and-replace field and removal by its rule", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(screen.getByRole("textbox", { name: "Find, rule 2" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Replace with, rule 2" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove rule 2" }));
    // The removed rule's button is gone; focus lands on a control that still exists.
    expect(screen.queryByRole("textbox", { name: "Find, rule 2" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add rule" }));
  });

  it("exposes the preview as a disclosure", () => {
    renderDialog();
    const toggle = screen.getByRole("button", { name: "Preview the report" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Report preview")).toBeTruthy();
  });

  it("hides the update window when no version change has been observed", () => {
    renderDialog();
    expect(optionLabels()).toEqual([
      "Last 5 minutes",
      "Last 30 minutes",
      "Since application launch",
      "Full log history",
    ]);
  });

  it("offers the update window named by version, between launch and full history", () => {
    renderDialog(updatedPayload);
    expect(optionLabels()).toEqual([
      "Last 5 minutes",
      "Last 30 minutes",
      "Since application launch",
      "Since updating to 0.39.0",
      "Full log history",
    ]);
    expect(timeWindowSelect().value).toBe("30m");
  });

  it("cuts the preview and the saved report at the version's first launch", () => {
    const onSave = vi.fn();
    renderDialog(updatedPayload, onSave);
    fireEvent.change(timeWindowSelect(), { target: { value: "update" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview the report" }));

    const preview = screen.getByLabelText("Report preview").textContent ?? "";
    expect(preview).toContain("after-update");
    expect(preview).not.toContain("before-update");
    expect(screen.queryByText(/rotated out/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
    expect(onSave).toHaveBeenCalledWith(expect.anything(), expect.anything(), 4_000);
  });

  it("falls back to full history and says so when rotation dropped logs after the update", () => {
    const onSave = vi.fn();
    renderDialog({ ...updatedPayload, oldestRetainedLogMs: 4_500 }, onSave);
    fireEvent.change(timeWindowSelect(), { target: { value: "update" } });

    const hint = screen.getByText(/rotated out/);
    expect(timeWindowSelect().getAttribute("aria-describedby")).toBe(hint.id);

    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
    expect(onSave).toHaveBeenCalledWith(expect.anything(), expect.anything(), null);
  });

  it("keeps the version cutoff when the oldest retained log starts exactly at the update", () => {
    const onSave = vi.fn();
    renderDialog({ ...updatedPayload, oldestRetainedLogMs: 4_000 }, onSave);
    fireEvent.change(timeWindowSelect(), { target: { value: "update" } });

    expect(screen.queryByText(/rotated out/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
    expect(onSave).toHaveBeenCalledWith(expect.anything(), expect.anything(), 4_000);
  });
});
