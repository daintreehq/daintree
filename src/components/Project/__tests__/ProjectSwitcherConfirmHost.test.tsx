/**
 * @vitest-environment jsdom
 *
 * The view's one host for the project switcher's confirmations (#16919). They
 * used to render inside each copy of the switcher, so a Close asked for from the
 * action palette or the toolbar pill before either copy had ever mounted landed
 * in state nothing drew, and once both copies had mounted it drew twice.
 *
 * `ConfirmDialog` is stubbed to a prop-rendering seam, as in the palette's
 * scratch-delete suite: its own gates have their own suite, and what matters
 * here is that exactly one dialog appears and what it is wired to.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRef, useRef } from "react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { render, screen, fireEvent, act } from "@testing-library/react";

const { projectState, statsState } = vi.hoisted(() => {
  const statsState = { stats: {} as Record<string, unknown> };
  const projectState = {
    loadProjects: vi.fn().mockResolvedValue(undefined),
    closeActiveProject: vi.fn().mockResolvedValue({ processesKilled: 0 }),
    sleepProject: vi.fn().mockResolvedValue(undefined),
    closeProject: vi.fn().mockResolvedValue({ processesKilled: 0 }),
    removeProject: vi.fn().mockResolvedValue(undefined),
    currentProject: null as { id: string } | null,
  };
  return { projectState, statsState };
});

vi.mock("@/store/projectStore", () => ({
  useProjectStore: Object.assign(
    (selector: (state: typeof projectState) => unknown) => selector(projectState),
    { getState: () => projectState }
  ),
}));

vi.mock("@/store/projectStatsStore", () => ({
  useProjectStatsStore: Object.assign(
    (selector: (state: typeof statsState) => unknown) => selector(statsState),
    { getState: () => statsState }
  ),
}));

vi.mock("@/store/projectRelocationStore", () => ({
  useProjectRelocationStore: (selector: (state: { open: () => void }) => unknown) =>
    selector({ open: vi.fn() }),
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/lib/copyWithToast", () => ({ copyWithToast: vi.fn() }));
vi.mock("@/clients", () => ({ projectClient: {} }));

vi.mock("@/hooks/useSettingsOwner", () => ({
  useRemoteHostName: () => null,
}));

vi.mock("@/components/ui/ConfirmDialog", async () => {
  const { useEffect, useState } = await vi.importActual<typeof import("react")>("react");
  return {
    ConfirmDialog: ({
      isOpen,
      title,
      confirmLabel,
      cancelLabel,
      onConfirm,
      onClose,
      isConfirmLoading,
      isBusy,
      restoreFocusTo,
    }: {
      isOpen: boolean;
      title: React.ReactNode;
      confirmLabel: string;
      cancelLabel?: string;
      onConfirm: () => void;
      onClose?: () => void;
      isConfirmLoading?: boolean;
      isBusy?: boolean;
      restoreFocusTo?: React.RefObject<HTMLElement | null>;
    }) => {
      // Resolved after mount: the ref is still null while the dialog renders.
      const [restoreTarget, setRestoreTarget] = useState("");
      useEffect(() => {
        setRestoreTarget(restoreFocusTo?.current?.getAttribute("data-testid") ?? "");
      }, [restoreFocusTo]);

      return isOpen ? (
        <div
          data-testid="confirm-dialog"
          data-busy={String(Boolean(isConfirmLoading || isBusy))}
          data-restore-focus={restoreTarget}
        >
          <h2 data-testid="confirm-title">{title}</h2>
          <button type="button" data-testid="confirm-accept" onClick={() => onConfirm()}>
            {confirmLabel}
          </button>
          <button type="button" data-testid="confirm-cancel" onClick={() => onClose?.()}>
            {cancelLabel}
          </button>
        </div>
      ) : null;
    },
  };
});

import type { SearchableProject } from "@/hooks/projectSwitcher/types";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import type { ProjectSwitcherConfirmSource } from "../ProjectSwitcherConfirmDialogs";

const { ProjectSwitcherConfirmHost } = await import("../ProjectSwitcherConfirmDialogs");
const { useProjectSwitcherProjectMutations } =
  await import("@/hooks/projectSwitcher/useProjectSwitcherProjectMutations");

function makeProject(overrides: Partial<SearchableProject> = {}): SearchableProject {
  return {
    id: "p1",
    name: "retry-queue",
    path: "/Users/me/code/retry-queue",
    emoji: "🚀",
    lastOpened: 0,
    status: "active",
    isActive: true,
    isBackground: false,
    isMissing: false,
    isPinned: false,
    frecencyScore: 0,
    displayPath: "retry-queue",
    section: "other",
    processCount: 0,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    ...overrides,
  };
}

function idleSource(): ProjectSwitcherConfirmSource {
  return {
    removeConfirmProject: null,
    setRemoveConfirmProject: vi.fn(),
    confirmRemoveProject: vi.fn().mockResolvedValue(undefined),
    isRemovingProject: false,
    sleepConfirmProject: null,
    setSleepConfirmProject: vi.fn(),
    confirmSleep: vi.fn().mockResolvedValue(undefined),
    isSleepingProject: false,
    deleteScratchConfirm: null,
    dismissDeleteScratchConfirm: vi.fn(),
    confirmDeleteScratch: vi.fn().mockResolvedValue(undefined),
    isDeletingScratch: false,
    deleteAllScratchesConfirm: null,
    dismissDeleteAllScratchesConfirm: vi.fn(),
    confirmDeleteAllScratches: vi.fn().mockResolvedValue(undefined),
    isDeletingAllScratches: false,
    saveAsProjectConfirm: null,
    dismissSaveAsProjectConfirm: vi.fn(),
    openSavedProject: vi.fn(),
  };
}

const scratchTarget = { id: "s1", name: "Spike", path: "/tmp/scratches/s1" };

/**
 * Each confirmation the host owns: how to make it pending, how to mark it busy,
 * and which of the source's callbacks its accept and cancel must reach.
 */
