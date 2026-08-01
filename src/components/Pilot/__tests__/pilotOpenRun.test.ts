import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/ActionService", async () => {
  const actual = await vi.importActual<typeof import("@/services/ActionService")>(
    "@/services/ActionService"
  );
  return { ...actual, actionService: { dispatch: dispatchMock } };
});

const viewWorkspaceId = vi.hoisted(() => ({ current: null as string | null }));
vi.mock("@/store/viewWorkspaceId", () => ({
  getViewWorkspaceId: () => viewWorkspaceId.current,
}));

import { registerProjectActions } from "../../../services/actions/definitions/projectActions";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { usePilotStore } from "@/store/pilotStore";
import type { ActionCallbacks, ActionRegistry } from "@/services/actions/actionTypes";
import type { ActionContext } from "@shared/types/actions";

const switchProject = vi.fn(async () => {});
const switchScratch = vi.fn(async () => {});

/**
 * Real id shapes, because routing is decided by shape.
 *
 * A scratch id is a UUIDv4 and a project id is 64 hex characters; the two spaces
 * are disjoint, which is what lets one snapshot carry both. Testing with
 * placeholder strings like "scratch-b" would exercise a path the app never
 * takes and would pass while the real routing was broken.
 */
const SCRATCH_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SCRATCH_B = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
const SCRATCH_C = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";
const PROJECT_HERE = "a".repeat(64);
const PROJECT_ELSEWHERE = "b".repeat(64);

/**
 * Only the fields `pilot.openRun` reads. The registrar takes the full callback
 * bag and the full stores, none of which this action touches, so the carriers
 * stay deliberately minimal rather than mocking surfaces that play no part in
 * the behaviour under test.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: openRun uses no callbacks
const NO_CALLBACKS = {} as ActionCallbacks;
const NO_CTX = {} as ActionContext;

/** The workspace this VIEW owns — the only identity `pilot.openRun` may trust. */
function seedView(workspaceId: string | null): void {
  viewWorkspaceId.current = workspaceId;
}

function seedScratches(ids: string[]): void {
  useScratchStore.setState(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: only ids and switchScratch are read
    {
      scratches: ids.map((id) => ({ id })),
      switchScratch,
    } as unknown as Partial<ReturnType<typeof useScratchStore.getState>>
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
  // Carrier: only `switchProject` is read by the action under test.
  useProjectStore.setState({ switchProject } as Partial<
    ReturnType<typeof useProjectStore.getState>
  >);
  seedScratches([]);
  seedView(PROJECT_HERE);
});

describe("pilot.openRun", () => {
  it("focuses directly when the run is already in this view's workspace", async () => {
    await openRun({ runId: "t1", workspaceId: PROJECT_HERE });

    expect(dispatchMock).toHaveBeenCalledWith("panel.focus", { panelId: "t1" });
    // Switching to the workspace you are already in would tear down and rebuild
    // the very view holding the target.
    expect(switchProject).not.toHaveBeenCalled();
    expect(switchScratch).not.toHaveBeenCalled();
  });

  it("switches project and carries the target panel across", async () => {
    await openRun({ runId: "t9", workspaceId: PROJECT_ELSEWHERE });

    expect(switchProject).toHaveBeenCalledWith(PROJECT_ELSEWHERE, {
      focusIntent: { intent: "focus-panel", panelId: "t9" },
    });
    // The focus must ride the switch — this context dies with it, so a local
    // dispatch afterwards would land in a view that is no longer active.
    expect(dispatchMock).not.toHaveBeenCalledWith("panel.focus", { panelId: "t9" });
  });

  it("focuses in place for a run in the scratch this view already owns", async () => {
    // A scratch view has no current PROJECT at all, so reading the project
    // pointer sent a run that was already on screen through a full switch.
    seedView(SCRATCH_A);
    seedScratches([SCRATCH_A]);

    await openRun({ runId: "t1", workspaceId: SCRATCH_A });

    expect(dispatchMock).toHaveBeenCalledWith("panel.focus", { panelId: "t1" });
    expect(switchScratch).not.toHaveBeenCalled();
    expect(switchProject).not.toHaveBeenCalled();
  });

  it("routes a run in another scratch through the scratch switch, not the project one", async () => {
    // Projects and scratches are disjoint id spaces with separate switch
    // handlers; `switchProject` rejects a scratch id outright, which left every
    // scratch run in the overview impossible to open.
    seedScratches([SCRATCH_B]);

    await openRun({ runId: "t7", workspaceId: SCRATCH_B });

    expect(switchScratch).toHaveBeenCalledWith(SCRATCH_B, {
      focusIntent: { intent: "focus-panel", panelId: "t7" },
    });
    expect(switchProject).not.toHaveBeenCalled();
  });

  it("closes the overview on every successful path", async () => {
    await openRun({ runId: "t1", workspaceId: PROJECT_HERE });
    expect(usePilotStore.getState().isOpen).toBe(false);

    usePilotStore.setState({ isOpen: true });
    await openRun({ runId: "t9", workspaceId: PROJECT_ELSEWHERE });
    expect(usePilotStore.getState().isOpen).toBe(false);

    usePilotStore.setState({ isOpen: true });
    seedScratches([SCRATCH_C]);
    await openRun({ runId: "t8", workspaceId: SCRATCH_C });
    expect(usePilotStore.getState().isOpen).toBe(false);
  });

  it("stays open when the run no longer exists to focus", async () => {
    // An agent can exit between the list rendering and the click. Closing
    // regardless would drop the user back where they started with the overview
    // gone and nothing explaining why.
    dispatchMock.mockResolvedValue({ ok: false });

    await openRun({ runId: "gone", workspaceId: PROJECT_HERE });

    expect(usePilotStore.getState().isOpen).toBe(true);
  });

  it("treats a view with no workspace identity as cross-workspace", async () => {
    seedView(null);

    await openRun({ runId: "t1", workspaceId: PROJECT_ELSEWHERE });

    expect(switchProject).toHaveBeenCalledWith(PROJECT_ELSEWHERE, {
      focusIntent: { intent: "focus-panel", panelId: "t1" },
    });
  });
});
