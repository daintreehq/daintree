// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ProjectLink } from "@shared/types";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import type { GlobalLink } from "@/store/globalLinksStore";
import { primeRadix } from "@/components/ui/radix-loader";

const h = vi.hoisted(() => ({
  dispatch: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean }>>(() =>
    Promise.resolve({ ok: true })
  ),
  openLinkUrl: vi.fn<(url: string) => Promise<void>>(() => Promise.resolve()),
  enterFocusedPanel: vi.fn<(id: string | null) => boolean>(() => true),
  links: {
    projectLinks: [] as ProjectLink[],
    globalLinks: [] as GlobalLink[],
  },
  devSessions: {
    sessions: [] as DevPreviewSessionState[],
    hydrated: true,
    fetchError: false,
  },
  listeners: new Set<() => void>(),
  restart: vi.fn((_target: unknown) => Promise.resolve()),
  stop: vi.fn((_target: unknown) => Promise.resolve()),
}));

function notify(): void {
  for (const listener of h.listeners) listener();
}

/** Replace what the launcher lists, as a refresh landing would. */
function setLinks(next: typeof h.links): void {
  h.links = next;
  notify();
}

/** Replace the dev servers, as a pushed snapshot would. */
function setDevSessions(sessions: DevPreviewSessionState[]): void {
  h.devSessions = { sessions, hydrated: true, fetchError: false };
  notify();
}

function devSession(overrides: Partial<DevPreviewSessionState> = {}): DevPreviewSessionState {
  return {
    panelId: "panel-1",
    projectId: "project-1",
    worktreeId: "wt-1",
    status: "running",
    url: "http://localhost:3000",
    predictedUrl: "http://localhost:3000",
    error: null,
    terminalId: "t-1",
    isRestarting: false,
    generation: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function subscribe(listener: () => void): () => void {
  h.listeners.add(listener);
  return () => h.listeners.delete(listener);
}

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => h.dispatch(...args) },
}));
vi.mock("@/hooks", () => ({
  useAriaKeyshortcuts: () => undefined,
  useEffectiveCombo: () => "",
}));
vi.mock("../ToolbarContextMenuItems", () => ({ ToolbarContextMenuItems: () => null }));
vi.mock("@/services/openLinkUrl", () => ({
  openLinkUrl: (url: string) => h.openLinkUrl(url),
  opensInPanel: (url: string) => url.startsWith("http://localhost"),
}));
vi.mock("@/components/Terminal/contentGridFocus", () => ({
  enterFocusedPanel: (id: string | null) => h.enterFocusedPanel(id),
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ focusedId: "t1" }) },
}));
vi.mock("@/hooks/useLinksLauncher", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useLinksLauncherLinks: () => useSyncExternalStore(subscribe, () => h.links),
    hasLauncherLinks: (l: typeof h.links) => l.projectLinks.length > 0 || l.globalLinks.length > 0,
  };
});
vi.mock("@/store/allDevSessionsStore", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useAllDevSessions: () => useSyncExternalStore(subscribe, () => h.devSessions) };
});
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: unknown) => unknown) =>
    selector({ worktrees: new Map([["wt-1", { id: "wt-1", name: "feature-foo" }]]) }),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) => selector({ projects: [] }),
}));
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (selector: (s: unknown) => unknown) => selector({ scratches: [] }),
  scratchName: () => null,
}));

const {
  LinksLauncherToolbarButton,
  LinksLauncherDetachedHost,
  LinksLauncherOverflowItems,
  closeLinksLauncherForHiddenButton,
} = await import("../LinksLauncher");
const { useLinksLauncherStore } = await import("@/store/linksLauncherStore");
const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } =
  await import("@/components/ui/dropdown-menu");

const STAGING: ProjectLink = {
  id: "l1",
  title: "Staging",
  url: "https://staging.example.com/app",
  addedByAssistant: true,
};
const LOCAL: ProjectLink = { id: "l2", title: "Local app", url: "http://localhost:3000/" };
const DOCS: GlobalLink = {
  id: "user-1",
  title: "Team docs",
  url: "https://docs.example.org/handbook",
  icon: "globe",
  enabled: true,
  order: 0,
};

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const launcher = () => document.querySelector<HTMLElement>('[data-testid="links-launcher"]');

function headings(): Array<string | null> {
  return Array.from(launcher()?.querySelectorAll("h2") ?? []).map((h2) => h2.textContent);
}

