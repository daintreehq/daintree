import { beforeEach, describe, expect, it, vi } from "vitest";

const viewWorkspaceId = vi.hoisted(() => ({ current: null as string | null }));
vi.mock("@/store/viewWorkspaceId", () => ({
  getViewWorkspaceId: () => viewWorkspaceId.current,
}));

import { registerProjectActions } from "../../../services/actions/definitions/projectActions";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { usePilotStore } from "@/store/pilotStore";
import { resetStoreAccessorsForTesting, setWorktreeIdSetAccessor } from "@/store/storeAccessors";
import type { ActionCallbacks, ActionRegistry } from "@/services/actions/actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { FleetRunRow } from "@shared/types/ipc/fleet";

/**
 * Real id shapes. Routing elsewhere in this family is decided by shape (a
 * scratch id is a UUIDv4, a project id 64 hex characters), so a placeholder
 * would exercise a path the app never takes.
 */
const PROJECT_HERE = "a".repeat(64);
const PROJECT_ELSEWHERE = "b".repeat(64);
const SCRATCH_HERE = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** The project root, which carries a worktree id like any other checkout. */
const ROOT = "/repo";

const NOW = 1_830_000_000_000;

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: openProject uses no callbacks
const NO_CALLBACKS = {} as ActionCallbacks;
const NO_CTX = {} as ActionContext;

function run(overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    runId: "t1",
    workspaceId: PROJECT_HERE,
    spawnedAt: NOW - 3_600_000,
    cwd: "/repo",
    ...overrides,
  };
}

/** The workspace this VIEW owns — the only identity the action may trust. */
function seedView(workspaceId: string | null): void {
  viewWorkspaceId.current = workspaceId;
}

/**
 * The worktrees the VIEW's own store knows about — the project's real topology,
 * which the fleet snapshot cannot report because it only carries agent runs.
 * `null` is a view with no store mounted, which is what a bare test process has.
 */
function seedWorktrees(ids: string[] | null): void {
  setWorktreeIdSetAccessor(() => (ids === null ? null : new Set(ids)));
}

function seedFleet(runs: FleetRunRow[] | null): void {
  useFleetSnapshotStore.setState({
    snapshot:
      runs === null ? null : { runs, changedAt: NOW, degraded: false, lastSuccessfulAt: NOW },
  });
}

function openProject(): Promise<unknown> {
  const actions: ActionRegistry = new Map();
  registerProjectActions(actions, NO_CALLBACKS);
  return actions.get("pilot.openProject")!().run(undefined, NO_CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStoreAccessorsForTesting();
  usePilotStore.setState({ isOpen: false, scope: { kind: "fleet" }, fellBackFrom: null });
  // The globally-replicated pointers, deliberately seeded to CONTRADICT the
  // view below, so a regression that reads either of them fails loudly.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: only the pointer's id matters, and the action must not read it at all
  useProjectStore.setState({ currentProject: { id: PROJECT_ELSEWHERE } } as Partial<
    ReturnType<typeof useProjectStore.getState>
  >);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: as above, for the scratch pointer
  useScratchStore.setState({ currentScratch: { id: SCRATCH_HERE } } as Partial<
    ReturnType<typeof useScratchStore.getState>
  >);
  seedView(PROJECT_HERE);
  seedFleet([]);
});

