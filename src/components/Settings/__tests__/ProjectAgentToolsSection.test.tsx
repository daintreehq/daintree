// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProjectAgentToolsSection } from "../ProjectAgentToolsSection";
import { __resetProjectPluginStoreForTesting } from "@/store/projectPluginStore";
import type {
  ProjectAgentToolPlugin,
  ProjectAgentToolsSnapshot,
  SetProjectAgentToolAccessPayload,
} from "@shared/types/ipc/pluginAgentMcp";

function plugin(over: Partial<ProjectAgentToolPlugin> = {}): ProjectAgentToolPlugin {
  return {
    pluginInstanceId: "acme.ledger",
    pluginDisplayName: "Ledger",
    origin: "installed",
    hasDatabases: true,
    pluginTools: { name: "Household ledger" },
    access: "off",
    source: "default",
    allProjectsAccess: "off",
    available: true,
    ...over,
  };
}

function notes(over: Partial<ProjectAgentToolPlugin> = {}): ProjectAgentToolPlugin {
  return plugin({
    pluginInstanceId: "acme.notes",
    pluginDisplayName: "Notes",
    hasDatabases: false,
    pluginTools: { name: "Team notes" },
    ...over,
  });
}

function snapshot(
  plugins: ProjectAgentToolPlugin[],
  mcpServerEnabled = true
): ProjectAgentToolsSnapshot {
  return { plugins, mcpServerEnabled };
}

const agentMcpApi = {
  listProjectPlugins: vi.fn<() => Promise<ProjectAgentToolsSnapshot>>(),
  setPluginAccess:
    vi.fn<(payload: SetProjectAgentToolAccessPayload) => Promise<ProjectAgentToolsSnapshot>>(),
};
let provenanceListener: (() => void) | null = null;
let runtimeStatusListener: (() => void) | null = null;
let mcpStateListener: (() => void) | null = null;
const unsubscribeProvenance = vi.fn();
const unsubscribeRuntimeStatus = vi.fn();
const unsubscribeMcpState = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  provenanceListener = null;
  runtimeStatusListener = null;
  mcpStateListener = null;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      pluginAgentMcp: agentMcpApi,
      plugin: {
        onProvenanceChanged: (cb: () => void) => {
          provenanceListener = cb;
          return unsubscribeProvenance;
        },
      },
      events: {
        on: (channel: string, cb: () => void) => {
          if (channel === "plugin:runtime-status-changed") runtimeStatusListener = cb;
          return unsubscribeRuntimeStatus;
        },
      },
      mcpServer: {
        onRuntimeStateChanged: (cb: () => void) => {
          mcpStateListener = cb;
          return unsubscribeMcpState;
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  __resetProjectPluginStoreForTesting();
});

function groupFor(name: string): HTMLElement {
  return screen.getByRole("radiogroup", { name: new RegExp(`access to ${name}`) });
}

function optionLabels(name: string): string[] {
  return within(groupFor(name))
    .getAllByRole("radio")
    .map((el) => el.textContent ?? "");
}

function checkedLabel(name: string): string | null {
  const checked = within(groupFor(name))
    .getAllByRole("radio")
    .find((el) => el.getAttribute("aria-checked") === "true");
  return checked?.textContent ?? null;
}

function pick(name: string, label: string) {
  fireEvent.click(within(groupFor(name)).getByRole("radio", { name: label }));
}

