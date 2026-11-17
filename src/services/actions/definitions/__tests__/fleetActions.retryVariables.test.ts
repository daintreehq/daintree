// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { PtyPanelData } from "@shared/types/panel";
import type { ActionId } from "@shared/types/actions";
import type { WorktreeSnapshot } from "@shared/types";

// The real fleet pipeline runs here, from the first send to the retry; only
// the write to a terminal is stood in for.
const submitMock = vi.fn<(id: string, text: string, images: string[]) => Promise<void>>();

vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    terminalClient: {
      ...actual.terminalClient,
      submit: (id: string, text: string) => submitMock(id, text, []),
      submitWithImages: (id: string, text: string, paths: string[]) => submitMock(id, text, paths),
    },
  };
});

const { useFleetArmingStore } = await import("@/store/fleetArmingStore");
const { useFleetFailureStore } = await import("@/store/fleetFailureStore");
const { useFleetTargetOverridesStore, __resetFleetTargetOverridesStoreForTesting } =
  await import("@/store/fleetTargetOverridesStore");
const { useFleetRunStore } = await import("@/store/fleetRunStore");
const { useTerminalInputStore } = await import("@/store/terminalInputStore");
const { useLastComposerSendStore } = await import("@/store/lastComposerSendStore");
const { usePanelStore } = await import("@/store/panelStore");
const { setCurrentViewStore } = await import("@/store/createWorktreeStore");
const { tryFleetBroadcastFromEditor } = await import("@/components/Fleet/fleetEnterBroadcast");
const { registerFleetActions } = await import("../fleetActions");
await import("../fleetActions.impl");

type ActionRegistry = Awaited<
  ReturnType<typeof import("@/services/actions/actionDefinitions").createActionDefinitions>
>;

function makeAgent(id: string, worktreeId: string): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    detectedAgentId: "claude",
    worktreeId,
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
  } as PtyPanelData;
}

function installWorktrees(branches: Record<string, string>): void {
  const worktrees = new Map<string, WorktreeSnapshot>(
    Object.entries(branches).map(([id, branch]) => [
      id,
      { id, worktreeId: id, name: id, path: `/repo/${id}`, branch } as WorktreeSnapshot,
    ])
  );
  setCurrentViewStore(
    createStore(() => ({ worktrees })) as unknown as Parameters<typeof setCurrentViewStore>[0]
  );
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function retryFailures(): Promise<void> {
  const registry: ActionRegistry = new Map();
  registerFleetActions(registry);
  await registry.get("fleet.retryFailures" as ActionId)!().run(undefined as never, {} as never);
}

/** Every write made, whoever it went to, so a stray one can't hide. */
function writes(): Array<{ id: string; text: string; images: string[] }> {
  return submitMock.mock.calls
    .map(([id, text, images]) => ({ id, text, images }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function failWritesTo(...ids: string[]): void {
  // Out of disk, a failure worth retrying.
  submitMock.mockImplementation(async (id) => {
    if (ids.includes(id)) throw new Error("ENOSPC: disk full");
  });
}

function writesNowSucceed(): void {
  submitMock.mockReset();
  submitMock.mockResolvedValue(undefined);
}

describe("fleet.retryFailures — recipe variables after a failed write (#17513)", () => {
  beforeEach(() => {
    submitMock.mockReset();
    submitMock.mockResolvedValue(undefined);
    useFleetArmingStore.setState({
      armedIds: new Set<string>(),
      armOrder: [],
      armOrderById: {},
      lastArmedId: null,
      crossHostTargets: [],
    });
    useFleetFailureStore.getState().clear();
    __resetFleetTargetOverridesStoreForTesting();
    useFleetRunStore.getState()._reset();
    useTerminalInputStore.setState({ sentPrompts: new Map() });
    useLastComposerSendStore.setState({ sends: {} });
    installWorktrees({ "wt-alpha": "feature/alpha", "wt-beta": "feature/beta" });
    const agents = [
      makeAgent("origin", "wt-alpha"),
      makeAgent("beta", "wt-beta"),
      makeAgent("literal", "wt-beta"),
    ];
    usePanelStore.setState({
      panelsById: Object.fromEntries(agents.map((a) => [a.id, a])),
      panelIds: agents.map((a) => a.id),
      focusedId: null,
    });
    useFleetArmingStore.getState().armIds(agents.map((a) => a.id));
    Object.assign(window, {
      electron: {
        notification: { playUiEvent: vi.fn().mockResolvedValue(undefined) },
        runHistory: { append: vi.fn().mockResolvedValue(undefined) },
      },
    });
  });

  afterEach(() => {
    useFleetFailureStore.getState().clear();
  });

  it("resends each target its own branch, and a deliberately literal edit as it was written", async () => {
    useFleetTargetOverridesStore
      .getState()
      .setPayloadOverride("literal", "Review {{branch_name}} (literally)");
    failWritesTo("beta", "literal");
    tryFleetBroadcastFromEditor("origin", "Review {{branch_name}}", vi.fn());
    await flush();

    expect(writes()).toEqual([
      { id: "beta", text: "Review feature/beta", images: [] },
      { id: "literal", text: "Review {{branch_name}} (literally)", images: [] },
      { id: "origin", text: "Review feature/alpha", images: [] },
    ]);
    expect([...useFleetFailureStore.getState().failedIds].sort()).toEqual(["beta", "literal"]);
    expect(useFleetRunStore.getState().run?.isRetry).toBe(false);

    writesNowSucceed();
    await retryFailures();

    expect(writes()).toEqual([
      { id: "beta", text: "Review feature/beta", images: [] },
      { id: "literal", text: "Review {{branch_name}} (literally)", images: [] },
    ]);
    expect(useFleetFailureStore.getState().failedIds.size).toBe(0);
    // The retry's run is labelled with the draft the person wrote.
    expect(useFleetRunStore.getState().run).toMatchObject({
      isRetry: true,
      draftPreview: "Review {{branch_name}}",
    });
  });

  it("fills in each failed target's own branch when two on different ones fail", async () => {
    failWritesTo("origin", "beta");
    tryFleetBroadcastFromEditor("literal", "Review {{branch_name}}", vi.fn());
    await flush();
    expect([...useFleetFailureStore.getState().failedIds].sort()).toEqual(["beta", "origin"]);

    writesNowSucceed();
    await retryFailures();

    expect(writes()).toEqual([
      { id: "beta", text: "Review feature/beta", images: [] },
      { id: "origin", text: "Review feature/alpha", images: [] },
    ]);
  });

  it("attaches the draft's image again to an unedited target, and sends an emptied edit as empty", async () => {
    useFleetTargetOverridesStore.getState().setPayloadOverride("literal", "");
    failWritesTo("beta", "literal");
    tryFleetBroadcastFromEditor(
      "origin",
      "Review {{branch_name}} /tmp/shot.png",
      vi.fn(),
      undefined,
      ["/tmp/shot.png"]
    );
    await flush();
    expect(writes()).toEqual([
      { id: "beta", text: "Review feature/beta /tmp/shot.png", images: ["/tmp/shot.png"] },
      { id: "literal", text: "", images: [] },
      { id: "origin", text: "Review feature/alpha /tmp/shot.png", images: ["/tmp/shot.png"] },
    ]);
    expect([...useFleetFailureStore.getState().failedIds].sort()).toEqual(["beta", "literal"]);

    writesNowSucceed();
    await retryFailures();

    expect(writes()).toEqual([
      { id: "beta", text: "Review feature/beta /tmp/shot.png", images: ["/tmp/shot.png"] },
      { id: "literal", text: "", images: [] },
    ]);
  });
});
