// @vitest-environment jsdom
/**
 * A right-click menu belongs to the object under the pointer.
 *
 * Session rows sit inside the worktree card's own trigger. Without a menu of
 * their own, a right-click on a terminal row bubbled up and offered worktree
 * actions for a session.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";
import type { ReactNode } from "react";
import type { PtyPanelData } from "@shared/types/panel";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const { dispatch } = vi.hoisted(() => ({
  dispatch: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  verticalListSortingStrategy: {},
}));
vi.mock("@/components/DragDrop/SortableWorktreeTerminal", () => ({
  SortableWorktreeTerminal: ({ children }: { children: ReactNode }) => <>{children}</>,
  getAccordionDragId: (id: string) => `accordion-${id}`,
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch, get: () => undefined, list: () => [] },
}));
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: () => undefined,
    getHoveredLinkText: () => null,
    getHoveredFilePath: () => null,
    getHoveredFileKind: () => null,
  },
}));
vi.mock("@/hooks/useSidebarWorktreeOrder", () => ({ useSidebarWorktreeOrder: () => [] }));
vi.mock("@/hooks/useIsHibernated", () => ({ useIsHibernated: () => false }));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({ usePluginContextMenuItems: () => [] }));
vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: (selector: (s: unknown) => unknown) =>
    selector({ lockedTarget: null, recentTargets: [] }),
}));

function session(id: string): PtyPanelData {
  return {
    id,
    pid: 1,
    title: `Session ${id}`,
    kind: "terminal",
    location: "grid",
    worktreeId: "wt-1",
    lastActivityTimestamp: 0,
    cwd: "/repo",
    cols: 80,
    rows: 24,
  } as PtyPanelData;
}

const sessions = [session("one"), session("two")];

vi.mock("@/store", () => {
  const state = () => ({
    panelsById: Object.fromEntries(sessions.map((s) => [s.id, s])),
    maximizeTarget: null,
    getPanelGroup: () => undefined,
    watchedPanels: new Set<string>(),
  });
  const usePanelStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state());
  usePanelStore.getState = state;
  return { usePanelStore };
});

import { WorktreeTerminalSection } from "../WorktreeTerminalSection";

const CARD_ITEM = "Worktree card item";

/** The sidebar's shape: the section sits inside the card's own trigger. */
function renderInCard() {
  return render(
    <TooltipProvider>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <WorktreeTerminalSection
              worktreeId="wt-1"
              isExpanded
              counts={{
                total: 2,
                byState: { idle: 2, working: 0, waiting: 0, directing: 0, completed: 0, exited: 0 },
              }}
              terminals={sessions}
              onToggle={() => {}}
              onTerminalSelect={() => {}}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>{CARD_ITEM}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </TooltipProvider>
  );
}

function row(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-session-row][data-terminal-id="${id}"]`)!;
}

beforeAll(async () => {
  await primeRadix();
  // Opening a session's menu asks which panes could take it over.
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { mcpServer: { listOrchestratorPanes: () => Promise.resolve([]) } },
  });
});

afterEach(() => {
  cleanup();
  dispatch.mockReset();
});

describe("WorktreeTerminalSection — a session row owns its menu", () => {
  it("opens the session's menu, not the worktree card's", async () => {
    renderInCard();

    fireEvent.contextMenu(row("two"));
    const menu = await screen.findByRole("menu");

    expect(within(menu).getByRole("menuitem", { name: "Rename terminal" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: CARD_ITEM })).toBeNull();
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("scopes the menu to the row under the pointer", async () => {
    dispatch.mockResolvedValue({ ok: true });
    renderInCard();

    fireEvent.contextMenu(row("two"));
    const menu = await screen.findByRole("menu");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename terminal" }));
    });

    expect(dispatch).toHaveBeenCalledWith(
      "terminal.rename",
      { terminalId: "two" },
      expect.anything()
    );
  });

  it("leaves the card's menu to the card's own surface", async () => {
    renderInCard();

    fireEvent.contextMenu(screen.getByRole("button", { name: /sessions?/i, expanded: true }));

    expect(await screen.findByRole("menuitem", { name: CARD_ITEM })).toBeTruthy();
  });
});