/** Accessible name and description of a row, read off its id references. */
function describeRow(row: HTMLElement): { name: string; description: string } {
  const text = (ids: string | null) =>
    (ids ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  return {
    name: text(row.getAttribute("aria-labelledby")),
    description: text(row.getAttribute("aria-describedby")),
  };
}

function rows(): HTMLElement[] {
  return Array.from(launcher()?.querySelectorAll<HTMLElement>("li > button") ?? []);
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  h.dispatch.mockClear();
  h.openLinkUrl.mockClear();
  h.enterFocusedPanel.mockClear();
  h.restart.mockClear();
  h.stop.mockClear();
  h.links = { projectLinks: [STAGING, LOCAL], globalLinks: [DOCS] };
  h.devSessions = { sessions: [], hydrated: true, fetchError: false };
  Reflect.set(window, "electron", { devPreview: { restart: h.restart, stop: h.stop } });
  useLinksLauncherStore.setState({
    opening: null,
    refreshSeq: 0,
    closeFocus: null,
    detachedRestore: null,
    deferredFromOverflow: null,
  });
});

afterEach(() => {
  cleanup();
});

describe("links launcher button", () => {
  it("opens a popover listing the project's links, then the person's, each with title and host", async () => {
    render(<LinksLauncherToolbarButton data-toolbar-item="" />);
    const button = screen.getByRole("button", { name: "Links" });
    expect(launcher()).toBeNull();

    await act(async () => {
      fireEvent.click(button);
    });
    await flush();

    expect(launcher()?.getAttribute("aria-label")).toBe("Links");
    const headings = Array.from(launcher()!.querySelectorAll("h2")).map((h2) => h2.textContent);
    expect(headings).toEqual(["Project links", "Your links"]);
    expect(rows().map(describeRow)).toEqual([
      { name: "Staging", description: "staging.example.com, added by the Assistant" },
      { name: "Local app", description: "localhost" },
      { name: "Team docs", description: "docs.example.org" },
    ]);
    // The visible badge is for sighted users; the description already says it.
    const badges = Array.from(launcher()!.querySelectorAll('[aria-hidden="true"]')).filter(
      (el) => el.textContent === "Assistant"
    );
    expect(badges).toHaveLength(1);
    // Every row is a native button in the tab order.
    for (const row of rows()) {
      expect(row.tagName).toBe("BUTTON");
      expect(row.getAttribute("tabindex")).not.toBe("-1");
    }
  });

  it("opens the picked link and closes", async () => {
    render(<LinksLauncherToolbarButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Links" }));
    });
    await flush();

    await act(async () => {
      fireEvent.click(rows()[2]!, { detail: 1 });
    });
    await flush();

    expect(h.openLinkUrl).toHaveBeenCalledWith("https://docs.example.org/handbook");
    expect(useLinksLauncherStore.getState().opening).toBeNull();
    expect(launcher()).toBeNull();
  });

  it("bumps the refresh on every opening", async () => {
    render(<LinksLauncherToolbarButton />);
    const button = screen.getByRole("button", { name: "Links" });
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(useLinksLauncherStore.getState().refreshSeq).toBe(2);
  });

  it("keeps the keyboard in the list when a refresh removes the row it was on", async () => {
    render(<LinksLauncherToolbarButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Links" }));
    });
    await flush();
    act(() => rows()[0]!.focus());

    await act(async () => {
      setLinks({ projectLinks: [LOCAL], globalLinks: [DOCS] });
    });

    expect(rows().map((row) => describeRow(row).name)).toEqual(["Local app", "Team docs"]);
    expect(document.activeElement).toBe(rows()[0]);
    expect(launcher()).not.toBeNull();
  });

  it("leaves focus alone when a refresh changes rows it isn't on", async () => {
    render(<LinksLauncherToolbarButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Links" }));
    });
    await flush();
    act(() => rows()[2]!.focus());

    await act(async () => {
      setLinks({ projectLinks: [LOCAL], globalLinks: [DOCS] });
    });
    // Still on the same link, now the second row.
    expect(document.activeElement).toBe(rows()[1]);
  });

  it("drops its opening when it leaves the toolbar while open", async () => {
    const { unmount } = render(<LinksLauncherToolbarButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Links" }));
    });
    expect(useLinksLauncherStore.getState().opening?.origin).toBe("button");
    unmount();
    expect(useLinksLauncherStore.getState().opening).toBeNull();
  });

  it("hands focus inside it to the `…` button when the button goes into overflow", async () => {
    const trigger = document.createElement("button");
    trigger.setAttribute("data-toolbar-overflow-trigger", "");
    trigger.setAttribute("data-toolbar-overflow-side", "right");
    trigger.setAttribute("data-visible", "true");
    document.body.appendChild(trigger);
    try {
      render(<LinksLauncherToolbarButton />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Links" }));
      });
      await flush();
      act(() => rows()[0]!.focus());

      await act(async () => {
        closeLinksLauncherForHiddenButton("right");
      });
      await flush();

      expect(launcher()).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  it("leaves a launcher opened elsewhere alone when the button is hidden", () => {
    useLinksLauncherStore.getState().open("detached");
    closeLinksLauncherForHiddenButton("left");
    expect(useLinksLauncherStore.getState().opening?.origin).toBe("detached");
  });

  it("gives focus inside it to the focused panel when it leaves the toolbar while open", async () => {
    const { unmount } = render(<LinksLauncherToolbarButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Links" }));
    });
    await flush();
    act(() => rows()[0]!.focus());

    unmount();
    expect(h.enterFocusedPanel).not.toHaveBeenCalled();
    await flush();

    expect(useLinksLauncherStore.getState().opening).toBeNull();
    expect(h.enterFocusedPanel).toHaveBeenCalledWith("t1");
  });

  it("leaves focus outside it alone when it leaves the toolbar while open", async () => {
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    try {
      const { unmount } = render(<LinksLauncherToolbarButton />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Links" }));
      });
      await flush();
      act(() => elsewhere.focus());

      unmount();
      await flush();

      expect(h.enterFocusedPanel).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });
});

