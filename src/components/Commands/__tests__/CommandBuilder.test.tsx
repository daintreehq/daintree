// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommandBuilder } from "../CommandBuilder";
import type { BuilderStep, CommandManifestEntry } from "@shared/types/commands";

const command: CommandManifestEntry = {
  id: "test:build",
  label: "Test command",
  description: "",
  category: "workflow",
  hasBuilder: true,
  enabled: true,
};

const steps: BuilderStep[] = [
  {
    id: "step-1",
    title: "Details",
    fields: [
      { name: "title", label: "Issue title", type: "text", helpText: "Keep it short" },
      { name: "body", label: "Description", type: "textarea" },
      {
        name: "priority",
        label: "Priority",
        type: "select",
        options: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
      },
      { name: "draft", label: "Open as draft", type: "checkbox" },
    ],
  },
];

function renderBuilder(overrides: Partial<Parameters<typeof CommandBuilder>[0]> = {}) {
  const onExecute = vi.fn().mockResolvedValue({ success: true });
  render(
    <CommandBuilder
      command={command}
      steps={steps}
      context={{}}
      isExecuting={false}
      executionError={null}
      onExecute={onExecute}
      onCancel={vi.fn()}
      {...overrides}
    />
  );
  return { onExecute };
}

describe("CommandBuilder field rendering", () => {
  it("names every manifest-supplied field, whatever its type", () => {
    renderBuilder();

    // Manifest labels are the only names these controls have — a rail row that
    // dropped the association would leave them anonymous.
    expect(screen.getByLabelText("Issue title").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Description").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Priority").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Open as draft").getAttribute("role")).toBe("checkbox");
  });

  it("points a field at its own help text", () => {
    renderBuilder();

    const described = screen.getByLabelText("Issue title").getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toBe("Keep it short");
  });

  it("describes a field by its validation error instead of its help text once it fails", async () => {
    const longMin: BuilderStep[] = [
      {
        id: "step-1",
        title: "Details",
        fields: [
          {
            name: "title",
            label: "Issue title",
            type: "text",
            helpText: "Keep it short",
            validation: { min: 5, message: "Too short" },
          },
        ],
      },
    ];
    const onExecute = vi.fn().mockResolvedValue({ success: true });
    render(
      <CommandBuilder
        command={command}
        steps={longMin}
        context={{}}
        isExecuting={false}
        executionError={null}
        onExecute={onExecute}
        onCancel={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("Issue title"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Too short");
    expect(screen.getByLabelText("Issue title").getAttribute("aria-describedby")).toBe(alert.id);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("carries each field's value through to execution", async () => {
    const { onExecute } = renderBuilder();

    fireEvent.change(screen.getByLabelText("Issue title"), { target: { value: "Crash on open" } });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "high" } });
    fireEvent.click(screen.getByLabelText("Open as draft"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    // Settle on the success state, not on the call: `onExecute` is invoked
    // before its promise resolves, so waiting on the spy would leave the
    // resulting state update to land outside React's act boundary.
    await screen.findByText("Done");

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({
      title: "Crash on open",
      priority: "high",
      draft: true,
    });
  });
});

const twoSteps: BuilderStep[] = [
  {
    id: "one",
    title: "First",
    fields: [
      {
        name: "count",
        label: "Count",
        type: "number",
        validation: { min: 1, integer: true, message: "Whole numbers only" },
      },
    ],
  },
  {
    id: "two",
    title: "Second",
    submitLabel: "Create thing",
    fields: [{ name: "note", label: "Note", type: "text" }],
  },
];

describe("CommandBuilder focus and state contract", () => {
  it("keeps the running action focusable and named instead of natively disabling it", () => {
    renderBuilder({ isExecuting: true });

    // A native `disabled` on the button that was just pressed drops focus to
    // <body>, out of the dialog.
    const run = screen.getByRole("button", { name: "Run" });
    expect(run.hasAttribute("disabled")).toBe(false);
    expect(run.getAttribute("aria-busy")).toBe("true");
  });

  it("names the final action from the manifest", () => {
    renderBuilder({ steps: twoSteps });
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(screen.getByRole("button", { name: "Create thing" })).toBeTruthy();
  });

  it("moves focus into the new step's first field when the step changes", () => {
    renderBuilder({ steps: twoSteps });
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(document.activeElement).toBe(screen.getByLabelText("Note"));

    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(document.activeElement).toBe(screen.getByLabelText("Count"));
  });

  it("moves focus to the first invalid field when a step fails validation", () => {
    renderBuilder({ steps: twoSteps });
    const count = screen.getByLabelText("Count");
    fireEvent.change(count, { target: { value: "1.5" } });
    screen.getByRole("button", { name: /Next/ }).focus();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(count.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(count);
  });

  it("clears a field's error once its value is fixed, not merely touched", () => {
    renderBuilder({ steps: twoSteps });
    const count = screen.getByLabelText("Count");
    fireEvent.change(count, { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    fireEvent.change(count, { target: { value: "2.5" } });
    expect(count.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(count, { target: { value: "3" } });
    expect(count.getAttribute("aria-invalid")).toBeNull();
  });

  it("announces the result and hands focus to Close once the command succeeds", async () => {
    renderBuilder({
      onExecute: vi.fn().mockResolvedValue({ success: true, message: "Issue #7 created" }),
    });
    // Let the dialog's deferred initial focus settle first, or it lands on
    // Close by itself and proves nothing.
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Issue title"))
    );
    const run = screen.getByRole("button", { name: "Run" });
    run.focus();
    fireEvent.click(run);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Issue #7 created");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("reports a run failure as an alert with a retry that runs the command again", async () => {
    const onExecute = vi.fn().mockResolvedValue({ success: false });
    renderBuilder({ executionError: "Cannot reach GitHub.", onExecute });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Cannot reach GitHub.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
  });
});
