// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { registerDevServerActions } from "../definitions/devServerActions";
import type { DevPreviewToolDefinition } from "@/services/devPreviewTools/types";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import { usePanelStore } from "@/store/panelStore";

// The action focuses the panel it acted on through the service singleton; the
// refusal these tests are about happens before that, and a real dispatch here
// would only pull the whole action graph into the test.
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(async () => ({ ok: true, result: { panelId: PANEL } })) },
}));

// The preview's own tools, swapped for the one fake each case sets up.
const builtIn = vi.hoisted(() => ({ tool: undefined as DevPreviewToolDefinition | undefined }));
vi.mock("@/services/devPreviewTools/builtInTools", () => ({
  BUILT_IN_DEV_PREVIEW_TOOLS: [],
  resolveDevPreviewTool: (toolId: string) =>
    builtIn.tool?.id === toolId ? builtIn.tool : undefined,
}));

const TOOL = "picker";
const PANEL = "preview-1";
const REASON = "The Picker needs something to pick";

// The action ignores its callbacks; an empty stand-in keeps the whole action
// graph out of a test about one refusal.
const NO_CALLBACKS = {} as ActionCallbacks;
const NO_CONTEXT: ActionContext = {};

function runToggleTool(args: { toolId: string; panelId?: string }): Promise<unknown> {
  const actions: ActionRegistry = new Map();
  registerDevServerActions(actions, NO_CALLBACKS);
  const factory = actions.get("devPreview.toggleTool");
  if (!factory) throw new Error("devPreview.toggleTool was not registered");
  return factory().run(args, NO_CONTEXT);
}

function register(isAvailable: (() => boolean | Promise<boolean>) | undefined): void {
  builtIn.tool = {
    id: TOOL,
    label: "Picker",
    Button: () => null,
    isAvailable,
    unavailableReason: REASON,
  };
}

beforeEach(() => {
  usePanelStore.setState({
    panelIds: [PANEL],
    panelsById: { [PANEL]: { id: PANEL, kind: "dev-preview", location: "grid" } },
  } as never);
});

afterEach(() => {
  builtIn.tool = undefined;
  useDevPreviewToolStore.setState({ activeByPanel: {} });
  usePanelStore.setState({ panelIds: [], panelsById: {} } as never);
});

describe("devPreview.toggleTool availability", () => {
  it("refuses a tool that does not apply to the preview, in the tool's own words", async () => {
    register(() => false);
    await expect(runToggleTool({ toolId: TOOL })).rejects.toThrow(REASON);
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
  });

  it("switches on a tool that applies", async () => {
    register(() => true);
    const result = await runToggleTool({ toolId: TOOL });
    expect(result).toEqual({ panelId: PANEL, active: true });
  });

  it("leaves a tool without a predicate alone", async () => {
    register(undefined);
    const result = await runToggleTool({ toolId: TOOL });
    expect(result).toEqual({ panelId: PANEL, active: true });
  });

  it("still switches off a tool that stopped applying", async () => {
    register(() => false);
    useDevPreviewToolStore.setState({ activeByPanel: { [PANEL]: TOOL } });
    const result = await runToggleTool({ toolId: TOOL });
    expect(result).toEqual({ panelId: PANEL, active: false });
  });
});
