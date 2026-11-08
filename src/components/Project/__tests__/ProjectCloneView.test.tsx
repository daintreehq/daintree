/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import type { Project } from "@shared/types";
import type { ProjectCloneJobSnapshot } from "@shared/types/ipc/projectClone";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const m = vi.hoisted(() => ({
  getCloneJob: vi.fn(),
  onCloneJobUpdated: vi.fn(),
  stopBackgroundClone: vi.fn(),
  retryBackgroundClone: vi.fn(),
  showItemInFolder: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("@/clients", () => ({
  projectClient: {
    getCloneJob: m.getCloneJob,
    onCloneJobUpdated: m.onCloneJobUpdated,
    stopBackgroundClone: m.stopBackgroundClone,
    retryBackgroundClone: m.retryBackgroundClone,
  },
  systemClient: { showItemInFolderUnconfined: m.showItemInFolder },
}));

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: m.dispatch } }));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    loading,
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; loading?: boolean }) => (
    <button type="button" aria-busy={loading || undefined} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/Spinner", () => ({ Spinner: () => <span /> }));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    confirmLabel,
    onConfirm,
  }: {
    isOpen: boolean;
    title: string;
    confirmLabel: string;
    onConfirm: () => void;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        <button type="button" onClick={onConfirm}>
          {`confirm: ${confirmLabel}`}
        </button>
      </div>
    ) : null,
}));

vi.mock("@/components/Terminal/InlineStatusBanner", () => ({
  InlineStatusBanner: ({
    title,
    description,
    action,
  }: {
    title: ReactNode;
    description?: ReactNode;
    action?: { id: string; label: string; onClick: () => void };
  }) => (
    <div data-testid="banner">
      <span>{title}</span>
      <span>{description}</span>
      {action && (
        <button type="button" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  ),
}));

import { ProjectCloneView } from "../ProjectCloneView";

const project: Project = {
  id: "p1",
  path: "/work/widgets",
  name: "widgets",
  emoji: "🧩",
  lastOpened: 1,
  cloneState: "cloning",
};

function snapshot(overrides: Partial<ProjectCloneJobSnapshot> = {}): ProjectCloneJobSnapshot {
  return {
    projectId: "p1",
    sequence: 1,
    status: "running",
    stopping: false,
    source: "https://github.com/acme/widgets.git",
    targetPath: "/work/widgets",
    stages: [],
    currentStageKey: null,
    output: [],
    error: null,
    cleanupError: null,
    canRetry: false,
    ...overrides,
  };
}

describe("ProjectCloneView", () => {
  let push: ((next: ProjectCloneJobSnapshot) => void) | null;

  beforeEach(() => {
    vi.clearAllMocks();
    push = null;
    m.onCloneJobUpdated.mockImplementation((callback: (next: ProjectCloneJobSnapshot) => void) => {
      push = callback;
      return vi.fn();
    });
    m.getCloneJob.mockResolvedValue(snapshot());
    m.stopBackgroundClone.mockResolvedValue(undefined);
    m.retryBackgroundClone.mockResolvedValue(undefined);
  });

  it("shows the live phase, its percentage, the phases done and git's output", async () => {
    m.getCloneJob.mockResolvedValue(
      snapshot({
        stages: [
          { key: "receiving objects", label: "Receiving objects", percent: 100 },
          { key: "resolving deltas", label: "Resolving deltas", percent: 37 },
        ],
        currentStageKey: "resolving deltas",
        output: ["Cloning into 'widgets'...", "Resolving deltas:  37% (37/100)"],
      })
    );
    render(<ProjectCloneView project={project} />);

    await screen.findByText("37%");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("37");
    expect(screen.getByText("Receiving objects")).toBeTruthy();
    expect(screen.getByLabelText("Git output").textContent).toContain("Cloning into 'widgets'...");
    expect(screen.getByText("https://github.com/acme/widgets.git", { selector: "p" })).toBeTruthy();
  });

  it("subscribes before asking, so an update that beats the first answer wins", async () => {
    let answer!: (value: ProjectCloneJobSnapshot) => void;
    m.getCloneJob.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<ProjectCloneView project={project} />);
    expect(m.onCloneJobUpdated).toHaveBeenCalled();

    act(() =>
      push!(
        snapshot({
          sequence: 5,
          stages: [{ key: "receiving objects", label: "Receiving objects", percent: 80 }],
          currentStageKey: "receiving objects",
        })
      )
    );
    await act(async () => answer(snapshot({ sequence: 2 })));

    expect(screen.getByText("80%")).toBeTruthy();
  });

  it("ignores updates for another project's clone", async () => {
    render(<ProjectCloneView project={project} />);
    await waitFor(() => expect(push).not.toBeNull());
    act(() =>
      push!(
        snapshot({
          projectId: "other",
          sequence: 9,
          stages: [{ key: "receiving objects", label: "Receiving objects", percent: 55 }],
          currentStageKey: "receiving objects",
        })
      )
    );
    expect(screen.queryByText("55%")).toBeNull();
  });

  it("stops this project's clone", async () => {
    render(<ProjectCloneView project={project} />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Stop clone" }));
    });
    expect(m.stopBackgroundClone).toHaveBeenCalledWith("p1");
  });

  it("keeps a failed clone on the project with git's error, Retry and Remove", async () => {
    m.getCloneJob.mockResolvedValue(
      snapshot({ status: "failed", error: "Repository not found", canRetry: true })
    );
    render(<ProjectCloneView project={{ ...project, cloneState: "failed" }} />);

    await screen.findByText("Clone failed");
    expect(screen.getByText("Repository not found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop clone" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(m.retryBackgroundClone).toHaveBeenCalledWith("p1");

    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm: Remove project" }));
    expect(m.dispatch).toHaveBeenCalledWith(
      "project.remove",
      { projectId: "p1" },
      { source: "user" }
    );
  });

  it("offers no Retry while the partial clone is still on disk", async () => {
    m.getCloneJob.mockResolvedValue(
      snapshot({
        status: "failed",
        error: "boom",
        cleanupError: "Couldn't remove the partial clone",
        canRetry: false,
      })
    );
    render(<ProjectCloneView project={{ ...project, cloneState: "failed" }} />);

    await screen.findByText("Partial clone not removed");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(m.showItemInFolder).toHaveBeenCalledWith("/work/widgets");
  });

  it("says why a retry couldn't start", async () => {
    m.getCloneJob.mockResolvedValue(snapshot({ status: "cancelled", canRetry: true }));
    m.retryBackgroundClone.mockRejectedValue(
      new Error('Folder "widgets" already exists in this location')
    );
    render(<ProjectCloneView project={{ ...project, cloneState: "cancelled" }} />);

    await screen.findByText("Clone stopped");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(await screen.findByText("Couldn't retry the clone")).toBeTruthy();
    expect(screen.getByText(/already exists in this location/)).toBeTruthy();
  });
});
