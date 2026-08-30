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
    expect(screen.getByLabelText("Open as draft")).toHaveProperty("type", "checkbox");
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
    fireEvent.click(screen.getByRole("button", { name: "Execute" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Execute" }));

    // Settle on the success state, not on the call: `onExecute` is invoked
    // before its promise resolves, so waiting on the spy would leave the
    // resulting state update to land outside React's act boundary.
    await screen.findByText("Command completed.");

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({
      title: "Crash on open",
      priority: "high",
      draft: true,
    });
  });
});
