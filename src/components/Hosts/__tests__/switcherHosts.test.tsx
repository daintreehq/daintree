// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HostConnectionState, HostListEntry } from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";

const { supported, dispatch } = vi.hoisted(() => ({
  supported: { value: true },
  dispatch: vi.fn(() => Promise.resolve({ ok: true, result: undefined })),
}));

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});
vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => supported.value,
  isRemoteHostSupported: () => supported.value,
  isEitherRemoteRoleSupported: () => supported.value,
}));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, isMac: () => true, isWindows: () => false, isLinux: () => false };
});
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch, has: () => false },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { OtherHostsSection, useOtherHostProjectOptions } from "../OtherHostsSection";
import { OpenOnHostSubmenu } from "../OpenOnHostSubmenu";
import { _resetHostListForTesting } from "../hostList";
import {
  _resetHostProjectsForTesting,
  setHostProjectsLoader,
  type HostProjectRef,
} from "../hostProjects";

const HANDSHAKE = {
  version: "1.0.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "linux",
  arch: "x64",
} as const;
const CONNECTED: HostConnectionState = { status: "connected", rttMs: 1, handshake: HANDSHAKE };

function host(id: string, connection: HostConnectionState = CONNECTED): HostListEntry {
  return {
    descriptor: {
      id,
      name: id,
      connection: { kind: "ssh", target: id },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
      assistantControlEnabled: false,
    },
    connection,
    summary: null,
  };
}

const PROJECTS: Record<string, HostProjectRef[]> = {
  "studio-01": [
    { id: "s1-daintree", name: "daintree", path: "/home/greg/daintree", emoji: "🌴" },
    { id: "s1-api", name: "api", path: "/home/greg/api" },
  ],
  "studio-02": [{ id: "s2-web", name: "web", path: "/srv/web" }],
  "studio-03": [{ id: "s3-web", name: "web", path: "/srv/web" }],
};

const list = vi.fn<() => Promise<HostListEntry[]>>();
const locate = vi.fn<
  (payload: { fromHostId: string; projectId: string; toHostIds: string[] }) => Promise<
    Array<{
      hostId: string;
      projects: Array<{ projectId: string; name: string; path: string }> | null;
    }>
  >
>();
const switchWindowHost = vi.fn(() => Promise.resolve());
const listWorktrees = vi.fn<(payload: { hostId: string }) => Promise<HostWorktreeEntry[]>>();
let emitHostsEvent: (event: RemoteHostsEvent) => void = () => {};
const loader = vi.fn((hostId: string) => Promise.resolve(PROJECTS[hostId] ?? []));

beforeEach(() => {
  cleanup();
  _resetHostListForTesting();
  _resetHostProjectsForTesting();
  supported.value = true;
  dispatch.mockClear();
  switchWindowHost.mockClear();
  listWorktrees.mockReset();
  listWorktrees.mockResolvedValue([]);
  loader.mockClear();
  list.mockReset();
  locate.mockReset();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      remoteHosts: {
        list,
        switchWindowHost,
        onEvent: (listener: (event: RemoteHostsEvent) => void) => {
          emitHostsEvent = listener;
          return () => {};
        },
      },
      hostSwitch: { locate },
      hostMetrics: { listWorktrees },
    },
  });
});

