// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  projects: [{ id: "p1", name: "Alpha" }],
  currentProject: { id: "p1" } as { id: string } | null,
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

const statsState = vi.hoisted(() => ({ stats: {} as Record<string, unknown> }));

vi.mock("@/store/projectStatsStore", () => ({
  useProjectStatsStore: { getState: () => statsState },
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    description,
    confirmLabel,
    children,
  }: {
    children?: React.ReactNode;
    isOpen: boolean;
    title: string;
    description: string;
    confirmLabel: string;
  }) =>
    isOpen ? (
      <div>
        <h2>{title}</h2>
        <p data-testid="description">{description}</p>
        {children}
        <button>{confirmLabel}</button>
      </div>
    ) : null,
}));

import { StopProjectConfirmDialog } from "../StopProjectConfirmDialog";

function renderDialog(projectId: string | null) {
  return render(
    <StopProjectConfirmDialog
      projectId={projectId}
      isStopping={false}
      onClose={vi.fn()}
      onConfirm={vi.fn()}
    />
  );
}

describe("StopProjectConfirmDialog", () => {
  afterEach(() => {
    cleanup();
    state.currentProject = { id: "p1" };
    statsState.stats = {};
  });

  it("lists what it ends with the sleep confirm's counts", () => {
    statsState.stats = { p1: { processCount: 4, activeAgentCount: 3, waitingAgentCount: 1 } };
    renderDialog("p1");
    const text = document.body.textContent ?? "";
    expect(text).toContain("4 terminals");
    expect(text).toContain("3 active agents");
    expect(text).toContain("1 waiting agent");
  });

  it("shows no count lines for zero counts or missing stats", () => {
    statsState.stats = { p1: { processCount: 2, activeAgentCount: 0, waitingAgentCount: 0 } };
    renderDialog("p1");
    expect(document.body.textContent).not.toContain("active agent");
    expect(document.body.textContent).not.toContain("waiting agent");
    cleanup();
    statsState.stats = {};
    renderDialog("p1");
    expect(document.querySelector("[data-stop-counts]")).toBeNull();
  });

  it("names every kind of terminal that ends, not just agents", () => {
    renderDialog("p1");
    const text = screen.getByTestId("description").textContent ?? "";
    expect(text).toContain("shells and dev servers as well as agent sessions");
    expect(screen.getByText("Stop project")).toBeTruthy();
  });

  it("says the window leaves the project when it is the active one", () => {
    renderDialog("p1");
    expect(screen.getByTestId("description").textContent).toContain(
      "This window then leaves the project"
    );
  });

  it("omits the window-leaves note for a background project", () => {
    state.currentProject = { id: "other" };
    renderDialog("p1");
    expect(screen.getByTestId("description").textContent).not.toContain("leaves the project");
  });

  it("renders nothing without a project", () => {
    renderDialog(null);
    expect(screen.queryByTestId("description")).toBeNull();
  });
});