describe("dev servers in the launcher", () => {
  async function openLauncher() {
    render(<LinksLauncherToolbarButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Links" }));
    });
    await flush();
  }

  it("lists them after the links, each with its own controls", async () => {
    h.devSessions.sessions = [
      devSession(),
      devSession({ panelId: "panel-2", status: "stopped", worktreeId: "wt-2" }),
    ];
    await openLauncher();

    expect(headings()).toEqual(["Project links", "Your links", "Dev servers"]);
    expect(within(launcher()!).getByText("1 running")).toBeTruthy();
    await act(async () => {
      fireEvent.click(
        within(launcher()!).getByRole("button", { name: "Stop dev server for feature-foo" })
      );
    });
    expect(h.stop).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
    // A plain stopped server has no row.
    expect(within(launcher()!).queryByText("wt-2")).toBeNull();
    // Acting on a server keeps the launcher open.
    expect(launcher()).not.toBeNull();
  });

  it("shows them alone, with no prompt to add a link, when there are no links", async () => {
    h.links = { projectLinks: [], globalLinks: [] };
    h.devSessions.sessions = [devSession({ status: "error", terminalId: null })];
    await openLauncher();

    expect(headings()).toEqual(["Dev servers"]);
    expect(within(launcher()!).queryByRole("button", { name: "Add a project link" })).toBeNull();
    expect(
      within(launcher()!).getByRole("button", { name: "Dismiss error for feature-foo" })
    ).toBeTruthy();
  });

  it("leaves the section out when no server is listed", async () => {
    h.devSessions.sessions = [devSession({ status: "stopped" })];
    await openLauncher();
    expect(headings()).toEqual(["Project links", "Your links"]);
  });

  it("keeps the keyboard in the list when the server it was on stops", async () => {
    h.links = { projectLinks: [], globalLinks: [DOCS] };
    h.devSessions.sessions = [devSession()];
    await openLauncher();
    const stop = within(launcher()!).getByRole("button", {
      name: "Stop dev server for feature-foo",
    });
    act(() => stop.focus());

    await act(async () => {
      setDevSessions([devSession({ status: "stopped", terminalId: null })]);
    });

    expect(headings()).toEqual(["Your links"]);
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("hands focus to the focused panel when stopping the last server takes the button away", async () => {
    h.links = { projectLinks: [], globalLinks: [] };
    h.devSessions.sessions = [devSession()];
    // The toolbar's own rule: shown only with a link or a live server.
    function Toolbar() {
      const { sessions } = useSyncExternalStore(subscribe, () => h.devSessions);
      const live = sessions.some((s) => s.status !== "stopped" && s.status !== "restored-stopped");
      return live ? <LinksLauncherToolbarButton /> : null;
    }
    render(<Toolbar />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Links" }));
    });
    await flush();
    const stop = within(launcher()!).getByRole("button", {
      name: "Stop dev server for feature-foo",
    });
    act(() => stop.focus());

    await act(async () => {
      setDevSessions([devSession({ status: "stopping" })]);
    });
    // Going down keeps the keyboard where it was.
    expect(document.activeElement).toBe(stop);
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect((stop as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      setDevSessions([devSession({ status: "stopped", terminalId: null })]);
    });
    await flush();

    expect(screen.queryByRole("button", { name: "Links" })).toBeNull();
    expect(launcher()).toBeNull();
    expect(useLinksLauncherStore.getState().opening).toBeNull();
    expect(h.enterFocusedPanel).toHaveBeenCalledWith("t1");
  });
});