const CONFIRMS: Array<{
  kind: string;
  pending: Partial<ProjectSwitcherConfirmSource>;
  /** Absent for the one follow-up with no work of its own to wait on. */
  busy?: Partial<ProjectSwitcherConfirmSource>;
  accepted: (s: ProjectSwitcherConfirmSource) => unknown;
  cancelled: (s: ProjectSwitcherConfirmSource) => { fn: unknown; args: unknown[] };
}> = [
  {
    kind: "close project",
    pending: { removeConfirmProject: makeProject() },
    busy: { isRemovingProject: true },
    accepted: (s) => s.confirmRemoveProject,
    cancelled: (s) => ({ fn: s.setRemoveConfirmProject, args: [null] }),
  },
  {
    kind: "sleep project",
    pending: { sleepConfirmProject: makeProject() },
    busy: { isSleepingProject: true },
    accepted: (s) => s.confirmSleep,
    cancelled: (s) => ({ fn: s.setSleepConfirmProject, args: [null] }),
  },
  {
    kind: "delete scratch",
    pending: { deleteScratchConfirm: scratchTarget },
    busy: { isDeletingScratch: true },
    accepted: (s) => s.confirmDeleteScratch,
    cancelled: (s) => ({ fn: s.dismissDeleteScratchConfirm, args: [] }),
  },
  {
    kind: "delete every scratch",
    pending: { deleteAllScratchesConfirm: [scratchTarget] },
    busy: { isDeletingAllScratches: true },
    accepted: (s) => s.confirmDeleteAllScratches,
    cancelled: (s) => ({ fn: s.dismissDeleteAllScratchesConfirm, args: [] }),
  },
  {
    kind: "open saved project",
    pending: {
      saveAsProjectConfirm: {
        scratch: { name: "Spike" },
        project: { name: "retry-queue", path: "/Users/me/code/retry-queue" },
      },
    },
    accepted: (s) => s.openSavedProject,
    cancelled: (s) => ({ fn: s.dismissSaveAsProjectConfirm, args: [] }),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  statsState.stats = {};
  projectState.currentProject = null;
});

describe("ProjectSwitcherConfirmHost", () => {
  it("renders nothing while no confirmation is pending", () => {
    render(
      <ProjectSwitcherConfirmHost
        projectSwitcher={idleSource()}
        paletteInputRef={createRef<HTMLInputElement>()}
      />
    );
    expect(screen.queryAllByTestId("confirm-dialog")).toHaveLength(0);
  });

  describe.each(CONFIRMS)("$kind", ({ pending, accepted, cancelled }) => {
    it("renders one dialog wired to the source's own accept and cancel", () => {
      const source = { ...idleSource(), ...pending };
      render(
        <ProjectSwitcherConfirmHost
          projectSwitcher={source}
          paletteInputRef={createRef<HTMLInputElement>()}
        />
      );

      expect(screen.getAllByTestId("confirm-dialog")).toHaveLength(1);
      expect(screen.getByTestId("confirm-dialog").getAttribute("data-busy")).toBe("false");

      fireEvent.click(screen.getByTestId("confirm-accept"));
      expect(accepted(source)).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId("confirm-cancel"));
      const { fn, args } = cancelled(source);
      expect(fn).toHaveBeenCalledWith(...args);
    });

    it("unmounts the dialog once the source clears it", () => {
      const paletteInputRef = createRef<HTMLInputElement>();
      const view = render(
        <ProjectSwitcherConfirmHost
          projectSwitcher={{ ...idleSource(), ...pending }}
          paletteInputRef={paletteInputRef}
        />
      );
      view.rerender(
        <ProjectSwitcherConfirmHost
          projectSwitcher={idleSource()}
          paletteInputRef={paletteInputRef}
        />
      );
      expect(screen.queryAllByTestId("confirm-dialog")).toHaveLength(0);
    });
  });

  it.each(CONFIRMS.filter((confirm) => confirm.busy))(
    "passes the $kind confirm's in-flight state through",
    ({ pending, busy }) => {
      render(
        <ProjectSwitcherConfirmHost
          projectSwitcher={{ ...idleSource(), ...pending, ...busy }}
          paletteInputRef={createRef<HTMLInputElement>()}
        />
      );
      expect(screen.getByTestId("confirm-dialog").getAttribute("data-busy")).toBe("true");
    }
  );

  it("names the ⌘P search box as the focus successor while the palette is mounted", () => {
    function View() {
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <>
          <input ref={inputRef} data-testid="palette-input" />
          <ProjectSwitcherConfirmHost
            projectSwitcher={{ ...idleSource(), deleteScratchConfirm: scratchTarget }}
            paletteInputRef={inputRef}
          />
        </>
      );
    }
    render(<View />);
    expect(screen.getByTestId("confirm-dialog").getAttribute("data-restore-focus")).toBe(
      "palette-input"
    );
  });
});

