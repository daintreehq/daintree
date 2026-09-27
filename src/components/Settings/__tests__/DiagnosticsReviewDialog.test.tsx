// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { DiagnosticsReviewDialog } from "../DiagnosticsReviewDialog";

// Radix Select does not open in jsdom. The stand-in renders one native select
// carrying the trigger's own props, so the label, description and options the
// dialog wires are still what the tests read.
vi.mock("@/components/ui/select", () => {
  const SelectTrigger = (_: Record<string, unknown>) => null;
  const SelectValue = () => null;
  const SelectContent = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const SelectItem = ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  );
  const Select = ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => {
    let id: string | undefined;
    let describedBy: string | undefined;
    let options: React.ReactNode = null;
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement<Record<string, unknown>>(child)) return;
      if (child.type === SelectTrigger) {
        const { id: triggerId, "aria-describedby": triggerDescribedBy } = child.props;
        id = typeof triggerId === "string" ? triggerId : undefined;
        describedBy = typeof triggerDescribedBy === "string" ? triggerDescribedBy : undefined;
      } else if (child.type === SelectContent) {
        options = child;
      }
    });
    return (
      <select
        id={id}
        aria-describedby={describedBy}
        disabled={disabled}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {options}
      </select>
    );
  };
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});
import type { DiagnosticsReviewPayload } from "@shared/types/ipc/system";

const payload: DiagnosticsReviewPayload = {
  payload: { whySlow: {}, os: {} },
  sectionKeys: ["whySlow", "os"],
  previewJson: "",
  appLaunchTimestamp: 0,
  versionFirstRun: null,
  oldestRetainedLogMs: null,
};

function renderDialog(
  reviewPayload: DiagnosticsReviewPayload = payload,
  onSave = vi.fn(),
  isSaving = false
) {
  return render(
    <DiagnosticsReviewDialog
      isOpen
      onClose={vi.fn()}
      reviewPayload={reviewPayload}
      onSave={onSave}
      isSaving={isSaving}
    />
  );
}

