// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { registerDevServerActions } from "../definitions/devServerActions";
import { ELEMENT_PICKER_TOOL_ID } from "@/panels/dev-preview/element-picker/toolId";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import { usePanelStore } from "@/store/panelStore";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { __resetDevPreviewToolSessionsForTests } from "@/services/devPreviewTools/sessionManager";

const dispatch = vi.hoisted(() =>
  vi.fn(async (_id: string, _args?: unknown, _options?: unknown) => ({
    ok: true,
    result: { panelId: "started-1" },
  }))
);
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

const PANEL = "preview-1";
const NO_CALLBACKS = {} as ActionCallbacks;

function definition() {
  const actions: ActionRegistry = new Map();
  registerDevServerActions(actions, NO_CALLBACKS);
  const factory = actions.get("devPreview.toggleElementPicker");
  if (!factory) throw new Error("devPreview.toggleElementPicker was not registered");
  return factory();
}

function run(args?: { panelId?: string }, ctx: ActionContext = {}): Promise<unknown> {
  return definition().run(args, ctx);
}

const BROWSER = "browser-1";

/** A dev preview beside a browser panel showing `url`, with `focusedId` focused. */
function previewBesideBrowser(
  url: string,
  focusedId: string | null,
  options: {
    preview?: string;
    browser?: string | null;
    browserLocation?: "grid" | "dock";
  } = {}
): void {
  const browserWorktree = options.browser === undefined ? "wt-a" : (options.browser ?? undefined);
  usePanelStore.setState({
    panelIds: [PANEL, BROWSER],
    focusedId,
    panelsById: {
      [PANEL]: {
        id: PANEL,
        kind: "dev-preview",
        location: "grid",
        worktreeId: options.preview ?? "wt-a",
      },
      [BROWSER]: {
        id: BROWSER,
        kind: "browser",
        location: options.browserLocation ?? "grid",
        browserUrl: url,
        worktreeId: browserWorktree,
      },
    },
  } as never);
}

function previews(...ids: string[]): void {
  usePanelStore.setState({
    panelIds: ids,
    panelsById: Object.fromEntries(
      ids.map((id) => [id, { id, kind: "dev-preview", location: "grid" }])
    ),
  } as never);
}

beforeEach(() => {
  previews(PANEL);
  // No plugin is loaded at all: the picker is the dev preview's own.
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map(),
    disabledPluginIds: new Set(["daintree.sveltekit-builder"]),
  });
});

afterEach(() => {
  __resetDevPreviewToolSessionsForTests();
  _resetPluginRuntimeStoreForTest();
  useDevPreviewToolStore.setState({ activeByPanel: {} });
  usePanelStore.setState({ panelIds: [], panelsById: {} } as never);
  dispatch.mockClear();
});

