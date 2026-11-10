import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelInstance } from "@shared/types/panel";
import { createBrowserActions } from "../browser";
import { saveNormalized } from "../persistence";

vi.mock("../persistence", () => ({ saveNormalized: vi.fn() }));

interface TestState {
  panelsById: Record<string, PanelInstance>;
  panelIds: string[];
}

function makeSet(initial: TestState) {
  let state = initial;
  const set = ((updater: (current: TestState) => Partial<TestState> | TestState) => {
    const result = updater(state);
    if (result === state) return;
    state = { ...state, ...result };
  }) as never;
  return { set, get: () => state };
}

function devPreviewPanel(overrides: Record<string, unknown> = {}) {
  return {
    id: "panel-1",
    title: "Dev preview",
    location: "grid" as const,
    kind: "dev-preview" as const,
    ...overrides,
  } as unknown as PanelInstance;
}

describe("showDevPreviewOutput", () => {
  beforeEach(() => {
    vi.mocked(saveNormalized).mockClear();
  });

  function setup(panel: PanelInstance) {
    const store = makeSet({ panelsById: { "panel-1": panel }, panelIds: ["panel-1"] });
    const actions = createBrowserActions(store.set);
    return { store, actions };
  }

  it("opens a closed drawer on the Output tab", () => {
    const { store, actions } = setup(devPreviewPanel({ devPreviewConsoleTab: "console" }));

    actions.showDevPreviewOutput("panel-1");

    expect(store.get().panelsById["panel-1"]).toMatchObject({
      devPreviewConsoleOpen: true,
      devPreviewConsoleTab: "output",
    });
  });

  it("switches an already-open drawer from Console to Output", () => {
    const { store, actions } = setup(
      devPreviewPanel({ devPreviewConsoleOpen: true, devPreviewConsoleTab: "console" })
    );

    actions.showDevPreviewOutput("panel-1");

    expect(store.get().panelsById["panel-1"]).toMatchObject({
      devPreviewConsoleOpen: true,
      devPreviewConsoleTab: "output",
    });
  });

  it("switches an already-open drawer from Diagnostics to Output", () => {
    const { store, actions } = setup(
      devPreviewPanel({ devPreviewConsoleOpen: true, devPreviewConsoleTab: "diagnostics" })
    );

    actions.showDevPreviewOutput("panel-1");

    expect(store.get().panelsById["panel-1"]).toMatchObject({
      devPreviewConsoleTab: "output",
    });
  });

  it("commits once when both fields change", () => {
    const { actions } = setup(devPreviewPanel({ devPreviewConsoleTab: "diagnostics" }));

    actions.showDevPreviewOutput("panel-1");

    expect(saveNormalized).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the drawer is already open on Output", () => {
    const panel = devPreviewPanel({ devPreviewConsoleOpen: true, devPreviewConsoleTab: "output" });
    const { store, actions } = setup(panel);
    const before = store.get();

    actions.showDevPreviewOutput("panel-1");

    expect(store.get()).toBe(before);
    expect(saveNormalized).not.toHaveBeenCalled();
  });

  it("ignores panels that are not a dev preview", () => {
    const panel = { id: "panel-1", title: "T", location: "grid", kind: "terminal" } as never;
    const { store, actions } = setup(panel);
    const before = store.get();

    actions.showDevPreviewOutput("panel-1");

    expect(store.get()).toBe(before);
  });
});
