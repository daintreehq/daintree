import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const terminalClientMock = vi.hoisted(() => ({ submit: vi.fn() }));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: panelStoreMock.getState },
}));
vi.mock("@/clients", () => ({ terminalClient: terminalClientMock }));
vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindHasPty: (kind: string) => kind === "terminal" || kind === "agent",
}));

import { registerTerminalQueryActions } from "../terminalQueryActions";

type TerminalListItem = {
  id: string;
  isFocused: boolean;
  agentId: string | null;
  location: string;
};

function setupActions() {
  const actions: ActionRegistry = new Map();
  registerTerminalQueryActions(actions, {} as ActionCallbacks);
  return actions;
}

async function callList(actions: ActionRegistry, args?: unknown): Promise<TerminalListItem[]> {
  const factory = actions.get("terminal.list");
  if (!factory) throw new Error("missing terminal.list");
  const def = factory() as AnyActionDefinition;
  return ((await def.run(args, {} as never)) as { terminals: TerminalListItem[] }).terminals;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("terminal.list isFocused field", () => {
  it("flags exactly one item when a panel matches focusedId", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: "term-b",
      panelIds: ["term-a", "term-b", "term-c"],
      panelsById: {
        "term-a": { id: "term-a", kind: "terminal", location: "grid" },
        "term-b": { id: "term-b", kind: "agent", location: "grid" },
        "term-c": { id: "term-c", kind: "terminal", location: "dock" },
      },
    });

    const items = await callList(setupActions());
    const focusedIds = items.filter((t) => t.isFocused).map((t) => t.id);
    expect(focusedIds).toEqual(["term-b"]);
  });

  it("returns isFocused:false for every item when focusedId is null", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: null,
      panelIds: ["term-a", "term-b"],
      panelsById: {
        "term-a": { id: "term-a", kind: "terminal", location: "grid" },
        "term-b": { id: "term-b", kind: "terminal", location: "grid" },
      },
    });

    const items = await callList(setupActions());
    expect(items).toHaveLength(2);
    expect(items.every((t) => t.isFocused === false)).toBe(true);
  });

  it("flags a focused dock terminal as isFocused:true", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: "term-dock",
      panelIds: ["term-grid", "term-dock"],
      panelsById: {
        "term-grid": { id: "term-grid", kind: "terminal", location: "grid" },
        "term-dock": { id: "term-dock", kind: "agent", location: "dock" },
      },
    });

    const items = await callList(setupActions());
    const dock = items.find((t) => t.id === "term-dock");
    expect(dock?.isFocused).toBe(true);
  });

  it("reports runtime-detected agents as agent terminals", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: null,
      panelIds: ["term-runtime"],
      panelsById: {
        "term-runtime": {
          id: "term-runtime",
          kind: "terminal",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      },
    });

    const items = await callList(setupActions());
    expect(items).toHaveLength(1);
    expect(items[0]?.agentId).toBe("claude");
  });
});

describe("terminal.list owned argument (#12308)", () => {
  function seedPanels(): void {
    panelStoreMock.getState.mockReturnValue({
      focusedId: null,
      panelIds: ["term-a", "term-b"],
      panelsById: {
        "term-a": { id: "term-a", kind: "terminal", location: "grid" },
        "term-b": { id: "term-b", kind: "terminal", location: "grid" },
      },
    });
  }

  it("refuses a direct dispatch that asks for owned terminals", async () => {
    seedPanels();

    // Which session created a panel is main-process state the renderer never
    // sees, so `run()` has no way to answer this and the unfiltered list would
    // be read as "you own all of these" — the quiet no-op the argument exists
    // to avoid.
    await expect(callList(setupActions(), { owned: true })).rejects.toThrow(/owned/);
    expect(panelStoreMock.getState).not.toHaveBeenCalled();
  });

  it("refuses owned:false too, because it cannot honour the argument either way", async () => {
    seedPanels();

    // A main-side strip that stopped working would otherwise surface as a
    // wrong answer on the `true` path and silence on the `false` one.
    await expect(callList(setupActions(), { owned: false })).rejects.toThrow(/owned/);
  });

  it("lists normally when owned is omitted", async () => {
    seedPanels();

    const items = await callList(setupActions(), { location: "grid" });
    expect(items.map((t) => t.id)).toEqual(["term-a", "term-b"]);
  });
});