describe("devPreview.toggleElementPicker", () => {
  it("switches the picker on with no plugin loaded or enabled", async () => {
    const result = await run();
    expect(result).toEqual({ panelId: PANEL, active: true });
    expect(useDevPreviewToolStore.getState().activeByPanel[PANEL]).toBe(ELEMENT_PICKER_TOOL_ID);
  });

  it("switches it off again, and returns exactly the panel and whether it is on", async () => {
    useDevPreviewToolStore.setState({ activeByPanel: { [PANEL]: ELEMENT_PICKER_TOOL_ID } });
    const result = await run({ panelId: PANEL });
    expect(result).toStrictEqual({ panelId: PANEL, active: false });
  });

  it("acts on the preview it is named, and refuses a panel that isn't one", async () => {
    previews(PANEL, "preview-2");
    expect(await run({ panelId: "preview-2" })).toEqual({ panelId: "preview-2", active: true });
    await expect(run({ panelId: "terminal-9" })).rejects.toThrow("not an open dev preview");
  });

  it("opens a dev preview when the worktree has none, and switches the picker on in it", async () => {
    usePanelStore.setState({ panelIds: [], panelsById: {} } as never);
    dispatch.mockImplementationOnce(async () => {
      previews("started-1");
      return { ok: true, result: { panelId: "started-1" } };
    });
    const result = await run();
    expect(dispatch).toHaveBeenCalledWith("devServer.start", undefined, expect.anything());
    expect(result).toEqual({ panelId: "started-1", active: true });
  });

  it("acts on the focused browser panel when it shows a local page", async () => {
    previewBesideBrowser("http://localhost:5173/", BROWSER);
    expect(await run()).toEqual({ panelId: BROWSER, active: true });
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({
      [BROWSER]: ELEMENT_PICKER_TOOL_ID,
    });
    expect(dispatch).not.toHaveBeenCalledWith("devServer.start", undefined, expect.anything());

    expect(await run()).toEqual({ panelId: BROWSER, active: false });
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
  });

  it("refuses a focused browser on a page outside the picker's origins, and opens nothing", async () => {
    previewBesideBrowser("https://example.com/", BROWSER);
    await expect(run()).rejects.toThrow("local address");
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("acts on a browser panel it is named, and still switches it off on a foreign page", async () => {
    previewBesideBrowser("http://app.test:3000/", null);
    expect(await run({ panelId: BROWSER })).toEqual({ panelId: BROWSER, active: true });

    // The page leaves for a site elsewhere with the picker on.
    usePanelStore.setState((state) => ({
      panelsById: {
        ...state.panelsById,
        [BROWSER]: { ...state.panelsById[BROWSER]!, browserUrl: "https://example.com/" },
      },
    }));
    expect(await run({ panelId: BROWSER })).toEqual({ panelId: BROWSER, active: false });
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
    await expect(run({ panelId: BROWSER })).rejects.toThrow("local address");
  });

  it("acts on a focused browser of the active worktree, and leaves one of another alone", async () => {
    previewBesideBrowser("http://localhost:5173/", BROWSER, { preview: "wt-a", browser: "wt-a" });
    expect(await run(undefined, { activeWorktreeId: "wt-a" })).toEqual({
      panelId: BROWSER,
      active: true,
    });

    useDevPreviewToolStore.setState({ activeByPanel: {} });
    previewBesideBrowser("http://localhost:5173/", BROWSER, { preview: "wt-a", browser: "wt-b" });
    expect(await run(undefined, { activeWorktreeId: "wt-a" })).toEqual({
      panelId: PANEL,
      active: true,
    });
  });

  it("treats a focused global browser in the dock as the one in front of the user", async () => {
    // Visible in every worktree, as the dock shows it; it has no checkout of
    // its own to trace into, so the picker won't switch on there.
    previewBesideBrowser("http://localhost:5173/", BROWSER, {
      browser: null,
      browserLocation: "dock",
    });
    await expect(run(undefined, { activeWorktreeId: "wt-a" })).rejects.toThrow(
      "belongs to a worktree"
    );
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
    expect(dispatch).not.toHaveBeenCalled();

    // One that is on there (its worktree since removed) still switches off.
    useDevPreviewToolStore.setState({ activeByPanel: { [BROWSER]: ELEMENT_PICKER_TOOL_ID } });
    expect(await run(undefined, { activeWorktreeId: "wt-a" })).toEqual({
      panelId: BROWSER,
      active: false,
    });
  });

  it("refuses a trashed browser panel by name", async () => {
    previewBesideBrowser("http://localhost:5173/", null);
    usePanelStore.setState((state) => ({
      panelsById: {
        ...state.panelsById,
        [BROWSER]: { ...state.panelsById[BROWSER]!, location: "trash" },
      },
    }));
    await expect(run({ panelId: BROWSER })).rejects.toThrow("not an open dev preview or browser");
  });

  it("is a neutral, described command an agent can find", () => {
    const action = definition();
    // Sentence case: nothing after the first letter is capitalised.
    expect(action.title.slice(1)).toBe(action.title.slice(1).toLowerCase());
    expect(Buffer.byteLength(action.description ?? "")).toBeLessThanOrEqual(400);
    for (const word of ["sveltekit", "builder", "plugin"]) {
      expect(`${action.id} ${action.title} ${action.description}`.toLowerCase()).not.toContain(
        word
      );
    }
  });
});