afterEach(async () => {
  cleanup();
  // Radix's focus scope hands focus back on a zero-delay timer after the
  // context menu unmounts; let it run while jsdom is still here.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

function Band({ query, onChosen }: { query: string; onChosen: () => void }) {
  const { groups } = useOtherHostProjectOptions(query);
  return <OtherHostsSection groups={groups} activeKey={null} onChosen={onChosen} />;
}

/** Each host group's accessible name: its visible header. */
function groupNames(band: HTMLElement): string[] {
  return [...band.querySelectorAll('[role="group"]')].map(
    (group) => document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent ?? ""
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Other hosts band", () => {
  it("changes nothing for someone with no remote host", async () => {
    list.mockResolvedValue([]);
    setHostProjectsLoader(loader);
    const { container } = render(<Band query="" onChosen={() => {}} />);
    await settle();
    expect(container.textContent).toBe("");
    expect(loader).not.toHaveBeenCalled();
  });

  it("stays empty while nothing can list another host's projects", async () => {
    list.mockResolvedValue([host("studio-01")]);
    const { container } = render(<Band query="" onChosen={() => {}} />);
    await settle();
    expect(container.textContent).toBe("");
  });

  it("groups hosts' projects under visible headers and never dials a host to list it", async () => {
    list.mockResolvedValue([
      host("studio-02"),
      host("studio-01"),
      host("studio-03", { status: "unreachable", lastSeenAt: null, detail: null }),
    ]);
    setHostProjectsLoader(loader);
    render(<Band query="" onChosen={() => {}} />);
    const band = await screen.findByTestId("project-switcher-other-hosts");
    await screen.findByRole("option", { name: /^web on studio-02/ });
    // A host with projects is a group named by its header, which says its link;
    // a host never listed this run is one row of its own, offering to connect.
    expect(groupNames(band)).toEqual(["studio-01, Connected", "studio-02, Connected"]);
    expect(screen.getByRole("option", { name: "Connect to studio-03, Unreachable" })).toBeTruthy();
    expect(loader.mock.calls.map(([id]) => id)).not.toContain("studio-03");
    // The header names its group, so it can't be hidden from the reader it names it for.
    for (const group of band.querySelectorAll('[role="group"]')) {
      const header = document.getElementById(group.getAttribute("aria-labelledby")!)!;
      expect(header.closest("[aria-hidden='true']")).toBeNull();
    }
  });

  it("lists hosts once the loader arrives after the band mounted", async () => {
    list.mockResolvedValue([host("studio-01")]);
    render(<Band query="" onChosen={() => {}} />);
    await settle();
    expect(screen.queryByRole("option", { name: /^api on studio-01/ })).toBeNull();
    act(() => setHostProjectsLoader(loader));
    expect(await screen.findByRole("option", { name: /^api on studio-01/ })).toBeTruthy();
  });

  it("connects a host that isn't connected when its row is picked", async () => {
    list.mockResolvedValue([host("studio-03", { status: "disconnected" } as HostConnectionState)]);
    setHostProjectsLoader(loader);
    const onChosen = vi.fn();
    render(<Band query="" onChosen={onChosen} />);
    fireEvent.click(await screen.findByRole("option", { name: "Connect to studio-03" }));
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "studio-03", newWindow: false })
    );
    expect(onChosen).toHaveBeenCalled();
  });

  it("shows each host's rows as it answers, whatever another host is doing", async () => {
    list.mockResolvedValue([host("studio-01"), host("studio-02")]);
    setHostProjectsLoader((hostId) =>
      hostId === "studio-02" ? new Promise(() => {}) : loader(hostId)
    );
    render(<Band query="" onChosen={() => {}} />);
    expect(await screen.findByRole("option", { name: /^api on studio-01/ })).toBeTruthy();
    // The host still answering is there, saying so, with nothing to pick yet.
    const listing = screen.getByRole("option", { name: "studio-02, Connected · Listing…" });
    expect(listing.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("option", { name: /on studio-02/ })).toBeNull();
  });

  it("says a listing failed and offers Retry rather than showing no projects", async () => {
    list.mockResolvedValue([host("studio-01")]);
    let fail = true;
    setHostProjectsLoader((hostId) =>
      fail ? Promise.reject(new Error("timed out")) : loader(hostId)
    );
    const onChosen = vi.fn();
    render(<Band query="" onChosen={onChosen} />);
    const retry = await screen.findByRole("option", {
      name: "Retry listing projects on studio-01",
    });
    expect(screen.getByText(/Couldn't list projects/)).toBeTruthy();

    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByRole("option", { name: /^api on studio-01/ })).toBeTruthy();
    expect(onChosen).not.toHaveBeenCalled();
    expect(screen.queryByText(/Couldn't list projects/)).toBeNull();
  });

  it("keeps a dropped host's last list, marked not connected, and connects to open a row", async () => {
    list.mockResolvedValue([host("studio-01")]);
    setHostProjectsLoader(loader);
    render(<Band query="" onChosen={() => {}} />);
    await screen.findByRole("option", { name: /^api on studio-01/ });

    act(() => {
      emitHostsEvent({
        type: "connection-changed",
        hostId: "studio-01",
        connection: { status: "disconnected" },
      } as RemoteHostsEvent);
    });
    const row = await screen.findByRole("option", { name: /^api on studio-01.*Not connected/ });
    expect(screen.getByText(/Not connected · listed/)).toBeTruthy();

    fireEvent.click(row);
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({
        hostId: "studio-01",
        newWindow: false,
        projectId: "s1-api",
      })
    );
  });

  it("matches a query naming the project and the host together", async () => {
    list.mockResolvedValue([host("studio-02"), host("studio-03")]);
    setHostProjectsLoader(loader);
    render(<Band query="web 03" onChosen={() => {}} />);
    expect(await screen.findByRole("option", { name: /^web on studio-03/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^web on studio-02/ })).toBeNull();
  });

  it("names the host and the folder on every row, and draws them only where they earn it", async () => {
    list.mockResolvedValue([host("studio-01")]);
    setHostProjectsLoader(loader);
    const { rerender } = render(<Band query="" onChosen={() => {}} />);
    const row = await screen.findByRole("option", {
      name: /^api on studio-01, \/home\/greg\/api$/,
    });
    // The header above already names the host; the name already says the folder.
    expect(row.textContent).not.toContain("studio-01");
    expect(row.textContent).not.toContain("/home/greg/api");

    // A query the path answers rather than the name shows the path it matched.
    rerender(<Band query="greg" onChosen={() => {}} />);
    expect(
      (await screen.findByRole("option", { name: /^api on studio-01/ })).textContent
    ).toContain("/home/greg/api");
  });

  it("switches host and project together, in a new window on Cmd-click", async () => {
    list.mockResolvedValue([host("studio-01")]);
    setHostProjectsLoader(loader);
    const onChosen = vi.fn();
    render(<Band query="" onChosen={onChosen} />);
    fireEvent.click(await screen.findByRole("option", { name: /^api on studio-01/ }));
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({
        hostId: "studio-01",
        newWindow: false,
        projectId: "s1-api",
      })
    );
    expect(onChosen).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("option", { name: /^daintree on studio-01/ }), {
      metaKey: true,
    });
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenLastCalledWith({
        hostId: "studio-01",
        newWindow: true,
        projectId: "s1-daintree",
      })
    );
  });

  it("narrows to the query", async () => {
    list.mockResolvedValue([host("studio-01"), host("studio-02")]);
    setHostProjectsLoader(loader);
    render(<Band query="dain" onChosen={() => {}} />);
    await screen.findByRole("option", { name: /^daintree on studio-01/ });
    expect(screen.queryByRole("option", { name: /^api on studio-01/ })).toBeNull();
    expect(screen.queryByText("studio-02")).toBeNull();
  });
});