describe("detached launcher", () => {
  it("opens only for a detached opening and gives stranded focus to the focused panel on Escape", async () => {
    render(
      <>
        <LinksLauncherToolbarButton />
        <LinksLauncherDetachedHost />
      </>
    );
    expect(launcher()).toBeNull();

    await act(async () => {
      useLinksLauncherStore.getState().open("detached");
    });
    await flush();
    expect(document.querySelectorAll('[data-testid="links-launcher"]')).toHaveLength(1);
    expect(rows()).toHaveLength(3);

    act(() => rows()[0]!.focus());
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    });
    await flush();
    await flush();

    expect(launcher()).toBeNull();
    expect(h.enterFocusedPanel).toHaveBeenCalledWith("t1");
  });

  it("returns focus to where the palette was opened from when it closes", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    try {
      render(<LinksLauncherDetachedHost />);
      await act(async () => {
        useLinksLauncherStore.getState().open("detached");
        useLinksLauncherStore.setState({ detachedRestore: () => opener.focus() });
      });
      await flush();
      act(() => rows()[0]!.focus());

      await act(async () => {
        fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      });
      await flush();
      await flush();

      expect(launcher()).toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(h.enterFocusedPanel).not.toHaveBeenCalled();
      expect(useLinksLauncherStore.getState().detachedRestore).toBeNull();
    } finally {
      opener.remove();
    }
  });

  it("names the next step when there is nothing to list", async () => {
    h.links = { projectLinks: [], globalLinks: [] };
    render(<LinksLauncherDetachedHost />);
    await act(async () => {
      useLinksLauncherStore.getState().open("detached");
    });
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add a project link" }));
    });
    expect(h.dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "project:general", sectionId: "project-links" },
      { source: "user" }
    );
    expect(useLinksLauncherStore.getState().opening).toBeNull();
  });
});

describe("links in the `…` menu", () => {
  function OverflowMenu() {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">More</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <LinksLauncherOverflowItems side="right" />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  async function openMenu() {
    const trigger = screen.getByRole("button", { name: "More" });
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter" });
    });
    await flush();
  }

  it("lists every link as a menu row, re-reading the project's list on each opening", async () => {
    render(<OverflowMenu />);
    expect(useLinksLauncherStore.getState().refreshSeq).toBe(0);
    await openMenu();

    expect(useLinksLauncherStore.getState().refreshSeq).toBe(1);
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual([
      "Stagingstaging.example.com, added by the AssistantAssistant",
      "Local applocalhost",
      "Team docsdocs.example.org",
    ]);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("menuitem")[1]!);
    });
    await flush();
    expect(h.openLinkUrl).toHaveBeenCalledWith("http://localhost:3000/");
  });

  it("offers one row for the dev servers, which asks for the launcher once the menu closes", async () => {
    h.links = { projectLinks: [], globalLinks: [DOCS] };
    h.devSessions.sessions = [
      devSession(),
      devSession({ panelId: "panel-2", worktreeId: "wt-2", status: "error", terminalId: null }),
    ];
    render(<OverflowMenu />);
    await openMenu();

    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Team docsdocs.example.org",
      "Dev servers…1 running · 1 failed",
    ]);
    // No server's own controls inside the menu.
    expect(screen.queryByRole("button", { name: /dev server for/ })).toBeNull();

    await act(async () => {
      fireEvent.click(items[1]!);
    });
    await flush();

    expect(useLinksLauncherStore.getState().deferredFromOverflow).toBe("right");
    expect(useLinksLauncherStore.getState().opening).toBeNull();
    expect(h.openLinkUrl).not.toHaveBeenCalled();
  });

  it("has no dev servers row while none is listed", async () => {
    h.devSessions.sessions = [devSession({ status: "stopped" })];
    render(<OverflowMenu />);
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /Dev servers/ })).toBeNull();
  });
});
