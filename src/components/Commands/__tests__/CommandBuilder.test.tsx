// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
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

describe("CommandBuilder input contract", () => {
  const numberStep: BuilderStep[] = [
    {
      id: "only",
      title: "Only",
      fields: [{ name: "issue", label: "Issue number", type: "number", required: true }],
    },
  ];

  it("stops a blank required field before the command runs", () => {
    const onExecute = vi.fn().mockResolvedValue({ success: true });
    renderBuilder({ steps: numberStep, onExecute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(screen.getByLabelText("Issue number").getAttribute("aria-invalid")).toBe("true");
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("sends a number field's value as a number", async () => {
    const onExecute = vi.fn().mockResolvedValue({ success: true });
    renderBuilder({ steps: numberStep, onExecute });
    const input = screen.getByLabelText("Issue number");

    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("Done");
    expect(onExecute.mock.calls[0]?.[0]).toEqual({ issue: 42 });
  });

  it("says what it is running while the command is in flight", () => {
    renderBuilder({ isExecuting: true });
    expect(screen.getByRole("status").textContent).toBe("Running Test command…");
  });
});

describe("CommandBuilder recovery", () => {
  it("keeps focus on the run action when Retry restarts the command", async () => {
    let finish: (r: { success: boolean }) => void = () => {};
    const onExecute = vi.fn(() => new Promise<{ success: boolean }>((r) => (finish = r)));
    renderBuilder({ executionError: "Cannot reach GitHub.", onExecute });

    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Run" }));
    finish({ success: false });
    await vi.waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
  });

  it("lets a run that outlives the still-working threshold be left without cancelling it", () => {
    vi.useFakeTimers();
    try {
      const onCancel = vi.fn();
      renderBuilder({ isExecuting: true, onCancel });
      expect(screen.getByRole("button", { name: "Cancel" }).getAttribute("aria-disabled")).toBe(
        "true"
      );

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByRole("status").textContent).toContain("Closing this won't stop it");
      // Relabelled only once leaving is possible, and it no longer cancels anything.
      const leave = screen.getByRole("button", { name: "Close" });
      expect(leave.getAttribute("aria-disabled")).toBeNull();
      fireEvent.click(leave);
      expect(onCancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("focuses the forward action when the next step has no fields", () => {
    const fieldless: BuilderStep[] = [
      { id: "a", title: "First", fields: [{ name: "x", label: "X", type: "text" }] },
      { id: "b", title: "Confirm", fields: [], submitLabel: "Do it" },
    ];
    renderBuilder({ steps: fieldless });
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Do it" }));
  });
});

describe("CommandBuilder Enter-to-submit", () => {
  it("submits from a single-line field, as every form dialog does", async () => {
    const { onExecute } = renderBuilder();
    const title = screen.getByLabelText("Issue title");
    fireEvent.change(title, { target: { value: "Crash on open" } });
    fireEvent.keyDown(title, { key: "Enter" });

    await screen.findByText("Done");
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({ title: "Crash on open" });
  });

  it("keeps Enter a newline in a textarea, and never submits mid-composition", () => {
    const { onExecute } = renderBuilder();
    fireEvent.keyDown(screen.getByLabelText("Description"), { key: "Enter" });
    fireEvent.keyDown(screen.getByLabelText("Issue title"), { key: "Enter", isComposing: true });
    fireEvent.keyDown(screen.getByLabelText("Issue title"), { key: "Enter", shiftKey: true });
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("advances a step rather than skipping to the submit, with the same validation", () => {
    const { onExecute } = renderBuilder({ steps: twoSteps });
    const count = screen.getByLabelText("Count");

    fireEvent.change(count, { target: { value: "1.5" } });
    fireEvent.keyDown(count, { key: "Enter" });
    expect(screen.getByText("Whole numbers only")).toBeTruthy();

    fireEvent.change(count, { target: { value: "2" } });
    fireEvent.keyDown(count, { key: "Enter" });
    expect(screen.getByLabelText("Note")).toBeTruthy();
    expect(onExecute).not.toHaveBeenCalled();
  });
});
