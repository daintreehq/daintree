/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { RunCard } from "../RunCard";
import type { WorkflowRunIpc } from "@shared/types/ipc/api";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

function makeRun(overrides: Partial<WorkflowRunIpc> = {}): WorkflowRunIpc {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    workflowVersion: "1.0.0",
    status: "running",
    startedAt: Date.now() - 60000,
    nodeStates: {},
    scheduledNodes: [],
    taskMapping: {},
    evaluatedConditions: [],
    definition: {
      id: "wf-1",
      version: "1.0.0",
      name: "Test Workflow",
      nodes: [
        { id: "build", type: "action", config: { actionId: "terminal.execute" } },
        { id: "test", type: "action", config: { actionId: "terminal.execute" } },
      ],
    },
    ...overrides,
  };
}

describe("RunCard", () => {
  it("renders all definition nodes in order", () => {
    const run = makeRun();
    render(<RunCard run={run} />);

    const nodeLabels = screen.getAllByText(/build|test/);
    expect(nodeLabels).toHaveLength(2);
    expect(nodeLabels[0].textContent).toBe("build");
    expect(nodeLabels[1].textContent).toBe("test");
  });

  it("renders workflow name", () => {
    const run = makeRun();
    render(<RunCard run={run} />);
    expect(screen.getByText("Test Workflow")).toBeDefined();
  });

  it("shows cancel button only when running", () => {
    const onCancel = vi.fn();
    const { rerender } = render(<RunCard run={makeRun({ status: "running" })} onCancel={onCancel} />);
    expect(screen.getByLabelText("Cancel workflow run")).toBeDefined();

    rerender(<RunCard run={makeRun({ status: "completed" })} onCancel={onCancel} />);
    expect(screen.queryByLabelText("Cancel workflow run")).toBeNull();
  });

  it("calls onCancel with runId", () => {
    const onCancel = vi.fn();
    render(<RunCard run={makeRun({ runId: "run-42" })} onCancel={onCancel} />);
    fireEvent.click(screen.getByLabelText("Cancel workflow run"));
    expect(onCancel).toHaveBeenCalledWith("run-42");
  });

  it("displays node error when present", () => {
    const run = makeRun({
      status: "failed",
      nodeStates: {
        build: {
          status: "failed",
          startedAt: Date.now(),
          completedAt: Date.now(),
          result: { error: "Build failed: exit code 1" },
        },
      },
    });
    render(<RunCard run={run} />);
    expect(screen.getByText("Build failed: exit code 1")).toBeDefined();
  });

  it("treats missing nodeState as queued", () => {
    const run = makeRun({ nodeStates: {} });
    render(<RunCard run={run} />);
    const badges = screen.getAllByRole("status");
    badges.forEach((badge) => {
      expect(badge.getAttribute("aria-label")).toBe("Queued");
    });
  });
});
