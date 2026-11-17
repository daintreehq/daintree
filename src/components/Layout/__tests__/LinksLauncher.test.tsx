// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ProjectLink } from "@shared/types";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import type { ForgeCheckRun } from "@shared/types/ipc/forge";
import type { LauncherPullRequest } from "@/hooks/useLinksLauncher";
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
  pullRequest: null as LauncherPullRequest | null,
  getChecks: vi.fn<(cwd: string, prNumber: number) => Promise<{ checks: ForgeCheckRun[] } | null>>(
    () => Promise.resolve({ checks: [] })
  ),
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

/** Replace the active worktree's pull request, as a selection or a PR poll would. */
function setPullRequest(next: LauncherPullRequest | null): void {
  h.pullRequest = next;
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
    useLinksLauncherPullRequest: () => useSyncExternalStore(subscribe, () => h.pullRequest),
    hasLauncherLinks: (l: typeof h.links) => l.projectLinks.length > 0 || l.globalLinks.length > 0,
  };
});
vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    getChecks: (cwd: string, prNumber: number) => h.getChecks(cwd, prNumber),
  },
}));
vi.mock("@/components/Worktree/ReviewHub/usePullRequestTerm", () => ({
  usePullRequestTerm: (providerId: string | null) =>
    providerId === "gitlab.gitlab" ? "merge-request" : "pull-request",
}));
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
  h.pullRequest = null;
  h.getChecks.mockReset();
  h.getChecks.mockImplementation(() => Promise.resolve({ checks: [] }));
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