function RowMenu({ projectName }: { projectName: string }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-testid="row">{projectName}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <OpenOnHostSubmenu projectId="local-web" />
      </ContextMenuContent>
    </ContextMenu>
  );
}

describe("Open on… submenu", () => {
  it("is absent for someone with no remote host", async () => {
    list.mockResolvedValue([]);
    render(<RowMenu projectName="web" />);
    fireEvent.contextMenu(screen.getByTestId("row"));
    await settle();
    expect(screen.queryByText("Open on…")).toBeNull();
    expect(locate).not.toHaveBeenCalled();
  });

  it("marks hosts by repository identity, never by a shared name", async () => {
    list.mockResolvedValue([host("studio-01"), host("studio-02")]);
    setHostProjectsLoader(loader);
    // studio-02 lists a project called "web", but it is another repository;
    // studio-01 has this one under another name.
    locate.mockResolvedValue([
      {
        hostId: "studio-01",
        projects: [{ projectId: "s1-site", name: "site", path: "/home/greg/site" }],
      },
      { hostId: "studio-02", projects: [] },
    ]);
    render(<RowMenu projectName="web" />);
    fireEvent.contextMenu(screen.getByTestId("row"));
    fireEvent.click(await screen.findByText("Open on…"));

    const has = await screen.findByRole("menuitem", { name: "studio-01, has this repository" });
    expect(screen.getByRole("menuitem", { name: "studio-02, clone" })).toBeTruthy();
    expect(locate).toHaveBeenCalledWith({
      fromHostId: "local",
      projectId: "local-web",
      toHostIds: ["studio-01", "studio-02"],
    });

    // The row goes to the host's copy as it is: no branch is handed over from here.
    fireEvent.click(has, { metaKey: true });
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        "project.openOnHost",
        { hostId: "studio-01", projectId: "local-web", newWindow: true, navigateOnly: true },
        { source: "context-menu" }
      )
    );
    expect(switchWindowHost).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByTestId("row"));
    fireEvent.click(await screen.findByText("Open on…"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "studio-02, clone" }));
    await waitFor(() =>
      expect(dispatch).toHaveBeenLastCalledWith(
        "project.openOnHost",
        { hostId: "studio-02", projectId: "local-web", newWindow: false, navigateOnly: true },
        { source: "context-menu" }
      )
    );
    expect(switchWindowHost).not.toHaveBeenCalled();
  });

  it("claims nothing about a host it couldn't ask", async () => {
    list.mockResolvedValue([host("studio-01")]);
    locate.mockResolvedValue([{ hostId: "studio-01", projects: null }]);
    render(<RowMenu projectName="web" />);
    fireEvent.contextMenu(screen.getByTestId("row"));
    fireEvent.click(await screen.findByText("Open on…"));
    const item = await screen.findByRole("menuitem", { name: "studio-01" });
    await waitFor(() => expect(item.getAttribute("data-presence")).toBe("unknown"));
    expect(item.textContent).not.toContain("clone");
  });
});