/**
 * The read half of the client-metadata capability (#12340).
 *
 * `terminal.list` carries it rather than a second tool, which is what keeps the
 * feature to one external allowlist slot. Two things have to hold for that to
 * be safe: the default listing must stay the cheap inventory its description
 * promises, and the echo must never widen past the one reserved key — the bag
 * it sits in also holds `presetEnv`, a real subprocess environment.
 */
describe("terminal.list client metadata", () => {
  function seedTerminals(panelsById: Record<string, unknown>): void {
    panelStoreMock.getState.mockReturnValue({
      focusedId: null,
      panelIds: Object.keys(panelsById),
      panelsById,
    });
  }

  it("omits the field entirely unless it is asked for", async () => {
    seedTerminals({
      "term-a": {
        id: "term-a",
        kind: "terminal",
        location: "grid",
        extensionState: { mcp: { session: "gc-1" } },
      },
    });

    const [row] = await callList(setupActions());

    // The default listing is a cheap inventory, and these records are up to 2KB
    // each — an always-on echo would make every discovery call pay for them.
    expect(row).not.toHaveProperty("clientMetadata");
  });

  it("returns only the reserved key, never the bag holding presetEnv", async () => {
    seedTerminals({
      "term-a": {
        id: "term-a",
        kind: "terminal",
        location: "grid",
        extensionState: {
          mcp: { session: "gc-1" },
          presetEnv: { ANTHROPIC_API_KEY: "sk-secret" },
        },
      },
    });

    const [row] = await callList(setupActions(), { includeClientMetadata: true });

    expect(row).toMatchObject({ clientMetadata: { session: "gc-1" } });
    expect(JSON.stringify(row)).not.toContain("sk-secret");
  });

  it("reports null for a terminal carrying no record", async () => {
    seedTerminals({
      "term-a": { id: "term-a", kind: "terminal", location: "grid" },
      "term-b": {
        id: "term-b",
        kind: "terminal",
        location: "grid",
        extensionState: { presetEnv: { TOKEN: "x" } },
      },
    });

    const rows = await callList(setupActions(), { includeClientMetadata: true });

    expect(rows.map((r) => (r as { clientMetadata?: unknown }).clientMetadata)).toEqual([
      null,
      null,
    ]);
  });

  it("never exposes a plugin panel's own extension state", async () => {
    seedTerminals({
      p1: {
        id: "p1",
        kind: "acme.explorer",
        location: "grid",
        pluginId: "acme.explorer-plugin",
        extensionState: { root: "src", expanded: ["src"] },
      },
    });

    const [row] = await callList(setupActions(), { includeClientMetadata: true });

    // The plugin bag is arbitrary view state under keys the plugin chose; only
    // the reserved key is this surface's to read.
    expect(row).toMatchObject({ clientMetadata: null });
    expect(JSON.stringify(row)).not.toContain("expanded");
  });

  it("narrows to one terminal by id, and to none when nothing matches", async () => {
    seedTerminals({
      "term-a": { id: "term-a", kind: "terminal", location: "grid" },
      "term-b": { id: "term-b", kind: "terminal", location: "grid" },
    });

    expect((await callList(setupActions(), { terminalId: "term-b" })).map((r) => r.id)).toEqual([
      "term-b",
    ]);
    // A filter, not a lookup: the same empty answer every other filter gives.
    expect(await callList(setupActions(), { terminalId: "term-zzz" })).toEqual([]);
  });

  it("refuses a metadata read too large for the transport, naming the filters", async () => {
    const panelsById: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      panelsById[`term-${i}`] = {
        id: `term-${i}`,
        kind: "terminal",
        location: "grid",
        extensionState: { mcp: { blob: "x".repeat(2000) } },
      };
    }
    seedTerminals(panelsById);

    // Over the transport's ceiling the text is truncated and structuredContent
    // is dropped outright, so an unguarded read would hand back a half-listing
    // with no way to tell which rows went missing.
    await expect(callList(setupActions(), { includeClientMetadata: true })).rejects.toThrow(
      /Narrow it with terminalId, worktreeId or location/
    );
  });

  it("still answers a narrowed read from the same oversized fleet", async () => {
    const panelsById: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      panelsById[`term-${i}`] = {
        id: `term-${i}`,
        kind: "terminal",
        location: "grid",
        extensionState: { mcp: { blob: "x".repeat(2000) } },
      };
    }
    seedTerminals(panelsById);

    const rows = await callList(setupActions(), {
      includeClientMetadata: true,
      terminalId: "term-7",
    });

    expect(rows).toHaveLength(1);
  });
});
