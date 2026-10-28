// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The dev preview's own tools, swapped for fakes: these cases are about how
// the host offers tools, not about the picker. Mutated in place so the list
// the host imported is the list each case sets up.
const builtIn = vi.hoisted(() => ({ tools: [] as unknown[] }));
vi.mock("@/services/devPreviewTools/builtInTools", () => ({
  BUILT_IN_DEV_PREVIEW_TOOLS: builtIn.tools,
  resolveDevPreviewTool: (toolId: string) =>
    (builtIn.tools as Array<{ id: string }>).find((tool) => tool.id === toolId),
}));

import {
  DevPreviewToolButtons,
  DevPreviewToolDrawer,
  DevPreviewToolToolbar,
} from "../DevPreviewTools";
import type {
  DevPreviewToolButtonProps,
  DevPreviewToolDefinition,
  DevPreviewToolSessionContext,
  DevPreviewToolSurfaceProps,
} from "@/services/devPreviewTools/types";
import {
  __resetDevPreviewToolSessionsForTests,
  peekDevPreviewToolSession,
} from "@/services/devPreviewTools/sessionManager";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import { usePanelStore } from "@/store/panelStore";

const TOOL = "picker";
const BROKEN_TOOL = "broken";

/** A stand-in for a tool's session, recording what the host tells it. */
interface FakeSession {
  contexts: DevPreviewToolSessionContext[];
  disposals: number;
  serial?: number;
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
let sessionSerial = 0;
function sessionLabel(session: unknown): string {
  const live = session as FakeSession | null;
  if (!live) return "no session";
  if (live.serial === undefined) live.serial = ++sessionSerial;
  return `session ${live.serial}`;
}
function Toolbar({ panelId, session, onClose }: DevPreviewToolSurfaceProps) {
  return (
    <div role="toolbar" aria-label="Picker strip">
      {panelId}
      <span data-testid="toolbar-session">{sessionLabel(session)}</span>
      <button type="button" onClick={onClose}>
        Close picker
      </button>
    </div>
  );
}
function Drawer({ worktreeId, session }: DevPreviewToolSurfaceProps) {
  return (
    <aside aria-label="Picker drawer">
      {worktreeId}
      <span data-testid="drawer-session">{sessionLabel(session)}</span>
    </aside>
  );
}

const host = {
  panelId: "preview-1",
  projectId: "p1",
  worktreeId: "wt-1",
  url: "http://localhost:5173/",
  isWebviewReady: true,
};

function Preview(overrides: Partial<typeof host> = {}) {
  const props = { ...host, ...overrides };
  return (
    <>
      <DevPreviewToolButtons {...props} />
      <DevPreviewToolToolbar {...props} />
      <DevPreviewToolDrawer {...props} />
    </>
  );
}

/** Add a tool to the preview's own, replacing any with the same id. */
function register(tool: DevPreviewToolDefinition): void {
  const tools = builtIn.tools as DevPreviewToolDefinition[];
  const index = tools.findIndex((existing) => existing.id === tool.id);
  if (index === -1) tools.push(tool);
  else tools[index] = tool;
}

beforeEach(() => {
  // The session manager only serves a tool switched on for a preview the panel
  // store holds; an unknown or trashed panel is switched off again.
  usePanelStore.setState({
    panelIds: [host.panelId],
    panelsById: { [host.panelId]: { id: host.panelId, kind: "dev-preview", location: "grid" } },
  } as never);
  register({
    id: TOOL,
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
  builtIn.tools.length = 0;
  useDevPreviewToolStore.setState({ activeByPanel: {} });
  usePanelStore.setState({ panelIds: [], panelsById: {} } as never);
});

describe("dev preview tools", () => {
  it("mounts the tool's strip and drawer for this preview only while toggled on", () => {
    render(<Preview />);
    expect(screen.queryByRole("toolbar", { name: "Picker strip" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Picker" }));
    expect(screen.getByRole("toolbar", { name: "Picker strip" }).textContent).toContain(
      "preview-1"
    );
    expect(screen.getByRole("complementary", { name: "Picker drawer" }).textContent).toContain(
      "wt-1"
    );
    expect(useDevPreviewToolStore.getState().activeByPanel).toEqual({ "preview-1": TOOL });

    fireEvent.click(screen.getByRole("button", { name: "Close picker" }));
    expect(screen.queryByRole("toolbar", { name: "Picker strip" })).toBeNull();
    expect(screen.getByRole("button", { name: "Picker" }).getAttribute("aria-pressed")).toBe(
      "false"
    );
  });

  it("keeps one session across the surfaces unmounting and remounting", () => {
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

  it("hands both surfaces the one session the tool's factory produced", () => {
    render(<Preview />);
    fireEvent.click(screen.getByRole("button", { name: "Picker" }));
    const live = session();
    const shown = screen.getByTestId("toolbar-session").textContent;
    expect(shown).toBe(`session ${live.serial}`);
    expect(screen.getByTestId("drawer-session").textContent).toBe(shown);
  });

  it("mounts no surface until a deferred factory has produced the session", async () => {
    let resolve!: (session: FakeSession) => void;
    let context!: DevPreviewToolSessionContext;
    register({
      id: TOOL,
      label: "Picker",
      Button,
      Toolbar,
      Drawer,
      createSession: (next) => {
        context = next;
        return new Promise<FakeSession>((r) => {
          resolve = r;
        });
      },
    });
    render(<Preview />);
    fireEvent.click(screen.getByRole("button", { name: "Picker" }));
    expect(screen.queryByRole("toolbar", { name: "Picker strip" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Picker drawer" })).toBeNull();

    await act(async () => {
      resolve(makeSession(context));
    });
    expect(screen.getByRole("toolbar", { name: "Picker strip" })).toBeTruthy();
    expect(screen.getByTestId("toolbar-session").textContent).not.toBe("no session");
  });

  it("disposes the session when the tool is switched off", () => {
    render(<Preview />);
    fireEvent.click(screen.getByRole("button", { name: "Picker" }));
    const live = session();
    fireEvent.click(screen.getByRole("button", { name: "Close picker" }));
    expect(live.disposals).toBe(1);
    expect(peekDevPreviewToolSession(host.panelId)).toBeNull();
  });

  it("does not carry one tool's failed toolbar into the next tool", () => {
    register({
      id: BROKEN_TOOL,
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
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<Preview />);
      fireEvent.click(screen.getByRole("button", { name: "Broken" }));
      expect(screen.getByText("Broken toolbar stopped working")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Picker" }));
      expect(screen.queryByText("Broken toolbar stopped working")).toBeNull();
      expect(screen.getByRole("toolbar", { name: "Picker strip" })).toBeTruthy();
    } finally {
      errors.mockRestore();
    }
  });
});

/** Re-register the picker with an availability predicate, as a real tool declares one. */
function registerWithAvailability(isAvailable: DevPreviewToolDefinition["isAvailable"]): void {
  register({
    id: TOOL,
    label: "Picker",
    Button,
    Toolbar,
    Drawer,
    createSession: makeSession,
    isAvailable,
    unavailableReason: "The Picker needs something to pick",
  });
}

describe("dev preview tool availability", () => {
  it("hides the toggle where the tool's predicate says it does not apply", async () => {
    registerWithAvailability(() => Promise.resolve(false));
    render(<Preview />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Picker" })).toBeNull();
  });

  it("shows the toggle where the predicate says it applies", async () => {
    registerWithAvailability(() => Promise.resolve(true));
    render(<Preview />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Picker" })).toBeTruthy();
  });

  it("hides a toggle it had shown once the predicate stops applying", async () => {
    let applies = true;
    registerWithAvailability(() => Promise.resolve(applies));
    const view = render(<Preview />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Picker" })).toBeTruthy();

    // The preview moved to a worktree with nothing to pick: the answer earned
    // on the old one must not carry over.
    applies = false;
    view.rerender(<Preview worktreeId="wt-2" />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Picker" })).toBeNull();
  });

  it("keeps an active tool reachable while the predicate has not answered", () => {
    registerWithAvailability(() => new Promise<boolean>(() => {}));
    useDevPreviewToolStore.setState({ activeByPanel: { [host.panelId]: TOOL } });
    render(<Preview />);
    // The one control that switches it off must not vanish under the user.
    expect(screen.getByRole("button", { name: "Picker" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
  });
});

describe("dev preview tool drawer chrome", () => {
  beforeEach(() => {
    useDevPreviewToolStore.getState().setDrawerWidth(360);
  });

  function open(): HTMLElement {
    fireEvent.click(screen.getByRole("button", { name: "Picker" }));
    return screen.getByTestId("dev-preview-tool-drawer");
  }

  it("owns the drawer's width, with a keyboard-resizable handle clamped to its window", () => {
    render(<Preview />);
    const chrome = open();
    expect(chrome.style.width).toBe("360px");

    const handle = screen.getByRole("separator", {
      name: "Resize tool drawer (double-click to reset)",
    });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(chrome.style.width).toBe("376px");

    act(() => useDevPreviewToolStore.getState().setDrawerWidth(2000));
    expect(chrome.style.width).toBe("560px");
    expect(handle.getAttribute("aria-valuemax")).toBe("560");
  });

  it("docks beside the page while the page keeps its own room", () => {
    const { container } = render(<Preview />);
    Object.defineProperty(container, "clientWidth", { value: 1200, configurable: true });
    expect(open().getAttribute("data-floating")).toBeNull();
  });

  it("floats over a preview too narrow to share, rather than squeezing the page", () => {
    const { container } = render(<Preview />);
    Object.defineProperty(container, "clientWidth", { value: 700, configurable: true });
    expect(open().getAttribute("data-floating")).toBe("true");
  });

  it("docks again once a floating drawer's pane grows enough to share", () => {
    const observers: Array<() => void> = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      const { container } = render(<Preview />);
      Object.defineProperty(container, "clientWidth", { value: 700, configurable: true });
      const chrome = open();
      expect(chrome.getAttribute("data-floating")).toBe("true");

      Object.defineProperty(container, "clientWidth", { value: 1200, configurable: true });
      act(() => observers.forEach((notify) => notify()));
      expect(chrome.getAttribute("data-floating")).toBeNull();
      expect(chrome.style.width).toBe("360px");
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it("never covers the whole page, however narrow the preview is", () => {
    const { container } = render(<Preview />);
    Object.defineProperty(container, "clientWidth", { value: 360, configurable: true });
    const chrome = open();
    expect(chrome.getAttribute("data-floating")).toBe("true");
    expect(chrome.style.width).toBe("304px");
  });

  it("returns focus to the toggle when a surface closes the tool", () => {
    render(<Preview />);
    open();
    const close = screen.getByRole("button", { name: "Close picker" });
    close.focus();
    fireEvent.click(close);
    // Never `document.body`: the close control was inside what it closed.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Picker" }));
  });
});