function worktree(overrides: Partial<HostWorktreeEntry>): HostWorktreeEntry {
  return {
    hostId: "studio-01",
    projectId: "s1-api",
    projectName: "api",
    worktreeId: "wt-1",
    name: "login",
    branch: "fix/login",
    path: "/home/greg/api-login",
    isMainWorktree: false,
    modifiedCount: null,
    lastActivityAt: null,
    observed: null,
    ...overrides,
  };
}

describe("Other hosts band: worktrees by branch", () => {
  beforeEach(() => {
    list.mockResolvedValue([host("studio-01")]);
    setHostProjectsLoader(loader);
  });

  it("lists a worktree a branch query matches, with its project and observed agent state", async () => {
    listWorktrees.mockResolvedValue([
      worktree({ observed: { band: "needs-you", agentState: "waiting" } }),
      worktree({ worktreeId: "wt-2", name: "docs", branch: "docs/readme" }),
    ]);
    render(<Band query="fix/login" onChosen={() => {}} />);
    const row = await screen.findByRole("option", {
      name: "fix/login in api on studio-01, waiting (observed)",
    });
    expect(row.textContent).toContain("api · waiting (observed)");
    expect(screen.queryByRole("option", { name: /docs\/readme/ })).toBeNull();
  });

  it("adds no worktree rows when browsing, or when only the project or host matches", async () => {
    listWorktrees.mockResolvedValue([worktree({})]);
    const { rerender } = render(<Band query="" onChosen={() => {}} />);
    await screen.findByRole("option", { name: /^api on studio-01/ });
    expect(listWorktrees).not.toHaveBeenCalled();
    rerender(<Band query="api" onChosen={() => {}} />);
    await waitFor(() => expect(listWorktrees).toHaveBeenCalled());
    await settle();
    expect(screen.queryByRole("option", { name: /fix\/login/ })).toBeNull();
  });

  it("opens the project with the worktree selected, or its agent focused", async () => {
    listWorktrees.mockResolvedValue([
      worktree({}),
      worktree({
        worktreeId: "wt-3",
        branch: "fix/login-2",
        runs: [{ band: "needs-you", agentState: "waiting", terminalId: "t-9" }],
      }),
    ]);
    const onChosen = vi.fn();
    render(<Band query="fix/login" onChosen={onChosen} />);
    fireEvent.click(await screen.findByRole("option", { name: /^fix\/login in api/ }));
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({
        hostId: "studio-01",
        newWindow: false,
        projectId: "s1-api",
        focusIntent: { intent: "focus-worktree", worktreeId: "wt-1" },
      })
    );
    expect(onChosen).toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("option", { name: /^fix\/login-2 in api/ }));
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenLastCalledWith({
        hostId: "studio-01",
        newWindow: false,
        projectId: "s1-api",
        focusIntent: { intent: "focus-panel", panelId: "t-9" },
      })
    );
  });

  it("keeps a dropped host's worktrees, marked listed earlier", async () => {
    listWorktrees.mockResolvedValue([worktree({})]);
    render(<Band query="fix/login" onChosen={() => {}} />);
    await screen.findByRole("option", { name: /^fix\/login in api on studio-01$/ });
    act(() => {
      emitHostsEvent({
        type: "connection-changed",
        hostId: "studio-01",
        connection: { status: "disconnected" },
      } as RemoteHostsEvent);
    });
    const row = await screen.findByRole("option", { name: /^fix\/login in api.*, listed / });
    fireEvent.click(row);
    await waitFor(() => expect(switchWindowHost).toHaveBeenCalled());
  });
});
