// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProjectLink } from "@shared/types";
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
  listeners: new Set<() => void>(),
}));

/** Replace what the launcher lists, as a refresh landing would. */
function setLinks(next: typeof h.links): void {
  h.links = next;
  for (const listener of h.listeners) listener();
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
    useLinksLauncherLinks: () =>
      useSyncExternalStore(
        (listener) => {
          h.listeners.add(listener);
          return () => h.listeners.delete(listener);
        },
        () => h.links
      ),
    hasLauncherLinks: (l: typeof h.links) => l.projectLinks.length > 0 || l.globalLinks.length > 0,
  };
});

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
  h.links = { projectLinks: [STAGING, LOCAL], globalLinks: [DOCS] };
  useLinksLauncherStore.setState({
    opening: null,
    refreshSeq: 0,
    closeFocus: null,
    paletteRestore: null,
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
        useLinksLauncherStore.setState({ paletteRestore: () => opener.focus() });
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
      expect(useLinksLauncherStore.getState().paletteRestore).toBeNull();
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
          <LinksLauncherOverflowItems />
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
});
