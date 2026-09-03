/**
 * The write half of a plugin panel's `extensionState`.
 *
 * Before this, the bag was spawn-time only: a view read it as
 * `PanelViewProps.initialArgs` and had no way to update it, so a plugin-authored
 * file browser forgot its expansion, selection and root every time the user
 * maximized a sibling pane. Covered here: the merge semantics a view relies on,
 * the guards that keep an unbounded or unserializable bag off the layout-save
 * path, and the no-op short-circuit that makes persisting from a render-derived
 * effect free.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FilePanelData, PanelInstance } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

const logWarnMock = vi.fn();
vi.mock("@/utils/logger", () => ({
  logWarn: logWarnMock,
  logError: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

const saveMock = vi.fn();
vi.mock("../../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: saveMock,
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { usePanelStore } = await import("../../../panelStore");
const { MAX_EXTENSION_STATE_BYTES } = await import("../extensionState");

function makePluginPanel(overrides: Partial<PanelInstance> = {}): PanelInstance {
  // `PanelInstance` is a closed union of the built-in kinds, so a
  // plugin-contributed kind cannot be expressed in it — the same reason
  // `panel.openPluginPanel` widens at its own spawn boundary. Widening here is
  // what lets this suite exercise the plugin-owned branch at all.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- documented extension-panel boundary
  return {
    id: "p1",
    kind: "acme.explorer",
    title: "Explorer",
    location: "grid",
    pluginId: "acme.explorer-plugin",
    ...overrides,
  } as PanelInstance;
}

function seed(panels: PanelInstance[]): void {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
  });
}

function stateOf(id: string): Record<string, unknown> | undefined {
  return usePanelStore.getState().panelsById[id]?.extensionState;
}

describe("setPanelExtensionState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      electron: {},
    });
    seed([makePluginPanel()]);
  });

  it("seeds state onto a panel that has none", () => {
    usePanelStore.getState().setPanelExtensionState("p1", { root: "src" });

    expect(stateOf("p1")).toEqual({ root: "src" });
  });

  it("merges rather than replaces, so independent keys coexist", () => {
    const store = usePanelStore.getState();
    store.setPanelExtensionState("p1", { root: "src", expanded: ["src"] });
    store.setPanelExtensionState("p1", { selected: "src/index.ts" });

    // A view persisting its selection must not wipe the expansion another part
    // of the same view persisted.
    expect(stateOf("p1")).toEqual({
      root: "src",
      expanded: ["src"],
      selected: "src/index.ts",
    });
  });

  it("removes a key set to undefined", () => {
    const store = usePanelStore.getState();
    store.setPanelExtensionState("p1", { root: "src", selected: "a.ts" });
    store.setPanelExtensionState("p1", { selected: undefined });

    // The only way to shrink the bag, since every other write merges.
    expect(stateOf("p1")).toEqual({ root: "src" });
  });

  it("preserves the spawn arguments a panel was opened with", () => {
    seed([makePluginPanel({ extensionState: { path: "/repo/a.ts" } })]);
    usePanelStore.getState().setPanelExtensionState("p1", { scroll: 40 });

    // `initialArgs` and persisted view state are one bag, so persisting must
    // not discard what the panel was spawned with.
    expect(stateOf("p1")).toEqual({ path: "/repo/a.ts", scroll: 40 });
  });

  it("does not touch the store or schedule a save for an unchanged write", () => {
    const store = usePanelStore.getState();
    store.setPanelExtensionState("p1", { root: "src" });
    const afterFirst = usePanelStore.getState().panelsById["p1"];
    saveMock.mockClear();

    store.setPanelExtensionState("p1", { root: "src" });

    // Persisting from a render-derived effect is a normal shape, so an
    // identical write must be free — same record identity, no layout save.
    expect(usePanelStore.getState().panelsById["p1"]).toBe(afterFirst);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("refuses an update larger than the persisted-state ceiling", () => {
    const store = usePanelStore.getState();
    store.setPanelExtensionState("p1", { root: "src" });

    store.setPanelExtensionState("p1", { blob: "x".repeat(MAX_EXTENSION_STATE_BYTES) });

    // The bag rides the panel record into every layout save, so an oversized
    // write is dropped rather than amplifying a path the user never sees.
    expect(stateOf("p1")).toEqual({ root: "src" });
    expect(logWarnMock).toHaveBeenCalled();
  });

  it("refuses a value that cannot round-trip through JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    usePanelStore.getState().setPanelExtensionState("p1", { cyclic });

    // Left to the layout save, this would surface as a persistence bug rather
    // than as a plugin handing us something unserializable.
    expect(stateOf("p1")).toBeUndefined();
    expect(logWarnMock).toHaveBeenCalled();
  });

  it("ignores a panel that is not plugin-owned", () => {
    const builtin: FilePanelData = {
      id: "builtin",
      kind: "file",
      title: "File",
      location: "grid",
      filePath: "/repo/a.md",
    };
    seed([builtin]);

    usePanelStore.getState().setPanelExtensionState("builtin", { root: "src" });

    // Built-in kinds reach their state through typed setters whose serializers
    // do not expect an arbitrary bag.
    expect(stateOf("builtin")).toBeUndefined();
  });

  it("reports whether the stored state is now what the caller asked for", () => {
    const store = usePanelStore.getState();

    expect(store.setPanelExtensionState("p1", { root: "src" })).toBe(true);
    // An idempotent re-persist is a success: the desired state IS stored, and
    // reporting failure would make every render-derived write look rejected.
    expect(store.setPanelExtensionState("p1", { root: "src" })).toBe(true);

    expect(store.setPanelExtensionState("gone", { root: "src" })).toBe(false);
    expect(
      store.setPanelExtensionState("p1", { blob: "x".repeat(MAX_EXTENSION_STATE_BYTES) })
    ).toBe(false);
  });

  it("detaches stored state from the object the caller passed", () => {
    const patch = { expanded: ["src"] };
    usePanelStore.getState().setPanelExtensionState("p1", patch);

    patch.expanded.push("src/deep");

    // Keeping the caller's reference would let a plugin mutate store state
    // behind the setter — skipping validation, the size cap and every
    // subscriber, and diverging from what a restart would restore.
    expect(stateOf("p1")).toEqual({ expanded: ["src"] });
  });

  it("stores the canonical JSON form rather than the value handed in", () => {
    const store = usePanelStore.getState();
    store.setPanelExtensionState("p1", { when: new Date("2020-01-01T00:00:00.000Z") });
    store.setPanelExtensionState("p1", { ratio: Number.NaN });

    // These convert on the way to disk regardless. Converting here means a view
    // reads the same value back on remount as it would after a restart, rather
    // than a `Date` that silently becomes a string overnight.
    expect(stateOf("p1")).toEqual({ when: "2020-01-01T00:00:00.000Z", ratio: null });
  });

  it("rejects a value whose toJSON yields nothing", () => {
    // `JSON.stringify` returns `undefined` here rather than throwing, so a
    // length check on the result would crash inside the store updater.
    const patch = { odd: { toJSON: () => undefined } };

    expect(() => usePanelStore.getState().setPanelExtensionState("p1", patch)).not.toThrow();
    expect(stateOf("p1")).toBeUndefined();
  });

  it("measures the size cap in bytes, not UTF-16 code units", () => {
    // Two bytes per code unit in UTF-16, three in UTF-8: a string that measures
    // comfortably under the cap by `String.length` is well over it encoded.
    const wide = "字".repeat(Math.floor((MAX_EXTENSION_STATE_BYTES * 2) / 3));

    expect(usePanelStore.getState().setPanelExtensionState("p1", { wide })).toBe(false);
    expect(stateOf("p1")).toBeUndefined();
  });

  it("lets an already-oversized bag be shrunk", () => {
    // Spawn arguments do not pass through this setter, so a panel can arrive
    // over the cap. Refusing every write would lock the plugin out of the only
    // action that could fix it.
    seed([
      makePluginPanel({
        extensionState: { huge: "x".repeat(MAX_EXTENSION_STATE_BYTES * 2), keep: 1 },
      }),
    ]);

    const store = usePanelStore.getState();
    // Still over the cap, but strictly smaller — accepted as progress.
    expect(
      store.setPanelExtensionState("p1", { huge: "x".repeat(MAX_EXTENSION_STATE_BYTES + 100) })
    ).toBe(true);
    // And a write that does not shrink it is still refused.
    expect(
      store.setPanelExtensionState("p1", { huge: "x".repeat(MAX_EXTENSION_STATE_BYTES * 3) })
    ).toBe(false);
    // Dropping the offender brings it back under and succeeds.
    expect(store.setPanelExtensionState("p1", { huge: undefined })).toBe(true);
    expect(stateOf("p1")).toEqual({ keep: 1 });
  });

  it("ignores an unknown panel id", () => {
    expect(() =>
      usePanelStore.getState().setPanelExtensionState("gone", { root: "src" })
    ).not.toThrow();
    expect(usePanelStore.getState().panelsById["gone"]).toBeUndefined();
  });
});