const PR: LauncherPullRequest = {
  worktreeId: "wt-1",
  worktreePath: "/repo/wt-1",
  worktreeLabel: "feature/login",
  providerId: "github.github",
  number: 42,
  url: "https://github.com/acme/app/pull/42",
  title: "Fix login",
  state: "open",
};
const OTHER_PR: LauncherPullRequest = {
  ...PR,
  worktreeId: "wt-2",
  worktreePath: "/repo/wt-2",
  worktreeLabel: "feature/signup",
  number: 43,
  url: "https://github.com/acme/app/pull/43",
  title: "Add signup",
};
const CHECKS: ForgeCheckRun[] = [
  {
    name: "lint",
    status: "completed",
    conclusion: "success",
    detailsUrl: "https://ci.example.com/lint",
  },
  {
    name: "unit",
    status: "completed",
    conclusion: "failure",
    detailsUrl: "https://ci.example.com/unit",
  },
  { name: "e2e", status: "in_progress", detailsUrl: "https://ci.example.com/e2e" },
  { name: "deploy", status: "queued", detailsUrl: "https://ci.example.com/deploy" },
  { name: "docs", status: "completed", conclusion: "failure" },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("the active worktree's pull request in the launcher", () => {
  async function openLauncher() {
    render(<LinksLauncherToolbarButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Links" }));
    });
    await flush();
  }

  it("lists it after the person's links, with only the checks failing or running that have a page", async () => {
    h.pullRequest = PR;
    h.getChecks.mockResolvedValue({ checks: CHECKS });
    h.devSessions.sessions = [devSession()];
    await openLauncher();

    expect(headings()).toEqual([
      "Project links",
      "Your links",
      "Pull request feature/login",
      "Dev servers",
    ]);
    expect(h.getChecks).toHaveBeenCalledTimes(1);
    expect(h.getChecks).toHaveBeenCalledWith("/repo/wt-1", 42);
    expect(rows().slice(3).map(describeRow)).toEqual([
      { name: "Fix login", description: "PR #42 · Open" },
      { name: "unit", description: "Failed" },
      { name: "e2e", description: "Running" },
    ]);

    await act(async () => {
      fireEvent.click(rows()[4]!, { detail: 1 });
    });
    await flush();
    expect(h.openLinkUrl).toHaveBeenCalledWith("https://ci.example.com/unit");
    expect(launcher()).toBeNull();
  });

  it("opens the pull request itself", async () => {
    h.pullRequest = PR;
    await openLauncher();
    await act(async () => {
      fireEvent.click(rows()[3]!, { detail: 1 });
    });
    expect(h.openLinkUrl).toHaveBeenCalledWith("https://github.com/acme/app/pull/42");
  });

  it("reads the checks once per opening, never on a refresh or a pull request update", async () => {
    h.pullRequest = PR;
    await openLauncher();
    expect(h.getChecks).toHaveBeenCalledTimes(1);

    await act(async () => {
      useLinksLauncherStore.getState().open("button");
    });
    await act(async () => {
      setPullRequest({ ...PR, title: "Fix login flow", state: "merged" });
    });
    await flush();
    expect(h.getChecks).toHaveBeenCalledTimes(1);
    expect(describeRow(rows()[3]!)).toEqual({
      name: "Fix login flow",
      description: "PR #42 · Merged",
    });

    const button = screen.getByRole("button", { name: "Links" });
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      fireEvent.click(button);
    });
    await flush();
    expect(h.getChecks).toHaveBeenCalledTimes(2);
  });

  it("reads nothing while closed, and once for the host that opened, under StrictMode", async () => {
    h.pullRequest = PR;
    render(
      <StrictMode>
        <LinksLauncherToolbarButton />
        <LinksLauncherDetachedHost />
      </StrictMode>
    );
    await flush();
    expect(h.getChecks).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Links" }));
    });
    await flush();
    expect(h.getChecks).toHaveBeenCalledTimes(1);
  });

  it("switches with the active worktree, keeping a late read for the one before off it", async () => {
    const first = deferred<{ checks: ForgeCheckRun[] } | null>();
    const second = deferred<{ checks: ForgeCheckRun[] } | null>();
    h.getChecks.mockImplementationOnce(() => first.promise);
    h.getChecks.mockImplementationOnce(() => second.promise);
    h.links = { projectLinks: [], globalLinks: [] };
    h.pullRequest = PR;
    await openLauncher();

    await act(async () => {
      setPullRequest(OTHER_PR);
    });
    await flush();
    expect(h.getChecks).toHaveBeenNthCalledWith(2, "/repo/wt-2", 43);
    expect(headings()).toEqual(["Pull request feature/signup"]);

    await act(async () => {
      second.resolve({
        checks: [
          {
            name: "lint",
            status: "completed",
            conclusion: "timed_out",
            detailsUrl: "https://ci.example.com/lint",
          },
        ],
      });
    });
    await flush();
    const signupRows = [
      { name: "Add signup", description: "PR #43 · Open" },
      { name: "lint", description: "Timed out" },
    ];
    expect(rows().map(describeRow)).toEqual(signupRows);

    await act(async () => {
      first.resolve({ checks: CHECKS });
    });
    await flush();
    expect(rows().map(describeRow)).toEqual(signupRows);
  });

  it("stops showing the checks of the one before as soon as another is selected", async () => {
    h.getChecks.mockResolvedValueOnce({ checks: CHECKS });
    h.getChecks.mockImplementation(() => new Promise(() => {}));
    h.links = { projectLinks: [], globalLinks: [] };
    h.pullRequest = PR;
    await openLauncher();
    expect(rows().map((row) => describeRow(row).name)).toEqual(["Fix login", "unit", "e2e"]);

    await act(async () => {
      setPullRequest(OTHER_PR);
    });
    expect(rows().map((row) => describeRow(row).name)).toEqual(["Add signup"]);
  });

  it("reads again for a pull request selected a second time, showing nothing of the first read", async () => {
    const third = deferred<{ checks: ForgeCheckRun[] } | null>();
    h.getChecks.mockResolvedValueOnce({ checks: CHECKS });
    h.getChecks.mockImplementationOnce(() => new Promise(() => {}));
    h.getChecks.mockImplementationOnce(() => third.promise);
    h.links = { projectLinks: [], globalLinks: [] };
    h.pullRequest = PR;
    await openLauncher();
    expect(rows().map((row) => describeRow(row).name)).toEqual(["Fix login", "unit", "e2e"]);

    await act(async () => {
      setPullRequest(OTHER_PR);
    });
    await flush();
    await act(async () => {
      setPullRequest(PR);
    });
    await flush();
    expect(h.getChecks).toHaveBeenCalledTimes(3);
    expect(rows().map((row) => describeRow(row).name)).toEqual(["Fix login"]);

    await act(async () => {
      third.resolve({
        checks: [
          {
            name: "lint",
            status: "completed",
            conclusion: "timed_out",
            detailsUrl: "https://ci.example.com/lint",
          },
        ],
      });
    });
    await flush();
    expect(rows().map((row) => describeRow(row).name)).toEqual(["Fix login", "lint"]);
  });

  it("keeps a late failure for the pull request before off the new one", async () => {
    const first = deferred<{ checks: ForgeCheckRun[] } | null>();
    h.getChecks.mockImplementationOnce(() => first.promise);
    h.getChecks.mockImplementationOnce(() =>
      Promise.resolve({
        checks: [
          {
            name: "lint",
            status: "completed",
            conclusion: "timed_out",
            detailsUrl: "https://ci.example.com/lint",
          },
        ],
      })
    );
    h.links = { projectLinks: [], globalLinks: [] };
    h.pullRequest = PR;
    await openLauncher();
    await act(async () => {
      setPullRequest(OTHER_PR);
    });
    await flush();
    expect(rows().map((row) => describeRow(row).name)).toEqual(["Add signup", "lint"]);

    await act(async () => {
      first.reject(new Error("rate limited"));
    });
    await flush();
    expect(within(launcher()!).queryByText("Couldn't load checks")).toBeNull();
    expect(rows().map((row) => describeRow(row).name)).toEqual(["Add signup", "lint"]);
  });

  it("keeps the keyboard in the list when the check it was on goes away", async () => {
    h.pullRequest = PR;
    h.getChecks.mockResolvedValueOnce({ checks: CHECKS });
    h.getChecks.mockImplementation(() => new Promise(() => {}));
    await openLauncher();
    const check = rows().find((row) => describeRow(row).name === "unit")!;
    act(() => check.focus());

    await act(async () => {
      setPullRequest(OTHER_PR);
    });
    await flush();

    expect(check.isConnected).toBe(false);
    expect(document.activeElement).toBe(rows()[0]);
    expect(launcher()).not.toBeNull();
  });

  it("says when the checks couldn't be read, and keeps the pull request", async () => {
    h.pullRequest = PR;
    h.getChecks.mockRejectedValue(new Error("rate limited"));
    await openLauncher();
    expect(within(launcher()!).getByText("Couldn't load checks")).toBeTruthy();
    expect(
      rows()
        .slice(3)
        .map((row) => describeRow(row).name)
    ).toEqual(["Fix login"]);
  });

  it("leaves the pull request out once the forge says it doesn't exist", async () => {
    h.links = { projectLinks: [], globalLinks: [] };
    h.pullRequest = PR;
    h.getChecks.mockResolvedValue(null);
    await openLauncher();
    expect(headings()).toEqual([]);
    expect(rows()).toEqual([]);
    expect(within(launcher()!).getByRole("button", { name: "Add a project link" })).toBeTruthy();
  });

  it("shows it alone, with no prompt to add a link, when there is nothing else", async () => {
    h.links = { projectLinks: [], globalLinks: [] };
    h.pullRequest = PR;
    await openLauncher();
    expect(headings()).toEqual(["Pull request feature/login"]);
    expect(within(launcher()!).queryByRole("button", { name: "Add a project link" })).toBeNull();
  });

  it("leaves the section out once the worktree has no pull request, keeping the keyboard", async () => {
    h.pullRequest = PR;
    await openLauncher();
    const prRow = rows()[3]!;
    act(() => prRow.focus());
    await act(async () => {
      setPullRequest(null);
    });
    expect(headings()).toEqual(["Project links", "Your links"]);
    expect(prRow.isConnected).toBe(false);
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("uses the forge's own word for a merge request", async () => {
    h.pullRequest = {
      ...PR,
      providerId: "gitlab.gitlab",
      url: "https://gitlab.example.com/acme/app/-/merge_requests/42",
      title: undefined,
      state: "merged",
    };
    await openLauncher();
    expect(headings()).toContain("Merge request feature/login");
    expect(describeRow(rows()[3]!)).toEqual({
      name: "Merge request !42",
      description: "MR !42 · Merged",
    });
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

  it("offers the pull request as a row, and one row for its checks, reading none itself", async () => {
    h.links = { projectLinks: [], globalLinks: [DOCS] };
    h.pullRequest = PR;
    render(<OverflowMenu />);
    await openMenu();

    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Team docsdocs.example.org",
      "Fix loginPR #42 · Open",
      "Checks…",
    ]);
    expect(h.getChecks).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(items[1]!);
    });
    await flush();
    expect(h.openLinkUrl).toHaveBeenCalledWith("https://github.com/acme/app/pull/42");
  });

  it("asks for the launcher from the checks row once the menu closes", async () => {
    h.pullRequest = PR;
    render(<OverflowMenu />);
    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Checks…" }));
    });
    await flush();
    expect(useLinksLauncherStore.getState().deferredFromOverflow).toBe("right");
    expect(h.openLinkUrl).not.toHaveBeenCalled();
    expect(h.getChecks).not.toHaveBeenCalled();
  });

  it("has no dev servers row while none is listed", async () => {
    h.devSessions.sessions = [devSession({ status: "stopped" })];
    render(<OverflowMenu />);
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /Dev servers/ })).toBeNull();
  });
});