function rowFor(name: string): HTMLElement {
  const row = screen
    .getAllByTestId("project-agent-tool-row")
    .find((el) => el.textContent?.startsWith(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("ProjectAgentToolsSection", () => {
  it("renders one row per plugin with its current level", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([
        plugin({ access: "read-only" }),
        notes({ pluginTools: { name: "Team notes", description: "Reads the team's notes" } }),
      ])
    );
    render(<ProjectAgentToolsSection />);

    await screen.findByTestId("project-agent-tools");
    const rows = screen.getAllByTestId("project-agent-tool-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Ledger");
    expect(rows[0]!.textContent).toContain("Installed");
    expect(rows[1]!.textContent).toContain("Team notesReads the team's notes");
    expect(checkedLabel("Ledger")).toBe("Read only");
    expect(checkedLabel("Notes")).toBe("Off");
  });

  it("offers only the levels that mean something for what the plugin offers", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([
        plugin(),
        plugin({
          pluginInstanceId: "acme.db",
          pluginDisplayName: "Warehouse",
          pluginTools: undefined,
        }),
        notes(),
      ])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    expect(optionLabels("Ledger")).toEqual(["Off", "Read only", "Read and write"]);
    expect(optionLabels("Warehouse")).toEqual(["Off", "Read only"]);
    expect(optionLabels("Notes")).toEqual(["Off", "On"]);
  });

  it("describes what each level adds", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([
        plugin(),
        plugin({
          pluginInstanceId: "acme.db",
          pluginDisplayName: "Warehouse",
          pluginTools: undefined,
        }),
      ])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    expect(rowFor("Ledger").textContent).toContain(
      "Read only lets agents query its databases; read and write adds Household ledger"
    );
    expect(rowFor("Warehouse").textContent).toContain("Lets agents query its databases, read only");
  });

  it("never names a particular agent CLI in its copy", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot(
        [
          plugin({ source: "project", access: "read-write", databasesWithheld: true }),
          notes({ origin: "project", allProjectsAccess: undefined, repositoryAccess: "off" }),
        ],
        false
      )
    );
    render(<ProjectAgentToolsSection />);
    const section = await screen.findByTestId("project-agent-tools");
    expect(section.textContent).not.toMatch(/claude/i);
  });

  it("renders nothing when no plugin offers agent tools here", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(snapshot([]));
    const { container } = render(<ProjectAgentToolsSection />);

    await waitFor(() => expect(agentMcpApi.listProjectPlugins).toHaveBeenCalled());
    await act(async () => {});
    expect(container.innerHTML).toBe("");
  });

  it("picking a level sets it for this project and shows what main answers with", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(snapshot([plugin()]));
    agentMcpApi.setPluginAccess.mockResolvedValue(
      snapshot([plugin({ access: "read-write", source: "project" })])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    pick("Ledger", "Read and write");

    expect(agentMcpApi.setPluginAccess).toHaveBeenCalledWith({
      pluginInstanceId: "acme.ledger",
      access: "read-write",
      scope: "project",
    });
    await waitFor(() => expect(checkedLabel("Ledger")).toBe("Read and write"));
  });

  it("an On pick for a tools-only plugin sends read-write", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(snapshot([notes()]));
    agentMcpApi.setPluginAccess.mockResolvedValue(
      snapshot([notes({ access: "read-write", source: "project" })])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    pick("Notes", "On");

    expect(agentMcpApi.setPluginAccess).toHaveBeenCalledWith({
      pluginInstanceId: "acme.notes",
      access: "read-write",
      scope: "project",
    });
    await waitFor(() => expect(checkedLabel("Notes")).toBe("On"));
  });

  it("offers a reset only for a project's own answer, and it clears that answer", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([plugin({ access: "read-only", source: "project" }), notes()])
    );
    agentMcpApi.setPluginAccess.mockResolvedValue(snapshot([plugin(), notes()]));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    expect(screen.queryByRole("button", { name: "Use the default access for Notes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use the default access for Ledger" }));

    expect(agentMcpApi.setPluginAccess).toHaveBeenCalledWith({
      pluginInstanceId: "acme.ledger",
      access: null,
      scope: "project",
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Use the default access for Ledger" })).toBeNull()
    );
    expect(checkedLabel("Ledger")).toBe("Off");
  });

  it("makes an installed plugin's level the default for every project", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([plugin({ access: "read-only", source: "project", allProjectsAccess: "off" })])
    );
    agentMcpApi.setPluginAccess.mockResolvedValue(
      snapshot([plugin({ access: "read-only", source: "project", allProjectsAccess: "read-only" })])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    fireEvent.click(screen.getByTestId("project-agent-tool-set-default"));

    expect(agentMcpApi.setPluginAccess).toHaveBeenCalledWith({
      pluginInstanceId: "acme.ledger",
      access: "read-only",
      scope: "all-projects",
    });
    await waitFor(() => expect(screen.queryByTestId("project-agent-tool-set-default")).toBeNull());
  });

  it("offers no all-projects default when it already matches, for project plugins, or while unavailable", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([
        plugin({ access: "read-only", source: "all-projects", allProjectsAccess: "read-only" }),
        notes({
          origin: "project",
          allProjectsAccess: undefined,
          access: "read-write",
          source: "project",
        }),
        plugin({
          pluginInstanceId: "acme.gone",
          pluginDisplayName: "Gone",
          access: "read-only",
          source: "project",
          allProjectsAccess: "off",
          available: false,
        }),
      ])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    expect(screen.queryByTestId("project-agent-tool-set-default")).toBeNull();
  });

  it("says where the current level comes from", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([
        plugin({ access: "read-only", source: "project", allProjectsAccess: "read-write" }),
        plugin({
          pluginInstanceId: "acme.all",
          pluginDisplayName: "Shared",
          access: "read-only",
          source: "all-projects",
          allProjectsAccess: "read-only",
        }),
        notes({
          origin: "project",
          allProjectsAccess: undefined,
          access: "read-write",
          source: "repository",
          repositoryAccess: "read-write",
        }),
        plugin({
          pluginInstanceId: `project__${"b".repeat(64)}__acme.repo`,
          pluginDisplayName: "Repo",
          origin: "project",
          allProjectsAccess: undefined,
          access: "off",
          source: "project",
          repositoryAccess: "read-only",
        }),
      ])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    expect(rowFor("Ledger").textContent).toContain(
      "Set for this project; every other project follows your default (read and write)"
    );
    expect(rowFor("Shared").textContent).toContain("Your default for every project");
    expect(rowFor("Notes").textContent).toContain("Set by this project's .daintree/mcp.json");
    expect(rowFor("Repo").textContent).toContain(
      "This project's .daintree/mcp.json sets read only; your choice here overrides it"
    );
  });

  it("names a tools-only plugin's level On in its description", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([
        notes({
          origin: "project",
          allProjectsAccess: undefined,
          source: "project",
          repositoryAccess: "read-write",
        }),
      ])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    expect(rowFor("Notes").textContent).toContain(".daintree/mcp.json sets on;");
  });

  it("says when an earlier answer keeps the database tools off", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([plugin({ access: "read-write", source: "project", databasesWithheld: true })])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    expect(rowFor("Ledger").textContent).toContain(
      "Its database tools stay off, from a choice made before these levels existed"
    );
  });

  it("keeps the old level and retries the same change when it fails", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([plugin({ access: "read-only", source: "project" })])
    );
    agentMcpApi.setPluginAccess.mockRejectedValueOnce(new Error("boom"));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    pick("Ledger", "Read and write");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't change access to Ledger");
    expect(checkedLabel("Ledger")).toBe("Read only");

    agentMcpApi.setPluginAccess.mockResolvedValueOnce(
      snapshot([plugin({ access: "read-write", source: "project" })])
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(checkedLabel("Ledger")).toBe("Read and write"));
    expect(agentMcpApi.setPluginAccess).toHaveBeenCalledTimes(2);
    expect(agentMcpApi.setPluginAccess.mock.calls[1]![0]).toEqual(
      agentMcpApi.setPluginAccess.mock.calls[0]![0]
    );
    expect(agentMcpApi.setPluginAccess).toHaveBeenLastCalledWith({
      pluginInstanceId: "acme.ledger",
      access: "read-write",
      scope: "project",
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retries a failed all-projects change at the same scope", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([plugin({ access: "read-only", source: "project" })])
    );
    agentMcpApi.setPluginAccess.mockRejectedValueOnce(new Error("boom"));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    fireEvent.click(screen.getByTestId("project-agent-tool-set-default"));
    await screen.findByRole("alert");

    agentMcpApi.setPluginAccess.mockResolvedValueOnce(
      snapshot([plugin({ access: "read-only", source: "project", allProjectsAccess: "read-only" })])
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(agentMcpApi.setPluginAccess).toHaveBeenLastCalledWith({
      pluginInstanceId: "acme.ledger",
      access: "read-only",
      scope: "all-projects",
    });
  });

  it("lets a stale answer be turned off but offers nothing new", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([plugin({ access: "read-only", source: "project", available: false })])
    );
    agentMcpApi.setPluginAccess.mockResolvedValue(snapshot([]));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    expect(optionLabels("Ledger")).toEqual(["Off", "Read only"]);
    expect(rowFor("Ledger").textContent).toContain("Not offered here right now. Still allowed");
    const off = within(groupFor("Ledger")).getByRole("radio", { name: "Off" }) as HTMLButtonElement;
    expect(off.disabled).toBe(false);
    fireEvent.click(off);

    expect(agentMcpApi.setPluginAccess).toHaveBeenCalledWith({
      pluginInstanceId: "acme.ledger",
      access: "off",
      scope: "project",
    });
    await waitFor(() => expect(screen.queryByTestId("project-agent-tools")).toBeNull());
  });

  it("lets a default left on for an unavailable installed plugin be turned off everywhere", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([
        plugin({
          access: "read-only",
          source: "all-projects",
          allProjectsAccess: "read-only",
          available: false,
        }),
        notes({ access: "read-write", source: "all-projects", allProjectsAccess: "read-write" }),
        plugin({
          pluginInstanceId: "acme.off",
          pluginDisplayName: "Dormant",
          access: "read-only",
          source: "project",
          allProjectsAccess: "off",
          available: false,
        }),
        plugin({
          pluginInstanceId: "acme.repo",
          pluginDisplayName: "Repo copy",
          origin: "project",
          access: "read-only",
          source: "project",
          allProjectsAccess: undefined,
          available: false,
        }),
      ])
    );
    agentMcpApi.setPluginAccess.mockResolvedValue(snapshot([notes()]));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    expect(screen.getAllByTestId("project-agent-tool-clear-default")).toHaveLength(1);
    expect(within(rowFor("Notes")).queryByTestId("project-agent-tool-clear-default")).toBeNull();
    expect(within(rowFor("Dormant")).queryByTestId("project-agent-tool-clear-default")).toBeNull();
    expect(
      within(rowFor("Repo copy")).queryByTestId("project-agent-tool-clear-default")
    ).toBeNull();

    const clear = within(rowFor("Ledger")).getByTestId("project-agent-tool-clear-default");
    expect(clear.textContent).toBe("Turn off in all projects");
    fireEvent.click(clear);

    expect(agentMcpApi.setPluginAccess).toHaveBeenCalledWith({
      pluginInstanceId: "acme.ledger",
      access: null,
      scope: "all-projects",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("project-agent-tool-clear-default")).toBeNull()
    );
  });

  it("offers only Off for an unavailable plugin that is already off", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([plugin({ access: "off", source: "project", available: false })])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    expect(optionLabels("Ledger")).toEqual(["Off"]);
    expect(rowFor("Ledger").textContent).toContain("Not offered here right now");
  });

  it("points at the MCP server only while it is off", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(snapshot([plugin()], false));
    render(<ProjectAgentToolsSection />);
    const section = await screen.findByTestId("project-agent-tools");
    expect(section.textContent).toContain("MCP server, which is off");

    agentMcpApi.listProjectPlugins.mockResolvedValue(snapshot([plugin()], true));
    act(() => provenanceListener?.());
    await waitFor(() =>
      expect(screen.getByTestId("project-agent-tools").textContent).not.toContain(
        "MCP server, which is off"
      )
    );
  });

  it.each([
    ["installed plugins change", () => provenanceListener?.()],
    ["a plugin's runtime status changes", () => runtimeStatusListener?.()],
    ["the MCP server changes state", () => mcpStateListener?.()],
    ["the window regains focus", () => window.dispatchEvent(new Event("focus"))],
  ])("re-reads when %s", async (_label, fire) => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(snapshot([]));
    render(<ProjectAgentToolsSection />);
    await waitFor(() => expect(agentMcpApi.listProjectPlugins).toHaveBeenCalledTimes(1));

    agentMcpApi.listProjectPlugins.mockResolvedValue(snapshot([plugin()]));
    act(() => {
      fire();
    });

    await screen.findByTestId("project-agent-tools");
  });

  it("stops listening on unmount", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(snapshot([]));
    const { unmount } = render(<ProjectAgentToolsSection />);
    await waitFor(() => expect(agentMcpApi.listProjectPlugins).toHaveBeenCalled());

    unmount();
    expect(unsubscribeProvenance).toHaveBeenCalled();
    expect(unsubscribeRuntimeStatus).toHaveBeenCalled();
    expect(unsubscribeMcpState).toHaveBeenCalled();
    agentMcpApi.listProjectPlugins.mockClear();
    window.dispatchEvent(new Event("focus"));
    expect(agentMcpApi.listProjectPlugins).not.toHaveBeenCalled();
  });

  it("tells an installed plugin apart from a project copy with the same name", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([
        plugin(),
        plugin({
          pluginInstanceId: `project__${"a".repeat(64)}__acme.ledger`,
          origin: "project",
          allProjectsAccess: undefined,
        }),
      ])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    const labels = screen
      .getAllByRole("radiogroup")
      .map((el) => el.getAttribute("aria-label") ?? "");
    expect(new Set(labels).size).toBe(2);
    expect(labels.some((l) => l.includes("(project)"))).toBe(true);
    expect(labels.some((l) => l.includes("(installed)"))).toBe(true);
  });

  it("a read that fails mid-change never discards the change's answer", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValueOnce(snapshot([plugin()]));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    const write = deferred<ProjectAgentToolsSnapshot>();
    agentMcpApi.setPluginAccess.mockReturnValueOnce(write.promise);
    pick("Ledger", "Read only");

    const read = deferred<ProjectAgentToolsSnapshot>();
    agentMcpApi.listProjectPlugins.mockReturnValueOnce(read.promise);
    act(() => provenanceListener?.());
    await act(async () => read.reject(new Error("offline")));

    await act(async () =>
      write.resolve(snapshot([plugin({ access: "read-only", source: "project" })]))
    );
    expect(checkedLabel("Ledger")).toBe("Read only");
  });

  it("a read sent before a change lands can't paint the old level back", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValueOnce(snapshot([plugin()]));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    const read = deferred<ProjectAgentToolsSnapshot>();
    agentMcpApi.listProjectPlugins.mockReturnValueOnce(read.promise);
    act(() => provenanceListener?.());

    agentMcpApi.setPluginAccess.mockResolvedValueOnce(
      snapshot([plugin({ access: "read-write", source: "project" })])
    );
    pick("Ledger", "Read and write");
    await waitFor(() => expect(checkedLabel("Ledger")).toBe("Read and write"));

    await act(async () => read.resolve(snapshot([plugin()])));
    expect(checkedLabel("Ledger")).toBe("Read and write");
  });

  it("disables a row's control while its change is in flight", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(snapshot([plugin()]));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    const write = deferred<ProjectAgentToolsSnapshot>();
    agentMcpApi.setPluginAccess.mockReturnValueOnce(write.promise);
    pick("Ledger", "Read only");

    const radios = within(groupFor("Ledger")).getAllByRole("radio") as HTMLButtonElement[];
    expect(radios.every((r) => r.disabled)).toBe(true);

    await act(async () =>
      write.resolve(snapshot([plugin({ access: "read-only", source: "project" })]))
    );
    expect(
      (within(groupFor("Ledger")).getAllByRole("radio") as HTMLButtonElement[]).every(
        (r) => !r.disabled
      )
    ).toBe(true);
  });

  it("hides a row's reset while its change is in flight", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValue(
      snapshot([plugin({ access: "read-only", source: "project" })])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");
    const resetName = { name: "Use the default access for Ledger" };
    expect(screen.getByRole("button", resetName)).toBeTruthy();

    const write = deferred<ProjectAgentToolsSnapshot>();
    agentMcpApi.setPluginAccess.mockReturnValueOnce(write.promise);
    pick("Ledger", "Read and write");

    expect(screen.queryByRole("button", resetName)).toBeNull();

    await act(async () =>
      write.resolve(snapshot([plugin({ access: "read-write", source: "project" })]))
    );
    expect(screen.getByRole("button", resetName)).toBeTruthy();
  });

  it("re-reads once overlapping changes settle", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValueOnce(snapshot([plugin(), notes()]));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    const first = deferred<ProjectAgentToolsSnapshot>();
    const second = deferred<ProjectAgentToolsSnapshot>();
    agentMcpApi.setPluginAccess
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    pick("Ledger", "Read only");
    pick("Notes", "On");

    const truth = snapshot([
      plugin({ access: "read-only", source: "project" }),
      notes({ access: "read-write", source: "project" }),
    ]);
    agentMcpApi.listProjectPlugins.mockResolvedValue(truth);
    await act(async () => second.resolve(snapshot([plugin(), notes({ access: "read-write" })])));
    expect(agentMcpApi.listProjectPlugins).toHaveBeenCalledTimes(1);
    await act(async () =>
      first.resolve(snapshot([plugin({ access: "read-only", source: "project" }), notes()]))
    );

    await waitFor(() => expect(agentMcpApi.listProjectPlugins).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(checkedLabel("Notes")).toBe("On"));
    expect(checkedLabel("Ledger")).toBe("Read only");
  });

  it("flags a failed refresh over rows it can no longer vouch for", async () => {
    agentMcpApi.listProjectPlugins.mockResolvedValueOnce(snapshot([plugin()]));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tool-row");

    agentMcpApi.listProjectPlugins.mockRejectedValueOnce(new Error("offline"));
    act(() => provenanceListener?.());
    expect((await screen.findByRole("alert")).textContent).toContain("out of date");
    expect(screen.getByTestId("project-agent-tool-row")).toBeTruthy();

    agentMcpApi.listProjectPlugins.mockResolvedValueOnce(snapshot([plugin()]));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("offers a retry when the first read fails", async () => {
    agentMcpApi.listProjectPlugins.mockRejectedValueOnce(new Error("offline"));
    render(<ProjectAgentToolsSection />);

    await screen.findByRole("alert");
    agentMcpApi.listProjectPlugins.mockResolvedValueOnce(snapshot([plugin()]));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByTestId("project-agent-tool-row");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