/**
 * The real Close and Sleep requests, from a view where no copy of the switcher
 * has ever mounted: the action palette's Close and the toolbar pill's menu both
 * call `removeProject` straight on the hook, and Sleep closes the palette before
 * it asks, so the palette that asked is gone by the time the confirm is due.
 */
describe("cold requests with no switcher mounted", () => {
  function ColdView({ project, close }: { project: SearchableProject; close: () => void }) {
    const projectStats = statsState.stats as ProjectStatusMap;
    const mutations = useProjectSwitcherProjectMutations({
      close,
      projects: [],
      projectStats,
      searchableProjects: [project],
      rowContext: {
        currentProjectId: project.isActive ? project.id : undefined,
        displayPathById: new Map(),
        presenceByProjectId: { otherWindows: new Map(), thisWindow: new Map() },
        groupsById: new Map(),
      },
      copyToClipboard: vi.fn().mockResolvedValue(true),
    });
    const inputRef = useRef<HTMLInputElement>(null);
    return (
      <>
        <button
          type="button"
          data-testid="request-close"
          onClick={() => void mutations.removeProject(project.id)}
        />
        <button
          type="button"
          data-testid="request-sleep"
          onClick={() => void mutations.sleepProject(project.id)}
        />
        <ProjectSwitcherConfirmHost
          projectSwitcher={{ ...idleSource(), ...mutations }}
          paletteInputRef={inputRef}
        />
      </>
    );
  }

  it("shows one Close confirm and closes nothing until it is accepted", async () => {
    render(<ColdView project={makeProject()} close={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("request-close"));
    });

    expect(screen.getAllByTestId("confirm-dialog")).toHaveLength(1);
    expect(screen.getByTestId("confirm-title").textContent).toBe("Close 'retry-queue'?");
    expect(projectState.closeActiveProject).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-accept"));
    });

    expect(projectState.closeActiveProject).toHaveBeenCalledWith("p1");
    expect(screen.queryAllByTestId("confirm-dialog")).toHaveLength(0);
  });

  it("shows one Sleep confirm after the palette closes, and a cancel sleeps nothing", async () => {
    const close = vi.fn();
    render(<ColdView project={makeProject({ processCount: 2 })} close={close} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("request-sleep"));
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("confirm-dialog")).toHaveLength(1);
    expect(screen.getByTestId("confirm-title").textContent).toBe("Sleep 'retry-queue'?");

    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-cancel"));
    });

    expect(projectState.sleepProject).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId("confirm-dialog")).toHaveLength(0);
  });
});

/**
 * One host per view. A second render site, or the dialogs moving back inside a
 * copy of the switcher, is what dropped cold confirms and stacked warm ones.
 */
describe("render sites", () => {
  const SRC = path.resolve(__dirname, "../../..");

  function productionSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__" || entry === "__bench__" || entry === "node_modules") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) productionSources(full, out);
      else if (/\.tsx$/.test(entry) && !/\.(test|spec|bench)\.tsx$/.test(entry)) out.push(full);
    }
    return out;
  }

  function filesRendering(tag: string): string[] {
    const pattern = new RegExp(`<${tag}[\\s/>]`);
    return productionSources(SRC)
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file).split(path.sep).join("/"));
  }

  it("mounts the host once, in the per-view modal layer", () => {
    expect(filesRendering("ProjectSwitcherConfirmHost")).toEqual(["ModalHostLayer.tsx"]);
  });

  it("renders the dialogs only through the host", () => {
    expect(filesRendering("ProjectSwitcherConfirmDialogs")).toEqual([
      "components/Project/ProjectSwitcherConfirmDialogs.tsx",
    ]);
  });
});