describe("pilot.openProject", () => {
  it("scopes to the workspace this view owns, not the global current project", () => {
    // `currentProject` is replicated to every view including cached ones, so it
    // names what the app is globally pointed at rather than the project whose
    // agents the user asked to see.
    seedFleet([
      run({ runId: "a", worktreeId: "/repo/wt/alpha" }),
      run({ runId: "b", worktreeId: "/repo/wt/beta" }),
    ]);

    return openProject().then(() => {
      expect(usePilotStore.getState().scope).toEqual({
        kind: "project",
        workspaceId: PROJECT_HERE,
      });
    });
  });

  it("ignores runs belonging to other workspaces when judging the axis", async () => {
    // Two worktrees in a project this view does not own must not make this
    // one look drillable.
    seedFleet([
      run({ runId: "here", worktreeId: "/repo/wt/alpha" }),
      run({ runId: "a", workspaceId: PROJECT_ELSEWHERE, worktreeId: "/other/wt/a" }),
      run({ runId: "b", workspaceId: PROJECT_ELSEWHERE, worktreeId: "/other/wt/b" }),
    ]);

    await openProject();

    expect(usePilotStore.getState()).toMatchObject({ isOpen: true, scope: { kind: "fleet" } });
  });

  it("falls back to the whole fleet when every run shares one worktree", async () => {
    // Scoping here would regroup the project into a single section holding the
    // rows it already had.
    seedFleet([
      run({ runId: "a", worktreeId: "/repo/wt/alpha" }),
      run({ runId: "b", worktreeId: "/repo/wt/alpha" }),
    ]);

    await openProject();

    expect(usePilotStore.getState()).toMatchObject({ isOpen: true, scope: { kind: "fleet" } });
  });

  it("falls back for a project worked only in its own root", async () => {
    // A root launch DOES carry a worktree id — the project root path (#11957) —
    // so this is one bucket by both counts: one worktree in the store, one
    // among the runs. There is no axis to cut on either way.
    seedWorktrees([ROOT]);
    seedFleet([run({ runId: "a", worktreeId: ROOT }), run({ runId: "b", worktreeId: ROOT })]);

    await openProject();

    // `isOpen` too: the scope starts on the fleet, so asserting it alone would
    // pass for an action that did nothing whatsoever.
    expect(usePilotStore.getState()).toMatchObject({ isOpen: true, scope: { kind: "fleet" } });
  });

  it("falls back in a scratch view", async () => {
    // A scratch directory is not a git worktree, so its runs never carry an id
    // — which lands them all in one bucket and takes this path for free.
    seedView(SCRATCH_HERE);
    seedFleet([
      run({ runId: "a", workspaceId: SCRATCH_HERE }),
      run({ runId: "b", workspaceId: SCRATCH_HERE }),
    ]);

    await openProject();

    expect(usePilotStore.getState()).toMatchObject({ isOpen: true, scope: { kind: "fleet" } });
  });

  it("refuses a worktree count in a scratch view even where one is on offer", async () => {
    // The accessor is unparameterized current-view state. A scratch is not a
    // git repository, so no count of its worktrees can be anything but zero
    // whatever a store happens to be holding at the time.
    seedView(SCRATCH_HERE);
    seedWorktrees(["/repo/wt/alpha", "/repo/wt/beta", "/repo/wt/gamma"]);
    seedFleet([run({ runId: "a", workspaceId: SCRATCH_HERE })]);

    await openProject();

    expect(usePilotStore.getState()).toMatchObject({ isOpen: true, scope: { kind: "fleet" } });
  });

  it("falls back when the project has no runs", async () => {
    // The rule that makes an empty scoped list unreachable.
    seedFleet([run({ runId: "a", workspaceId: PROJECT_ELSEWHERE, worktreeId: "/o/a" })]);

    await openProject();

    expect(usePilotStore.getState()).toMatchObject({ isOpen: true, scope: { kind: "fleet" } });
  });

  it("falls back before the fleet has been read", async () => {
    // Nothing is known yet, so nothing can be proven drillable. Opening the
    // fleet still shows the user the surface they asked for.
    seedFleet(null);

    await openProject();

    expect(usePilotStore.getState()).toMatchObject({ isOpen: true, scope: { kind: "fleet" } });
  });

  it("falls back when the view has no workspace identity", async () => {
    seedView(null);
    seedFleet([run({ runId: "a", worktreeId: "/repo/wt/alpha" })]);

    await openProject();

    expect(usePilotStore.getState()).toMatchObject({ isOpen: true, scope: { kind: "fleet" } });
  });

  it("counts the absent worktree as a bucket, so root plus one worktree scopes", async () => {
    // A root-launched agent beside a worktree one is exactly the split the
    // scoped view exists to draw.
    seedFleet([run({ runId: "root" }), run({ runId: "wt", worktreeId: "/repo/wt/alpha" })]);

    await openProject();

    expect(usePilotStore.getState().scope).toEqual({
      kind: "project",
      workspaceId: PROJECT_HERE,
    });
  });

  it("closes when it is already scoped here", async () => {
    // The sibling chord's second press, matching `pilot.toggle`. A key that
    // reopened the surface already on screen would visibly do nothing.
    seedFleet([
      run({ runId: "a", worktreeId: "/repo/wt/alpha" }),
      run({ runId: "b", worktreeId: "/repo/wt/beta" }),
    ]);
    usePilotStore.setState({ isOpen: true, scope: { kind: "project", workspaceId: PROJECT_HERE } });

    await openProject();

    expect(usePilotStore.getState().isOpen).toBe(false);
  });

  it("scopes rather than closing when the overview is open on another project", async () => {
    seedFleet([
      run({ runId: "a", worktreeId: "/repo/wt/alpha" }),
      run({ runId: "b", worktreeId: "/repo/wt/beta" }),
    ]);
    usePilotStore.setState({
      isOpen: true,
      scope: { kind: "project", workspaceId: PROJECT_ELSEWHERE },
    });

    await openProject();

    expect(usePilotStore.getState()).toMatchObject({
      isOpen: true,
      scope: { kind: "project", workspaceId: PROJECT_HERE },
    });
  });

  it("scopes rather than closing when the overview is open on the fleet", async () => {
    seedFleet([
      run({ runId: "a", worktreeId: "/repo/wt/alpha" }),
      run({ runId: "b", worktreeId: "/repo/wt/beta" }),
    ]);
    usePilotStore.setState({ isOpen: true, scope: { kind: "fleet" } });

    await openProject();

    expect(usePilotStore.getState().scope).toEqual({
      kind: "project",
      workspaceId: PROJECT_HERE,
    });
  });

  it("scopes off a retained snapshot rather than refusing", async () => {
    // A degraded feed still holds real rows, and the surface says how old they
    // are — refusing to scope would hide a narrowing the data can support.
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [
          run({ runId: "a", worktreeId: "/repo/wt/alpha" }),
          run({ runId: "b", worktreeId: "/repo/wt/beta" }),
        ],
        changedAt: NOW,
        degraded: true,
        lastSuccessfulAt: NOW - 600_000,
      },
    });

    await openProject();

    expect(usePilotStore.getState().scope).toEqual({
      kind: "project",
      workspaceId: PROJECT_HERE,
    });
  });
});

