import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/ActionService", async () => {
  const actual = await vi.importActual<typeof import("@/services/ActionService")>(
    "@/services/ActionService"
  );
  return { ...actual, actionService: { dispatch: dispatchMock } };
});

import { registerProjectActions } from "../../../services/actions/definitions/projectActions";
import { useProjectStore } from "@/store/projectStore";
import { usePilotStore } from "@/store/pilotStore";
import type { ActionCallbacks, ActionRegistry } from "@/services/actions/actionTypes";
import type { ActionContext } from "@shared/types/actions";

const switchProject = vi.fn(async () => {});

/**
 * Only the two fields `pilot.openRun` reads. The registrar takes the full
 * callback bag and the full store, neither of which this action touches, so the
 * carriers stay deliberately minimal rather than mocking surfaces that play no
 * part in the behaviour under test.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: openRun uses no callbacks
const NO_CALLBACKS = {} as ActionCallbacks;
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: run() ignores ctx
const NO_CTX = {} as ActionContext;

function seedProject(currentProjectId: string | null): void {
  useProjectStore.setState(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: only currentProject/switchProject are read
    {
      currentProject: currentProjectId === null ? null : { id: currentProjectId },
      switchProject,
    } as Partial<ReturnType<typeof useProjectStore.getState>>
  );
}

function openRun(args: { runId: string; workspaceId: string }): Promise<unknown> {
  const actions: ActionRegistry = new Map();
  registerProjectActions(actions, NO_CALLBACKS);
  return actions.get("pilot.openRun")!().run(args, NO_CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatchMock.mockResolvedValue({ ok: true });
  usePilotStore.setState({ isOpen: true });
  seedProject("here");
});

describe("pilot.openRun", () => {
  it("focuses directly when the run is already in the active project", async () => {
    await openRun({ runId: "t1", workspaceId: "here" });

    expect(dispatchMock).toHaveBeenCalledWith("panel.focus", { panelId: "t1" });
    // Switching to the project you are already in would tear down and rebuild
    // the very view holding the target.
    expect(switchProject).not.toHaveBeenCalled();
  });

  it("switches project and carries the target panel across", async () => {
    await openRun({ runId: "t9", workspaceId: "elsewhere" });

    expect(switchProject).toHaveBeenCalledWith("elsewhere", {
      focusIntent: { intent: "focus-panel", panelId: "t9" },
    });
    // The focus must ride the switch — this context dies with it, so a local
    // dispatch afterwards would land in a view that is no longer active.
    expect(dispatchMock).not.toHaveBeenCalledWith("panel.focus", { panelId: "t9" });
  });

  it("closes the overview on either successful path", async () => {
    await openRun({ runId: "t1", workspaceId: "here" });
    expect(usePilotStore.getState().isOpen).toBe(false);

    usePilotStore.setState({ isOpen: true });
    await openRun({ runId: "t9", workspaceId: "elsewhere" });
    expect(usePilotStore.getState().isOpen).toBe(false);
  });

  it("stays open when the run no longer exists to focus", async () => {
    // An agent can exit between the list rendering and the click. Closing
    // regardless would drop the user back where they started with the overview
    // gone and nothing explaining why.
    dispatchMock.mockResolvedValue({ ok: false });

    await openRun({ runId: "gone", workspaceId: "here" });

    expect(usePilotStore.getState().isOpen).toBe(true);
  });

  it("treats a run with no active project as cross-project", async () => {
    seedProject(null);

    await openRun({ runId: "t1", workspaceId: "somewhere" });

    expect(switchProject).toHaveBeenCalledWith("somewhere", {
      focusIntent: { intent: "focus-panel", panelId: "t1" },
    });
  });
});
