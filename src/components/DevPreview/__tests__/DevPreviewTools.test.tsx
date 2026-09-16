// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DevPreviewToolButtons,
  DevPreviewToolDrawer,
  DevPreviewToolToolbar,
} from "../DevPreviewTools";
import {
  __resetDevPreviewToolsForTests,
  getAvailableDevPreviewTool,
  registerDevPreviewTool,
  type DevPreviewToolButtonProps,
  type DevPreviewToolSurfaceProps,
} from "@/registry/devPreviewToolRegistry";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

const PLUGIN = "acme.tools";
const TOOL = "acme.tools.picker";

function Button({ active, onToggle }: DevPreviewToolButtonProps) {
  return (
    <button type="button" aria-pressed={active} onClick={onToggle}>
      Picker
    </button>
  );
}
function Toolbar({ panelId, onClose }: DevPreviewToolSurfaceProps) {
  return (
    <div role="toolbar" aria-label="Picker strip">
      {panelId}
      <button type="button" onClick={onClose}>
        Close picker
      </button>
    </div>
  );
}
function Drawer({ worktreeId }: DevPreviewToolSurfaceProps) {
  return <aside aria-label="Picker drawer">{worktreeId}</aside>;
}

const host = {
  panelId: "preview-1",
  projectId: "p1",
  worktreeId: "wt-1",
  url: "http://localhost:5173/",
  isWebviewReady: true,
};

function Preview() {
  return (
    <>
      <DevPreviewToolButtons {...host} />
      <DevPreviewToolToolbar {...host} />
      <DevPreviewToolDrawer {...host} />
    </>
  );
}

function pluginLoaded(enabled: boolean) {
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map([[PLUGIN, { devMode: false, displayName: "Acme" }]]),
    disabledPluginIds: new Set(enabled ? [] : [PLUGIN]),
  });
}

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      plugin: { list: async () => [], onProvenanceChanged: () => () => {} },
    },
  });
  registerDevPreviewTool({
    id: TOOL,
    pluginId: PLUGIN,
    label: "Picker",
    Button,
    Toolbar,
    Drawer,
  });
});

afterEach(() => {
  cleanup();
  __resetDevPreviewToolsForTests();
  _resetPluginRuntimeStoreForTest();
});

describe("dev preview tools", () => {
  it("shows nothing until the owning plugin is known to be loaded and enabled", () => {
    render(<Preview />);
    // No plugin snapshot yet: a default-off built-in must not flash its button.
    expect(screen.queryByRole("button", { name: "Picker" })).toBeNull();

    act(() => pluginLoaded(false));
    expect(screen.queryByRole("button", { name: "Picker" })).toBeNull();

    act(() => pluginLoaded(true));
    expect(screen.getByRole("button", { name: "Picker" }).getAttribute("aria-pressed")).toBe(
      "false"
    );
  });

  it("mounts the tool's strip and drawer for this preview only while toggled on", () => {
    pluginLoaded(true);
    render(<Preview />);
    expect(screen.queryByRole("toolbar", { name: "Picker strip" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Picker" }));
    expect(screen.getByRole("toolbar", { name: "Picker strip" }).textContent).toContain(
      "preview-1"
    );
    expect(screen.getByRole("complementary", { name: "Picker drawer" }).textContent).toBe("wt-1");
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({ "preview-1": TOOL });

    fireEvent.click(screen.getByRole("button", { name: "Close picker" }));
    expect(screen.queryByRole("toolbar", { name: "Picker strip" })).toBeNull();
    expect(screen.getByRole("button", { name: "Picker" }).getAttribute("aria-pressed")).toBe(
      "false"
    );
  });

  it("offers a tool to actions only while its plugin is loaded and enabled", () => {
    expect(getAvailableDevPreviewTool(TOOL)).toBeUndefined();
    pluginLoaded(false);
    expect(getAvailableDevPreviewTool(TOOL)).toBeUndefined();
    pluginLoaded(true);
    expect(getAvailableDevPreviewTool(TOOL)?.id).toBe(TOOL);
  });

  it("drops an active tool's surfaces when its plugin is disabled", () => {
    pluginLoaded(true);
    render(<Preview />);
    fireEvent.click(screen.getByRole("button", { name: "Picker" }));
    expect(screen.getByRole("toolbar", { name: "Picker strip" })).toBeTruthy();

    act(() => pluginLoaded(false));
    expect(screen.queryByRole("toolbar", { name: "Picker strip" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Picker drawer" })).toBeNull();
  });
});