const contactPayload: DiagnosticsReviewPayload = {
  ...payload,
  payload: { os: { owner: "sam@acme.io", backup: "ops@acme.io", org: "acme corp" } },
  sectionKeys: ["os"],
};

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

  it("shows the report preview on open, as a named keyboard-scrollable region", () => {
    renderDialog();
    const region = screen.getByRole("region", { name: "Report preview" });
    expect(region.tabIndex).toBe(0);
    expect(region.textContent).toContain("whySlow");
  });

  it("reports how many matches each active redaction made, including none", () => {
    renderDialog(contactPayload);
    const email = screen.getByRole("checkbox", { name: "Strip email addresses" });
    fireEvent.click(email);
    // The count describes the checkbox; it never becomes part of its name.
    expect(screen.getByRole("checkbox", { name: "Strip email addresses" })).toBe(email);
    expect(document.getElementById(email.getAttribute("aria-describedby")!)!.textContent).toBe(
      "2 matches"
    );

    const find = screen.getByRole("textbox", { name: "Find, rule 1" });
    fireEvent.change(find, { target: { value: "acme" } });
    expect(document.getElementById(find.getAttribute("aria-describedby")!)!.textContent).toBe(
      "1 match"
    );
    fireEvent.change(find, { target: { value: "acne" } });
    expect(document.getElementById(find.getAttribute("aria-describedby")!)!.textContent).toBe(
      "No matches"
    );
  });

  it("counts a rule against what the rules before it left behind", () => {
    renderDialog(contactPayload);
    fireEvent.click(screen.getByRole("checkbox", { name: /Strip email addresses/ }));
    // Both addresses are already gone by the time the custom rule runs, so it
    // replaces nothing in the saved report and must not claim otherwise.
    const find = screen.getByRole("textbox", { name: "Find, rule 1" });
    fireEvent.change(find, { target: { value: "@acme.io" } });
    expect(document.getElementById(find.getAttribute("aria-describedby")!)!.textContent).toBe(
      "No matches"
    );
  });

  it("marks every replacement in the preview", () => {
    renderDialog(contactPayload);
    fireEvent.click(screen.getByRole("checkbox", { name: /Strip email addresses/ }));
    const region = screen.getByRole("region", { name: "Report preview" });
    const bands = Array.from(region.querySelectorAll("[data-replacement]")).map(
      (el) => el.textContent
    );
    expect(bands).toEqual(["[REDACTED]", "[REDACTED]"]);
  });

  it("marks only what a rule replaced, not text that already read [REDACTED]", () => {
    renderDialog({
      ...contactPayload,
      payload: { os: { note: "[REDACTED]", owner: "sam@acme.io" } },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Strip email addresses/ }));
    const region = screen.getByRole("region", { name: "Report preview" });
    expect(region.querySelectorAll("[data-replacement]")).toHaveLength(1);
  });

  it("walks the replacements in order and wraps around", () => {
    renderDialog(contactPayload);
    fireEvent.click(screen.getByRole("checkbox", { name: /Strip email addresses/ }));
    const next = screen.getByRole("button", { name: "Next replacement" });
    const region = screen.getByRole("region", { name: "Report preview" });
    const meta = document.getElementById(region.getAttribute("aria-describedby")!)!;
    expect(meta.textContent).toContain("2 replaced");
    fireEvent.click(next);
    expect(meta.textContent).toContain("replacement 1 of 2");
    fireEvent.click(next);
    expect(meta.textContent).toContain("replacement 2 of 2");
    fireEvent.click(next);
    expect(meta.textContent).toContain("replacement 1 of 2");
    // Any change to the report starts the walk again.
    fireEvent.change(screen.getByRole("textbox", { name: "Find, rule 1" }), {
      target: { value: "acme corp" },
    });
    expect(meta.textContent).toContain("3 replaced");
  });

  it("restarts the walk when an edit moves the marks without changing the text", () => {
    renderDialog(contactPayload);
    fireEvent.click(screen.getByRole("checkbox", { name: /Strip email addresses/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Replace with, rule 1" }), {
      target: { value: "acme corp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next replacement" }));
    const region = screen.getByRole("region", { name: "Report preview" });
    const meta = document.getElementById(region.getAttribute("aria-describedby")!)!;
    expect(meta.textContent).toContain("replacement 1 of 2");
    // Replacing "acme corp" with itself leaves the text as it was and adds a mark.
    fireEvent.change(screen.getByRole("textbox", { name: "Find, rule 1" }), {
      target: { value: "acme corp" },
    });
    expect(meta.textContent).toContain("3 replaced");
  });

  it("brings the chosen replacement into the dialog's own view too", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    renderDialog(contactPayload);
    fireEvent.click(screen.getByRole("checkbox", { name: /Strip email addresses/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next replacement" }));
    const region = screen.getByRole("region", { name: "Report preview" });
    expect(scroll.mock.contexts).toContain(region.querySelectorAll("[data-replacement]")[0]);
    scroll.mockRestore();
  });

  it("keeps the Sections panel the disclosure controls in the tree while collapsed", () => {
    renderDialog();
    const toggle = screen.getByRole("button", { name: /^Sections/ });
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(panel?.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(panel?.hidden).toBe(false);
  });

  it("moves focus to the new rule's Find field when a rule is added", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Find, rule 2" }));
  });

  it("freezes everything that shapes the report while it saves", () => {
    renderDialog(payload, vi.fn(), true);
    for (const control of [
      screen.getByLabelText("Logs from"),
      screen.getByRole("checkbox", { name: /Strip email addresses/ }),
      screen.getByRole("textbox", { name: "Find, rule 1" }),
      screen.getByRole("button", { name: "Add rule" }),
      screen.getByRole("button", { name: /^Sections/ }),
    ]) {
      expect(control.matches(":disabled")).toBe(true);
    }
    expect(screen.getByRole("region", { name: "Report preview" }).matches(":disabled")).toBe(false);
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
