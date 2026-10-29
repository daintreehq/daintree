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

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    description,
    confirmLabel,
  }: {
    isOpen: boolean;
    title: string;
    description: string;
    confirmLabel: string;
  }) =>
    isOpen ? (
      <div>
        <h2>{title}</h2>
        <p data-testid="description">{description}</p>
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
