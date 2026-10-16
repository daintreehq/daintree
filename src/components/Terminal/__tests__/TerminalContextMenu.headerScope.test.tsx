// @vitest-environment jsdom
/**
 * Outside a terminal, the panel menu belongs to the title bar (#13422): a
 * right-click in a file's text or a tree row is about what is under the
 * pointer, not about the panel. A terminal's content has no menu of its own,
 * so a terminal pane keeps the whole surface as the trigger.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import { openPanelContextMenu } from "@/lib/panelContextMenu";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(), get: () => undefined, list: () => [] },
}));
vi.mock("@/hooks/useSidebarWorktreeOrder", () => ({ useSidebarWorktreeOrder: () => [] }));
vi.mock("@/hooks/useIsHibernated", () => ({ useIsHibernated: () => false }));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({ usePluginContextMenuItems: () => [] }));
vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: (selector: (s: unknown) => unknown) =>
    selector({ lockedTarget: null, recentTargets: [] }),
}));
vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: (selector: (s: { armedIds: Set<string> }) => unknown) =>
    selector({ armedIds: new Set<string>() }),
  isFleetArmEligible: () => false,
}));

const panelsById = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@/store", () => {
  const state = () => ({
    panelsById: panelsById.current,
    maximizeTarget: null,
    getPanelGroup: () => undefined,
    watchedPanels: new Set<string>(),
  });
  const usePanelStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state());
  usePanelStore.getState = state;
  return { usePanelStore };
});

import { TerminalContextMenu } from "../TerminalContextMenu";
import { PanelContextMenuTrigger } from "../PanelContextMenuTrigger";

// One panel per non-PTY branch of the menu: each renders its own trigger.
const NON_PTY_BRANCHES: Array<[string, Record<string, unknown>]> = [
  ["browser", { kind: "browser", browserUrl: "https://example.com" }],
  ["dev-preview", { kind: "dev-preview", browserUrl: "http://localhost:3000" }],
  ["file", { kind: "file", filePath: "/repo/README.md" }],
  ["diff", { kind: "diff" }],
  ["plugin", { kind: "acme.dashboard", pluginId: "acme" }],
];

function renderPanel(
  triggerScope?: "surface" | "header",
  fields: Record<string, unknown> = NON_PTY_BRANCHES[0]![1]
) {
  panelsById.current = { page: { id: "page", title: "Page", location: "grid", ...fields } };
  return render(
    <TerminalContextMenu terminalId="page" forceLocation="grid" triggerScope={triggerScope}>
      <div data-panel-id="page" tabIndex={-1}>
        <PanelContextMenuTrigger>
          <div>Title bar</div>
        </PanelContextMenuTrigger>
        <div>Panel body</div>
      </div>
    </TerminalContextMenu>
  );
}

function rightClick(text: string) {
  act(() => {
    fireEvent.contextMenu(screen.getByText(text), { clientX: 10, clientY: 10 });
  });
}

const menuItem = () => document.querySelector('[role="menu"]');

beforeAll(async () => {
  await primeRadix();
});

afterEach(() => {
  cleanup();
});

describe("TerminalContextMenu — header-scoped trigger", () => {
  it.each(NON_PTY_BRANCHES)("opens a %s panel's menu from the title bar", (_, fields) => {
    renderPanel("header", fields);
    rightClick("Title bar");
    expect(menuItem()).not.toBeNull();
  });

  it.each(NON_PTY_BRANCHES)(
    "leaves a right-click in a %s panel's body to the body",
    (_, fields) => {
      renderPanel("header", fields);
      const body = screen.getByText("Panel body");
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      act(() => {
        body.dispatchEvent(event);
      });
      expect(menuItem()).toBeNull();
      expect(event.defaultPrevented).toBe(false);
    }
  );

  it("marks only the title bar as the panel's trigger", () => {
    const { container } = renderPanel("header");
    const triggers = container.querySelectorAll('[data-context-trigger="page"]');
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.textContent).toBe("Title bar");
  });

  it("still opens from the keyboard route", () => {
    renderPanel("header");
    let opened = false;
    act(() => {
      opened = openPanelContextMenu("page");
    });
    expect(opened).toBe(true);
    expect(menuItem()).not.toBeNull();
  });
});

describe("TerminalContextMenu — surface-scoped trigger", () => {
  it("opens from anywhere in the panel, the body included", () => {
    renderPanel();
    rightClick("Panel body");
    expect(menuItem()).not.toBeNull();
  });

  it("keeps the header slot inert when the panel record is gone", () => {
    panelsById.current = {};
    const { container } = render(
      <TerminalContextMenu terminalId="page" forceLocation="grid" triggerScope="header">
        <PanelContextMenuTrigger>
          <div>Title bar</div>
        </PanelContextMenuTrigger>
      </TerminalContextMenu>
    );
    expect(screen.getByText("Title bar")).toBeTruthy();
    expect(container.querySelector("[data-context-trigger]")).toBeNull();
    rightClick("Title bar");
    expect(menuItem()).toBeNull();
  });

  it("treats the header slot as plain content", () => {
    const { container } = renderPanel("surface");
    const triggers = container.querySelectorAll('[data-context-trigger="page"]');
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.textContent).toBe("Title barPanel body");
  });
});
