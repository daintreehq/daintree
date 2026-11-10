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
  reloadView: vi.fn(),
  closeActiveProject: vi.fn(),
  currentProjectId: "p1" as string | null,
  getProviders: vi.fn(),
}));

vi.mock("@/utils/reloadView", () => ({ reloadView: m.reloadView }));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      currentProject: m.currentProjectId ? { id: m.currentProjectId } : null,
      closeActiveProject: m.closeActiveProject,
    }),
  },
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
    m.closeActiveProject.mockResolvedValue({ processesKilled: 0, terminalsKilled: 0 });
    m.dispatch.mockResolvedValue({ ok: true });
    m.currentProjectId = "p1";
    m.getProviders.mockResolvedValue([
      {
        pluginId: "daintree.github",
        contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
      },
    ]);
    (globalThis as { window?: { electron?: unknown } }).window!.electron = {
      forge: { getProviders: m.getProviders },
    } as unknown as typeof window.electron;
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
    // Only the phases before the live one are checked off.
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Receiving objects",
    ]);
    expect(screen.getByLabelText("Git output").textContent).toBe(
      "Cloning into 'widgets'...\nResolving deltas:  37% (37/100)"
    );
    expect(screen.getByText("https://github.com/acme/widgets.git", { selector: "p" })).toBeTruthy();
  });

  it("subscribes before asking, so an update that beats the first answer wins", async () => {
    let answer!: (value: ProjectCloneJobSnapshot) => void;
    m.getCloneJob.mockImplementation(() => {
      // Main publishes while the first answer is still on its way.
      push?.(
        snapshot({
          sequence: 5,
          stages: [{ key: "receiving objects", label: "Receiving objects", percent: 80 }],
          currentStageKey: "receiving objects",
        })
      );
      return new Promise((resolve) => (answer = resolve));
    });
    render(<ProjectCloneView project={project} />);
    await act(async () => answer(snapshot({ sequence: 2 })));

    expect(screen.getByText("80%")).toBeTruthy();
  });

  it("ignores updates for another project's clone", async () => {
    m.getCloneJob.mockResolvedValue(
      snapshot({
        stages: [{ key: "receiving objects", label: "Receiving objects", percent: 20 }],
        currentStageKey: "receiving objects",
      })
    );
    render(<ProjectCloneView project={project} />);
    await screen.findByText("20%");
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
    expect(screen.getByText("20%")).toBeTruthy();
  });

  it("reloads into the project when main says its clone already landed", async () => {
    m.getCloneJob.mockResolvedValue(snapshot({ status: "succeeded" }));
    render(<ProjectCloneView project={project} />);
    await waitFor(() => expect(m.reloadView).toHaveBeenCalledTimes(1));
  });

  it("doesn't flash Connecting before the first phase can plausibly arrive", async () => {
    vi.useFakeTimers();
    try {
      render(<ProjectCloneView project={project} />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByText("Connecting…")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(screen.getByText("Connecting…")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
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
    // The row read before the failure still says cloning; main's answer wins.
    render(<ProjectCloneView project={project} />);

    await screen.findByText("Clone failed");
    expect(screen.getByText("Repository not found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop clone" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(m.retryBackgroundClone).toHaveBeenCalledWith("p1");

    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
    expect(m.dispatch).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "confirm: Remove project" }));
    });
    // The project on screen is closed first, so its view's saves are dropped.
    expect(m.closeActiveProject).toHaveBeenCalledWith("p1");
    expect(m.dispatch).toHaveBeenCalledWith(
      "project.remove",
      { projectId: "p1" },
      { source: "user" }
    );
    expect(m.closeActiveProject.mock.invocationCallOrder[0]).toBeLessThan(
      m.dispatch.mock.invocationCallOrder[0]!
    );
  });

  it("removes a project another window shows without closing this one's", async () => {
    m.currentProjectId = "elsewhere";
    m.getCloneJob.mockResolvedValue(snapshot({ status: "cancelled", canRetry: true }));
    render(<ProjectCloneView project={{ ...project, cloneState: "cancelled" }} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove project" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "confirm: Remove project" }));
    });

    expect(m.closeActiveProject).not.toHaveBeenCalled();
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
    expect(screen.queryByText(/what it wrote was removed/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(m.showItemInFolder).toHaveBeenCalledWith("/work/widgets");
  });

  it("doesn't claim a stopped clone's folder was removed when it wasn't", async () => {
    m.getCloneJob.mockResolvedValue(
      snapshot({ status: "cancelled", cleanupError: "Couldn't remove", canRetry: false })
    );
    render(<ProjectCloneView project={{ ...project, cloneState: "cancelled" }} />);

    await screen.findByText("Clone stopped");
    expect(screen.queryByText(/what it wrote was removed/)).toBeNull();
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

  describe("sign-in action on an auth failure", () => {
    const authFailure = (overrides: Partial<ProjectCloneJobSnapshot> = {}) =>
      snapshot({
        status: "failed",
        error: "Authentication failed for 'https://github.com/acme/widgets.git/'",
        gitReason: "auth-failed",
        canRetry: true,
        ...overrides,
      });

    it("offers Sign in to the provider that owns the URL, opening its Code forge subtab", async () => {
      m.getCloneJob.mockResolvedValue(authFailure());
      render(<ProjectCloneView project={project} />);

      const signIn = await screen.findByRole("button", { name: "Sign in to GitHub" });
      await act(async () => {
        fireEvent.click(signIn);
      });

      expect(m.dispatch).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "code-forge", subtab: "daintree.github.github" },
        { source: "user" }
      );
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Remove project" })).toBeTruthy();
    });

    it("offers it again for a failed project reopened from its persisted job", async () => {
      m.getCloneJob.mockResolvedValue(authFailure({ sequence: 0 }));
      render(<ProjectCloneView project={{ ...project, cloneState: "failed" }} />);

      expect(await screen.findByText("Sign in to GitHub")).toBeTruthy();
    });

    it("shows no action for a failure with another git reason", async () => {
      m.getCloneJob.mockResolvedValue(authFailure({ gitReason: "network-unavailable" }));
      render(<ProjectCloneView project={project} />);

      await screen.findByText("Clone failed");
      expect(screen.queryByText("Sign in to GitHub")).toBeNull();
      expect(m.getProviders).not.toHaveBeenCalled();
    });

    it("shows no action when no registered provider owns the URL", async () => {
      m.getCloneJob.mockResolvedValue(
        authFailure({ source: "https://gitlab.com/acme/widgets.git" })
      );
      render(<ProjectCloneView project={project} />);

      await waitFor(() => expect(m.getProviders).toHaveBeenCalled());
      await screen.findByText("Clone failed");
      expect(screen.queryByText(/^Sign in to/)).toBeNull();
    });

    it("keeps the plain banner when the providers can't be read", async () => {
      m.getProviders.mockRejectedValue(new Error("no registry"));
      m.getCloneJob.mockResolvedValue(authFailure());
      render(<ProjectCloneView project={project} />);

      await waitFor(() => expect(m.getProviders).toHaveBeenCalled());
      await screen.findByText("Clone failed");
      expect(screen.queryByText(/^Sign in to/)).toBeNull();
    });

    it("shows no action for a failed project with no job details", async () => {
      m.getCloneJob.mockResolvedValue(null);
      render(<ProjectCloneView project={{ ...project, cloneState: "failed" }} />);

      await screen.findByText("Clone failed");
      expect(screen.queryByText(/^Sign in to/)).toBeNull();
      expect(m.getProviders).not.toHaveBeenCalled();
    });
  });
});
