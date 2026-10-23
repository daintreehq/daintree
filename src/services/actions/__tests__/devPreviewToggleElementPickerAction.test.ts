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

  it("is a neutral, described command an agent can find", () => {
    const action = definition();
    expect(action.title).toBe("Toggle Element Picker");
    expect(Buffer.byteLength(action.description ?? "")).toBeLessThanOrEqual(400);
    for (const word of ["sveltekit", "builder", "plugin"]) {
      expect(`${action.id} ${action.title} ${action.description}`.toLowerCase()).not.toContain(
        word
      );
    }
  });
});