describe("pilot.openProject against the project's own worktrees", () => {
  it("scopes where every agent shares one worktree but the project has three", async () => {
    // The measured bug (#11957): a fleet row exists only for a terminal
    // classified an agent, so drillability tracked where agents happened to be
    // sitting. Four of five real projects fell back on this.
    seedWorktrees([ROOT, "/repo/wt/alpha", "/repo/wt/beta"]);
    seedFleet([
      run({ runId: "a", worktreeId: "/repo/wt/alpha" }),
      run({ runId: "b", worktreeId: "/repo/wt/alpha" }),
    ]);

    await openProject();

    expect(usePilotStore.getState().scope).toEqual({
      kind: "project",
      workspaceId: PROJECT_HERE,
    });
  });

  it("keeps the chord working when the second agent exits", async () => {
    // Closing an agent used to take the shortcut away with nothing to say so.
    seedWorktrees([ROOT, "/repo/wt/alpha"]);
    seedFleet([run({ runId: "a", worktreeId: ROOT })]);

    await openProject();

    expect(usePilotStore.getState().scope).toEqual({
      kind: "project",
      workspaceId: PROJECT_HERE,
    });
  });

  it("scopes a project with no agents at all once its worktrees prove the axis", async () => {
    // "None here yet" answers the question the user asked. The whole fleet
    // answers a different one.
    seedWorktrees([ROOT, "/repo/wt/alpha"]);
    seedFleet([run({ runId: "x", workspaceId: PROJECT_ELSEWHERE, worktreeId: "/o/a" })]);

    await openProject();

    expect(usePilotStore.getState().scope).toEqual({
      kind: "project",
      workspaceId: PROJECT_HERE,
    });
  });

  it("scopes even where the store and the runs spell the same worktree differently", async () => {
    // The rule the fix has to keep: a worktree id has two mint sites that can
    // spell one directory differently (`realpath` at creation, `pathResolve`
    // over porcelain at enumeration), so the two sources are OR'd as counts and
    // their ids never meet. A join here would find nothing and refuse.
    seedWorktrees(["/private/repo", "/private/repo/wt/alpha"]);
    seedFleet([run({ runId: "a", worktreeId: "/repo/wt/alpha" })]);

    await openProject();

    expect(usePilotStore.getState().scope).toEqual({
      kind: "project",
      workspaceId: PROJECT_HERE,
    });
  });

  it("falls back where the project has exactly one worktree", async () => {
    // The root is a first-class entry in that count, so one means root-only.
    seedWorktrees([ROOT]);
    seedFleet([run({ runId: "a", worktreeId: ROOT })]);

    await openProject();

    expect(usePilotStore.getState()).toMatchObject({ isOpen: true, scope: { kind: "fleet" } });
  });
});

