// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  type DevPreviewToolSessionContext,
  type DevPreviewToolSurfaceProps,
} from "@/registry/devPreviewToolRegistry";
import {
  __resetDevPreviewToolSessionsForTests,
  peekDevPreviewToolSession,
} from "@/services/devPreviewTools/sessionManager";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

const PLUGIN = "acme.tools";
const TOOL = "acme.tools.picker";
const BROKEN_TOOL = "acme.tools.broken";

/** A stand-in for a tool's session, recording what the host tells it. */
interface FakeSession {
  contexts: DevPreviewToolSessionContext[];
  disposals: number;
  update: (context: DevPreviewToolSessionContext) => void;
  dispose: () => void;
}

function makeSession(context: DevPreviewToolSessionContext): FakeSession {
  const session: FakeSession = {
    contexts: [context],
    disposals: 0,
    update: (next) => session.contexts.push(next),
    dispose: () => {
      session.disposals++;
    },
  };
  return session;
}

function session(): FakeSession {
  const live = peekDevPreviewToolSession(host.panelId) as FakeSession | null;
  if (!live) throw new Error("no session for the active tool");
  return live;
}

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
    createSession: makeSession,
  });
});

afterEach(() => {
  cleanup();
  __resetDevPreviewToolSessionsForTests();
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

  it("keeps one session across the surfaces unmounting and remounting", () => {
    pluginLoaded(true);
    const view = render(<Preview />);
    fireEvent.click(screen.getByRole("button", { name: "Picker" }));
    const live = session();
    expect(live.contexts.at(-1)?.visible).toBe(true);

    // What a hidden dock tab or a maximised sibling costs the tool: its
    // surfaces, and nothing else.
    view.unmount();
    expect(live.contexts.at(-1)?.visible).toBe(false);
    expect(live.disposals).toBe(0);

    render(<Preview />);
    expect(session()).toBe(live);
    expect(screen.getByRole("toolbar", { name: "Picker strip" })).toBeTruthy();
    expect(live.contexts.at(-1)?.visible).toBe(true);
  });

  it("disposes the session when the tool is switched off", () => {
    pluginLoaded(true);
    render(<Preview />);
    fireEvent.click(screen.getByRole("button", { name: "Picker" }));
    const live = session();
    fireEvent.click(screen.getByRole("button", { name: "Close picker" }));
    expect(live.disposals).toBe(1);
    expect(peekDevPreviewToolSession(host.panelId)).toBeNull();
  });

  it("does not carry one tool's failed toolbar into the next tool", () => {
    registerDevPreviewTool({
      id: BROKEN_TOOL,
      pluginId: PLUGIN,
      label: "Broken",
      Button: ({ onToggle }: DevPreviewToolButtonProps) => (
        <button type="button" onClick={onToggle}>
          Broken
        </button>
      ),
      Toolbar: () => {
        throw new Error("toolbar exploded");
      },
    });
    pluginLoaded(true);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<Preview />);
      fireEvent.click(screen.getByRole("button", { name: "Broken" }));
      expect(screen.getByText("Broken toolbar error")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Picker" }));
      expect(screen.queryByText("Broken toolbar error")).toBeNull();
      expect(screen.getByRole("toolbar", { name: "Picker strip" })).toBeTruthy();
    } finally {
      errors.mockRestore();
    }
  });

  it("drops an active tool's surfaces when its plugin is disabled", () => {
    pluginLoaded(true);
    render(<Preview />);
    fireEvent.click(screen.getByRole("button", { name: "Picker" }));
    expect(screen.getByRole("toolbar", { name: "Picker strip" })).toBeTruthy();

    const live = session();
    act(() => pluginLoaded(false));
    expect(screen.queryByRole("toolbar", { name: "Picker strip" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Picker drawer" })).toBeNull();
    // Not just hidden: a disabled plugin ends the tool, session and all.
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({});
    expect(live.disposals).toBe(1);
  });
});
