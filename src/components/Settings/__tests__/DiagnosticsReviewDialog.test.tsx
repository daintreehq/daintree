// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsReviewDialog } from "../DiagnosticsReviewDialog";
import type { DiagnosticsReviewPayload } from "@shared/types/ipc/system";

const payload = {
  payload: { whySlow: {}, os: {} },
  sectionKeys: ["whySlow", "os"],
  appLaunchTimestamp: 0,
} as unknown as DiagnosticsReviewPayload;

function renderDialog() {
  return render(
    <DiagnosticsReviewDialog
      isOpen
      onClose={vi.fn()}
      reviewPayload={payload}
      onSave={vi.fn()}
      isSaving={false}
    />
  );
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
});
