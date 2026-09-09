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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";
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
const { MAX_CLIENT_METADATA_BYTES, MAX_CLIENT_METADATA_DEPTH: MAX_DEPTH } =
  await import("@shared/utils/mcpClientMetadata");

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

/** A plain built-in terminal — no plugin, no plugin kind, ordinary grid panel. */
function makeTerminalPanel(overrides: Partial<PanelInstance> = {}): PanelInstance {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial panel fixture
  return {
    id: "t1",
    kind: "terminal",
    title: "Terminal",
    location: "grid",
    ...overrides,
  } as PanelInstance;
}

function stateOf(id: string): Record<string, unknown> | undefined {
  return usePanelStore.getState().panelsById[id]?.extensionState;
}

function versionOf(id: string): number | undefined {
  return usePanelStore.getState().panelsById[id]?.extensionStateVersion;
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

  it("schedules a layout save for a write that changed something", () => {
    saveMock.mockClear();

    usePanelStore.getState().setPanelExtensionState("p1", { root: "src" });

    // Paired with the no-op case below: asserting only that an unchanged write
    // is free would stay green if the save call were dropped altogether.
    expect(saveMock).toHaveBeenCalled();
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

describe("setPanelExtensionState state versioning (#12280)", () => {
  const KIND = "acme.explorer";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      electron: {},
    });
  });

  afterEach(() => {
    unregisterPanelKind(KIND);
  });

  function registerKind(stateVersion: number | undefined): void {
    registerPanelKind({
      id: KIND,
      name: "Explorer",
      iconId: "folder-tree",
      color: "var(--theme-category-orange)",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "acme.explorer-plugin",
      ...(stateVersion !== undefined ? { stateVersion } : {}),
    });
  }

  it("stamps the registered kind's declared version when the plugin writes", () => {
    registerKind(2);
    seed([makePluginPanel()]);

    usePanelStore.getState().setPanelExtensionState("p1", { root: "src" });

    expect(versionOf("p1")).toBe(2);
  });

  it("re-stamps a legacy bag at the declared version once the plugin rewrites it", () => {
    // The write is what makes the bag current — before it, the stored shape is
    // whatever an older build wrote and must keep reading as legacy.
    registerKind(3);
    seed([makePluginPanel({ extensionState: { root: "old" } })]);
    expect(versionOf("p1")).toBeUndefined();

    usePanelStore.getState().setPanelExtensionState("p1", { root: "new" });

    expect(versionOf("p1")).toBe(3);
  });

  it("clears the stamp when the registered build declares no version", () => {
    // A downgrade to an unversioned build has just written a bag of unknown
    // shape. Keeping the previous build's number would present that rewrite as
    // state the older schema never produced, and skip migration on re-upgrade.
    registerKind(undefined);
    seed([makePluginPanel({ extensionStateVersion: 3 } as Partial<PanelInstance>)]);

    usePanelStore.getState().setPanelExtensionState("p1", { root: "src" });

    expect(versionOf("p1")).toBeUndefined();
  });

  it("carries the stamp forward for a kind the registry cannot answer for", () => {
    // Nothing has written against a schema here, so there is nothing to
    // invalidate — the number still describes the bag on the record.
    seed([makePluginPanel({ extensionStateVersion: 3 } as Partial<PanelInstance>)]);

    usePanelStore.getState().setPanelExtensionState("p1", { root: "src" });

    expect(versionOf("p1")).toBe(3);
  });

  it("advances a stale version even when the migrated bag is byte-identical", () => {
    // A migration whose result matches what it read is still a migration: the
    // plugin has confirmed the bag matches its current schema. Returning early
    // on the content compare would leave the record on the old version and make
    // the plugin migrate the same bag again on every single mount.
    registerKind(2);
    seed([
      makePluginPanel({
        extensionState: { root: "src" },
        extensionStateVersion: 1,
      } as Partial<PanelInstance>),
    ]);

    usePanelStore.getState().setPanelExtensionState("p1", { root: "src" });

    expect(versionOf("p1")).toBe(2);
    expect(stateOf("p1")).toEqual({ root: "src" });
  });

  it("stays free when an identical write is already at the current version", () => {
    // The no-op short-circuit is what makes persisting from a render-derived
    // effect cheap; only a version that actually has to move may bypass it.
    registerKind(2);
    seed([
      makePluginPanel({
        extensionState: { root: "src" },
        extensionStateVersion: 2,
      } as Partial<PanelInstance>),
    ]);
    const before = usePanelStore.getState().panelsById["p1"];

    usePanelStore.getState().setPanelExtensionState("p1", { root: "src" });

    expect(usePanelStore.getState().panelsById["p1"]).toBe(before);
  });
});