describe("pilot.openProject fallback explanation", () => {
  it("names the project it could not scope to", async () => {
    // The fleet it lands on is byte for byte what the unscoped chord gives, so
    // without this the key is indistinguishable from a dead one.
    seedWorktrees([ROOT]);
    seedFleet([run({ runId: "a", worktreeId: ROOT })]);

    await openProject();

    expect(usePilotStore.getState().fellBackFrom).toBe(PROJECT_HERE);
  });

  it("says nothing when the project's own worktrees have not been read yet", async () => {
    // A project carries its own root the moment its view store hydrates, so a
    // zero is "not told yet". Claiming a project has nothing to group on the
    // strength of an answer nobody gave is the explanation lying.
    seedWorktrees([]);
    seedFleet([run({ runId: "a", worktreeId: ROOT })]);

    await openProject();

    expect(usePilotStore.getState()).toMatchObject({
      isOpen: true,
      scope: { kind: "fleet" },
      fellBackFrom: null,
    });
  });

  it("still explains itself for a scratch, whose none is a real none", async () => {
    // A scratch is not a git repository, so zero worktrees there is an answer
    // rather than a silence — and the user still pressed a key.
    seedView(SCRATCH_HERE);
    seedFleet([run({ runId: "a", workspaceId: SCRATCH_HERE })]);

    await openProject();

    expect(usePilotStore.getState().fellBackFrom).toBe(SCRATCH_HERE);
  });

  it("says nothing when the fleet has not been read yet", async () => {
    // Nothing was decided, so there is nothing to explain — an explanation here
    // would blame a project for a snapshot that has not arrived.
    seedFleet(null);

    await openProject();

    expect(usePilotStore.getState()).toMatchObject({ isOpen: true, fellBackFrom: null });
  });

  it("says nothing when the view has no workspace identity", async () => {
    seedView(null);
    seedFleet([run({ runId: "a", worktreeId: "/repo/wt/alpha" })]);

    await openProject();

    expect(usePilotStore.getState()).toMatchObject({ isOpen: true, fellBackFrom: null });
  });

  it("says nothing when the scope succeeds", async () => {
    seedFleet([
      run({ runId: "a", worktreeId: "/repo/wt/alpha" }),
      run({ runId: "b", worktreeId: "/repo/wt/beta" }),
    ]);

    await openProject();

    expect(usePilotStore.getState().fellBackFrom).toBeNull();
  });

  it("clears a stale explanation when a later press does scope", async () => {
    seedWorktrees([ROOT]);
    seedFleet([run({ runId: "a", worktreeId: ROOT })]);
    await openProject();

    seedWorktrees([ROOT, "/repo/wt/alpha"]);
    await openProject();

    expect(usePilotStore.getState()).toMatchObject({
      scope: { kind: "project", workspaceId: PROJECT_HERE },
      fellBackFrom: null,
    });
  });
});
