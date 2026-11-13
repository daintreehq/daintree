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
import type { ProjectStatusMap } from "@shared/types/ipc/project";

const { projectState, statsState } = vi.hoisted(() => {
  const statsState: { stats: ProjectStatusMap } = { stats: {} };
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

// The layer's boundaries are only there to fence a crash; a passthrough keeps
// the error store and reporting out of a composition test.
vi.mock("@/components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The ⌘P palette as the layer sees it: something that attaches its search box
// to the ref it is handed.
vi.mock("@/lazyPanels", () => ({
  LazyProjectSwitcherPalette: ({
    paletteInputRef,
  }: {
    paletteInputRef?: React.RefObject<HTMLInputElement | null>;
  }) => (
    <div data-testid="switcher-palette">
      <input ref={paletteInputRef} data-testid="palette-input" />
    </div>
  ),
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

import type {
  SearchableProject,
  UseProjectSwitcherPaletteReturn,
} from "@/hooks/projectSwitcher/types";
import type { ProjectSwitcherConfirmSource } from "../ProjectSwitcherConfirmDialogs";

const { ProjectSwitcherConfirmHost } = await import("../ProjectSwitcherConfirmDialogs");
const { ProjectSwitcherModalLayer } = await import("../ProjectSwitcherModalLayer");
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

/** The source's callbacks that have been called, by name. */
function calledCallbacks(source: ProjectSwitcherConfirmSource): string[] {
  return Object.entries(source)
    .filter(([, value]) => vi.isMockFunction(value) && value.mock.calls.length > 0)
    .map(([key]) => key);
}

const BUSY_KEYS = [
  "isRemovingProject",
  "isSleepingProject",
  "isDeletingScratch",
  "isDeletingAllScratches",
] as const;

const scratchTarget = { id: "s1", name: "Spike", path: "/tmp/scratches/s1" };

/**
 * Each confirmation the host owns: how to make it pending, the busy flag that
 * locks it, and which of the source's callbacks its accept and cancel reach.
 */
const CONFIRMS: Array<{
  kind: string;
  pending: Partial<ProjectSwitcherConfirmSource>;
  /** Absent for the one follow-up with no work of its own to wait on. */
  busyKey?: (typeof BUSY_KEYS)[number];
  acceptKey: keyof ProjectSwitcherConfirmSource;
  cancelKey: keyof ProjectSwitcherConfirmSource;
  cancelArgs: unknown[];
}> = [
  {
    kind: "close project",
    pending: { removeConfirmProject: makeProject() },
    busyKey: "isRemovingProject",
    acceptKey: "confirmRemoveProject",
    cancelKey: "setRemoveConfirmProject",
    cancelArgs: [null],
  },
  {
    kind: "sleep project",
    pending: { sleepConfirmProject: makeProject() },
    busyKey: "isSleepingProject",
    acceptKey: "confirmSleep",
    cancelKey: "setSleepConfirmProject",
    cancelArgs: [null],
  },
  {
    kind: "delete scratch",
    pending: { deleteScratchConfirm: scratchTarget },
    busyKey: "isDeletingScratch",
    acceptKey: "confirmDeleteScratch",
    cancelKey: "dismissDeleteScratchConfirm",
    cancelArgs: [],
  },
  {
    kind: "delete every scratch",
    pending: { deleteAllScratchesConfirm: [scratchTarget] },
    busyKey: "isDeletingAllScratches",
    acceptKey: "confirmDeleteAllScratches",
    cancelKey: "dismissDeleteAllScratchesConfirm",
    cancelArgs: [],
  },
  {
    kind: "open saved project",
    pending: {
      saveAsProjectConfirm: {
        scratch: { id: "s1", name: "Spike" },
        project: {
          id: "p2",
          name: "retry-queue",
          path: "/Users/me/code/retry-queue",
          emoji: "🚀",
          lastOpened: 0,
        },
      },
    },
    acceptKey: "openSavedProject",
    cancelKey: "dismissSaveAsProjectConfirm",
    cancelArgs: [],
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

  describe.each(CONFIRMS)("$kind", ({ pending, acceptKey, cancelKey, cancelArgs }) => {
    it("renders one dialog whose accept and cancel reach only their own callbacks", () => {
      const source = { ...idleSource(), ...pending };
      render(
        <ProjectSwitcherConfirmHost
          projectSwitcher={source}
          paletteInputRef={createRef<HTMLInputElement>()}
        />
      );

      expect(screen.getAllByTestId("confirm-dialog")).toHaveLength(1);
      expect(calledCallbacks(source)).toEqual([]);

      fireEvent.click(screen.getByTestId("confirm-accept"));
      expect(calledCallbacks(source)).toEqual([acceptKey]);
      expect(source[acceptKey]).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();
      fireEvent.click(screen.getByTestId("confirm-cancel"));
      expect(calledCallbacks(source)).toEqual([cancelKey]);
      expect(source[cancelKey]).toHaveBeenCalledWith(...cancelArgs);
    });

    it("unmounts the dialog once the source clears it", () => {
      const paletteInputRef = createRef<HTMLInputElement>();
      const view = render(
        <ProjectSwitcherConfirmHost
          projectSwitcher={{ ...idleSource(), ...pending }}
          paletteInputRef={paletteInputRef}
        />
      );
      expect(screen.getAllByTestId("confirm-dialog")).toHaveLength(1);

      view.rerender(
        <ProjectSwitcherConfirmHost
          projectSwitcher={idleSource()}
          paletteInputRef={paletteInputRef}
        />
      );
      expect(screen.queryAllByTestId("confirm-dialog")).toHaveLength(0);
    });
  });

  describe.each(CONFIRMS.filter((confirm) => confirm.busyKey))(
    "$kind in flight",
    ({ pending, busyKey }) => {
      it("locks on its own operation", () => {
        render(
          <ProjectSwitcherConfirmHost
            projectSwitcher={{ ...idleSource(), ...pending, [busyKey!]: true }}
            paletteInputRef={createRef<HTMLInputElement>()}
          />
        );
        expect(screen.getByTestId("confirm-dialog").getAttribute("data-busy")).toBe("true");
      });

      it("stays live while only the other operations run", () => {
        const others = Object.fromEntries(
          BUSY_KEYS.filter((key) => key !== busyKey).map((key) => [key, true])
        );
        render(
          <ProjectSwitcherConfirmHost
            projectSwitcher={{ ...idleSource(), ...pending, ...others }}
            paletteInputRef={createRef<HTMLInputElement>()}
          />
        );
        expect(screen.getByTestId("confirm-dialog").getAttribute("data-busy")).toBe("false");
      });
    }
  );
});

/**
 * The real Close and Sleep requests, from a view where no copy of the switcher
 * has ever mounted: the action palette's Close and the toolbar pill's menu both
 * call `removeProject` straight on the hook, and Sleep closes the palette before
 * it asks, so the palette that asked is gone by the time the confirm is due.
 */
describe("cold requests with no switcher mounted", () => {
  function ColdView({ project, close }: { project: SearchableProject; close: () => void }) {
    const mutations = useProjectSwitcherProjectMutations({
      close,
      projects: [],
      // The store's own map, so rows come from `searchableProjects` as they do
      // while the stats the palette was built from are still current.
      projectStats: statsState.stats,
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

  /** Every store call that would close, remove or sleep a project. */
  function destructiveCalls() {
    return {
      closeActiveProject: projectState.closeActiveProject.mock.calls,
      closeProject: projectState.closeProject.mock.calls,
      removeProject: projectState.removeProject.mock.calls,
      sleepProject: projectState.sleepProject.mock.calls,
    };
  }

  const NOTHING_DESTROYED = {
    closeActiveProject: [],
    closeProject: [],
    removeProject: [],
    sleepProject: [],
  };

  async function requestClose() {
    render(<ColdView project={makeProject()} close={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("request-close"));
    });
  }

  it("shows one Close confirm, touches nothing, then closes only the project on screen", async () => {
    await requestClose();

    expect(screen.getAllByTestId("confirm-dialog")).toHaveLength(1);
    expect(screen.getByTestId("confirm-title").textContent).toBe("Close 'retry-queue'?");
    expect(destructiveCalls()).toEqual(NOTHING_DESTROYED);

    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-accept"));
    });

    expect(destructiveCalls()).toEqual({ ...NOTHING_DESTROYED, closeActiveProject: [["p1"]] });
    expect(screen.queryAllByTestId("confirm-dialog")).toHaveLength(0);
  });

  it("closes nothing when the Close confirm is cancelled", async () => {
    await requestClose();

    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-cancel"));
    });

    expect(destructiveCalls()).toEqual(NOTHING_DESTROYED);
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
    expect(destructiveCalls()).toEqual(NOTHING_DESTROYED);

    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-cancel"));
    });

    expect(destructiveCalls()).toEqual(NOTHING_DESTROYED);
    expect(screen.queryAllByTestId("confirm-dialog")).toHaveLength(0);
  });
});

/**
 * The layer ModalHostLayer mounts once per view: the ⌘P palette only while it
 * is open, the confirm host always.
 */
describe("ProjectSwitcherModalLayer", () => {
  function renderLayer(isOpen: boolean, confirm: Partial<ProjectSwitcherConfirmSource>) {
    const palette = {
      ...idleSource(),
      ...confirm,
      isOpen,
      mode: "modal",
    } as unknown as UseProjectSwitcherPaletteReturn;
    render(
      <ProjectSwitcherModalLayer
        isProjectSwitcherModalOpen={isOpen}
        projectSwitcherPalette={palette}
      />
    );
  }

  it("shows a confirm with the palette closed", () => {
    renderLayer(false, { removeConfirmProject: makeProject() });

    expect(screen.queryByTestId("switcher-palette")).toBeNull();
    expect(screen.getAllByTestId("confirm-dialog")).toHaveLength(1);
  });

  it("shows one confirm over the open palette, handing focus back to its search box", () => {
    renderLayer(true, { deleteScratchConfirm: scratchTarget });

    expect(screen.getAllByTestId("switcher-palette")).toHaveLength(1);
    expect(screen.getAllByTestId("confirm-dialog")).toHaveLength(1);
    expect(screen.getByTestId("confirm-dialog").getAttribute("data-restore-focus")).toBe(
      "palette-input"
    );
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
      else if (/\.tsx?$/.test(entry) && !/\.(test|spec|bench)\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  /** Where `<Tag` appears in code, by file, with comments stripped. */
  function renderSites(tag: string): Record<string, number> {
    const pattern = new RegExp(`<${tag}[\\s/>]`, "g");
    const sites: Record<string, number> = {};
    for (const file of productionSources(SRC)) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      const count = code.match(pattern)?.length ?? 0;
      if (count > 0) sites[path.relative(SRC, file).split(path.sep).join("/")] = count;
    }
    return sites;
  }

  it("mounts the switcher's modal layer once, in the per-view modal host", () => {
    expect(renderSites("ProjectSwitcherModalLayer")).toEqual({ "ModalHostLayer.tsx": 1 });
  });

  it("mounts the confirm host once, in that layer", () => {
    expect(renderSites("ProjectSwitcherConfirmHost")).toEqual({
      "components/Project/ProjectSwitcherModalLayer.tsx": 1,
    });
  });

  it("renders the dialogs only through the host", () => {
    expect(renderSites("ProjectSwitcherConfirmDialogs")).toEqual({
      "components/Project/ProjectSwitcherConfirmDialogs.tsx": 1,
    });
  });
});