/**
 * The write policy an external MCP client reaches (#12340).
 *
 * Deliberately not a relaxation of the plugin gate above but its inverse: the
 * two are disjoint, so the reserved key can never land in a bag a plugin owns
 * and a plugin can never reach a terminal's. What it must not disturb is
 * everything else on the record — `presetEnv` rides this same bag on a
 * terminal, and the version stamp belongs to a schema this caller knows
 * nothing about.
 */
describe("setPanelClientMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      electron: {},
    });
    seed([makeTerminalPanel()]);
  });

  it("stores a record under the reserved key on a built-in terminal", () => {
    const result = usePanelStore.getState().setPanelClientMetadata("t1", { session: "gc-1" });

    expect(result).toEqual({ ok: true, changed: true });
    expect(stateOf("t1")).toEqual({ mcp: { session: "gc-1" } });
  });

  it("preserves the rest of the bag, so a terminal keeps its preset env", () => {
    seed([makeTerminalPanel({ extensionState: { presetEnv: { TOKEN: "x" } } })]);

    usePanelStore.getState().setPanelClientMetadata("t1", { session: "gc-1" });

    // `readPresetEnv` rebuilds a real subprocess environment from this key, and
    // "Run anyway" relaunches the gate from it. Replacing the bag would drop it.
    expect(stateOf("t1")).toEqual({
      presetEnv: { TOKEN: "x" },
      mcp: { session: "gc-1" },
    });
  });

  it("replaces the record wholesale rather than merging into it", () => {
    const store = usePanelStore.getState();
    store.setPanelClientMetadata("t1", { session: "gc-1", role: "reviewer" });
    store.setPanelClientMetadata("t1", { session: "gc-2" });

    // One nullable setter is the whole write surface, so the caller always
    // sends the full record — there is no per-key delete sentinel to confuse
    // with a legitimately stored null.
    expect(stateOf("t1")).toEqual({ mcp: { session: "gc-2" } });
  });

  it("deletes the key on null without touching its neighbours", () => {
    seed([makeTerminalPanel({ extensionState: { presetEnv: { TOKEN: "x" } } })]);
    const store = usePanelStore.getState();
    store.setPanelClientMetadata("t1", { session: "gc-1" });

    expect(store.setPanelClientMetadata("t1", null)).toEqual({ ok: true, changed: true });
    expect(stateOf("t1")).toEqual({ presetEnv: { TOKEN: "x" } });
  });

  it("reports an idempotent write as unchanged without churning the store", () => {
    const store = usePanelStore.getState();
    store.setPanelClientMetadata("t1", { session: "gc-1" });
    const afterFirst = usePanelStore.getState().panelsById["t1"];
    saveMock.mockClear();

    expect(store.setPanelClientMetadata("t1", { session: "gc-1" })).toEqual({
      ok: true,
      changed: false,
    });
    expect(usePanelStore.getState().panelsById["t1"]).toBe(afterFirst);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("reports deleting an absent record as unchanged", () => {
    expect(usePanelStore.getState().setPanelClientMetadata("t1", null)).toEqual({
      ok: true,
      changed: false,
    });
  });

  it("never moves the version stamp", () => {
    // `terminal` IS a registered kind and declares no `stateVersion`, so
    // reusing the plugin branch would stamp `undefined` here and erase a
    // version a restore had carried forward — on behalf of a caller that wrote
    // nothing the panel's own schema describes.
    seed([makeTerminalPanel({ extensionStateVersion: 4 } as Partial<PanelInstance>)]);

    usePanelStore.getState().setPanelClientMetadata("t1", { session: "gc-1" });

    expect(versionOf("t1")).toBe(4);
  });

  it("refuses a plugin-owned panel", () => {
    seed([makePluginPanel()]);

    expect(usePanelStore.getState().setPanelClientMetadata("p1", { session: "gc-1" })).toEqual({
      ok: false,
      reason: "not-eligible",
    });
    expect(stateOf("p1")).toBeUndefined();
  });

  it("refuses a non-terminal built-in and an unknown panel", () => {
    const builtin: FilePanelData = {
      id: "f1",
      kind: "file",
      title: "File",
      location: "grid",
      filePath: "/repo/a.md",
    };
    seed([builtin]);

    expect(usePanelStore.getState().setPanelClientMetadata("f1", { a: 1 })).toEqual({
      ok: false,
      reason: "not-eligible",
    });
    expect(usePanelStore.getState().setPanelClientMetadata("gone", { a: 1 })).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("refuses a tooling-internal terminal the listing cannot enumerate", () => {
    seed([makeTerminalPanel({ excludeFromPersistence: true } as Partial<PanelInstance>)]);

    // A surface that cannot see the Daintree Assistant's own dock terminal must
    // not be able to write to it either.
    expect(usePanelStore.getState().setPanelClientMetadata("t1", { a: 1 })).toEqual({
      ok: false,
      reason: "not-eligible",
    });
  });

  it("names the metadata cap rather than the panel's when the record is too big", () => {
    const oversized = { blob: "x".repeat(MAX_CLIENT_METADATA_BYTES) };

    expect(usePanelStore.getState().setPanelClientMetadata("t1", oversized)).toEqual({
      ok: false,
      reason: "metadata-too-large",
    });
    expect(stateOf("t1")).toBeUndefined();
  });

  it("accepts a record exactly at the depth limit and refuses one past it", () => {
    const store = usePanelStore.getState();
    const nest = (levels: number): unknown => {
      let value: unknown = "leaf";
      for (let i = 0; i < levels; i++) value = [value];
      return value;
    };

    // Both fixtures are a few dozen bytes, so only the depth rule can be
    // deciding — a fixture thousands of levels deep would also pass against a
    // limit accidentally relaxed to hundreds.
    expect(store.setPanelClientMetadata("t1", { deep: nest(MAX_DEPTH - 1) })).toEqual({
      ok: true,
      changed: true,
    });
    expect(store.setPanelClientMetadata("t1", { deep: nest(MAX_DEPTH) })).toEqual({
      ok: false,
      reason: "too-deep",
    });
  });

  it("still calls a stack-overflowing value too deep, not unserializable", () => {
    let bomb: unknown = "leaf";
    for (let i = 0; i < 20_000; i++) bomb = [bomb];

    // `JSON.stringify` recurses, so serializing first would throw RangeError and
    // report `invalid-json` — the one answer that does not tell the caller what
    // to change. The depth walk runs first precisely so this stays actionable.
    expect(usePanelStore.getState().setPanelClientMetadata("t1", { bomb })).toEqual({
      ok: false,
      reason: "too-deep",
    });
  });

  it("measures the representation it stores, not the one it was handed", () => {
    // `toJSON` is passed the key it is serializing under, so a value that
    // answers differently for "" and for "mcp" is measured as one record and
    // persisted as another — passing the 2KB check and storing well over it.
    const shapeShifter = {
      toJSON: (key: string) => (key === "" ? { small: true } : { blob: "x".repeat(3000) }),
    };

    const result = usePanelStore.getState().setPanelClientMetadata("t1", { shapeShifter });

    const stored = JSON.stringify(stateOf("t1") ?? {});
    if (result.ok) expect(stored.length).toBeLessThanOrEqual(MAX_CLIENT_METADATA_BYTES + 200);
    else expect(result.reason).toBe("metadata-too-large");
  });

  it("refuses a valid record that will not fit the panel's remaining state", () => {
    // The slice is small but the bag it merges into is already near the whole-
    // panel ceiling, so the rejection has to name the panel's limit rather than
    // the metadata one.
    seed([
      makeTerminalPanel({
        extensionState: { presetEnv: { BIG: "x".repeat(MAX_EXTENSION_STATE_BYTES - 40) } },
      }),
    ]);
    saveMock.mockClear();

    expect(usePanelStore.getState().setPanelClientMetadata("t1", { session: "gc-1" })).toEqual({
      ok: false,
      reason: "state-too-large",
    });
    expect(stateOf("t1")).not.toHaveProperty("mcp");
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("can still delete its record out of an already oversized bag", () => {
    seed([
      makeTerminalPanel({
        extensionState: {
          mcp: { session: "gc-1" },
          presetEnv: { BIG: "x".repeat(MAX_EXTENSION_STATE_BYTES) },
        },
      }),
    ]);

    // Shrinking is the one direction an over-cap bag must always allow, or the
    // caller is locked out of the only operation that could fix it.
    expect(usePanelStore.getState().setPanelClientMetadata("t1", null)).toEqual({
      ok: true,
      changed: true,
    });
    expect(stateOf("t1")).not.toHaveProperty("mcp");
  });

  it("counts the byte length of a record, not its UTF-16 length", () => {
    // ~1200 CJK characters measure well under 2048 as code units and about
    // 3600 bytes once encoded.
    const cjk = { note: "文".repeat(1200) };

    expect(usePanelStore.getState().setPanelClientMetadata("t1", cjk)).toEqual({
      ok: false,
      reason: "metadata-too-large",
    });
  });

  it("schedules a layout save for a write that changed something", () => {
    saveMock.mockClear();

    usePanelStore.getState().setPanelClientMetadata("t1", { session: "gc-1" });

    // The negative case below asserts an unchanged write is free; without this
    // one, dropping the save call entirely would pass both.
    expect(saveMock).toHaveBeenCalled();
  });

  it("refuses a cyclic record as unbounded depth, without recursing into it", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    // A cycle IS infinite depth, and the iterative walk reaches the limit and
    // stops rather than following it — which is the point of checking depth
    // before handing the value to a recursive `JSON.stringify`. The reason is
    // reported as depth because that is what was measured; the caller-facing
    // message names both.
    expect(usePanelStore.getState().setPanelClientMetadata("t1", { cyclic })).toEqual({
      ok: false,
      reason: "too-deep",
    });
    expect(stateOf("t1")).toBeUndefined();
  });

  it("refuses a shallow value that cannot round-trip through JSON", () => {
    expect(usePanelStore.getState().setPanelClientMetadata("t1", { big: 1n })).toEqual({
      ok: false,
      reason: "invalid-json",
    });
    expect(stateOf("t1")).toBeUndefined();
  });

  it("detaches the stored record from the object the caller passed", () => {
    const submitted = { session: "gc-1" };
    usePanelStore.getState().setPanelClientMetadata("t1", submitted);

    submitted.session = "mutated";

    // Same reason the plugin path round-trips: a caller holding its own patch
    // must not be able to edit store state behind the setter's back.
    expect(stateOf("t1")).toEqual({ mcp: { session: "gc-1" } });
  });

  it("keeps a literal __proto__ key as data", () => {
    usePanelStore.getState().setPanelClientMetadata("t1", { ["__proto__"]: { polluted: true } });

    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
