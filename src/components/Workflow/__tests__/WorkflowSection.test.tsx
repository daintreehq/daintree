/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { WorkflowSection } from "../WorkflowSection";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowRunIpc } from "@shared/types/ipc/api";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

function makeRun(runId: string, overrides: Partial<WorkflowRunIpc> = {}): WorkflowRunIpc {
  return {
    runId,
    workflowId: "wf-1",
    workflowVersion: "1.0.0",
    status: "completed",
    startedAt: Date.now(),
    nodeStates: {},
    scheduledNodes: [],
    taskMapping: {},
    evaluatedConditions: [],
    definition: {
      id: "wf-1",
      version: "1.0.0",
      name: "Test Workflow",
      nodes: [{ id: "step-1", type: "action", config: { actionId: "test.action" } }],
    },
    ...overrides,
  };
}

describe("WorkflowSection", () => {
  afterEach(() => {
    useWorkflowStore.setState({ runs: new Map(), isInitialized: false, epoch: 0 });
  });

  it("returns null when not initialized", () => {
    useWorkflowStore.setState({ isInitialized: false, runs: new Map() });
    const { container } = render(<WorkflowSection />);
    expect(container.innerHTML).toBe("");
  });

  it("returns null when no runs", () => {
    useWorkflowStore.setState({ isInitialized: true, runs: new Map() });
    const { container } = render(<WorkflowSection />);
    expect(container.innerHTML).toBe("");
  });

  it("renders when there are runs", () => {
    useWorkflowStore.setState({
      isInitialized: true,
      runs: new Map([["r1", makeRun("r1")]]),
    });
    render(<WorkflowSection />);
    expect(screen.getByText("Workflows")).toBeDefined();
  });

  it("shows active count badge for running workflows", () => {
    useWorkflowStore.setState({
      isInitialized: true,
      runs: new Map([
        ["r1", makeRun("r1", { status: "running" })],
        ["r2", makeRun("r2", { status: "completed" })],
      ]),
    });
    render(<WorkflowSection />);
    expect(screen.getByText("1 active")).toBeDefined();
  });

  it("collapses and expands", () => {
    useWorkflowStore.setState({
      isInitialized: true,
      runs: new Map([["r1", makeRun("r1")]]),
    });
    render(<WorkflowSection />);

    expect(screen.getByText("Test Workflow")).toBeDefined();

    fireEvent.click(screen.getByText("Workflows"));
    expect(screen.queryByText("Test Workflow")).toBeNull();

    fireEvent.click(screen.getByText("Workflows"));
    expect(screen.getByText("Test Workflow")).toBeDefined();
  });
});
