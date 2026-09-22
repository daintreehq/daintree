// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectAgentToolsSection } from "../ProjectAgentToolsSection";
import { __resetProjectPluginStoreForTesting } from "@/store/projectPluginStore";
import type {
  ProjectAgentToolEndpoint,
  ProjectAgentToolsSnapshot,
} from "@shared/types/ipc/pluginAgentMcp";

function endpoint(over: Partial<ProjectAgentToolEndpoint> = {}): ProjectAgentToolEndpoint {
  return {
    pluginInstanceId: "acme.ledger",
    pluginDisplayName: "Ledger",
    endpointId: "data",
    name: "Household ledger",
    enabled: false,
    available: true,
    ...over,
  };
}

function snapshot(
  endpoints: ProjectAgentToolEndpoint[],
  mcpServerEnabled = true
): ProjectAgentToolsSnapshot {
  return { endpoints, mcpServerEnabled };
}

const agentMcpApi = {
  listProjectEndpoints: vi.fn<() => Promise<ProjectAgentToolsSnapshot>>(),
  setProjectEndpointEnabled:
    vi.fn<
      (payload: {
        pluginInstanceId: string;
        endpointId: string;
        enabled: boolean;
      }) => Promise<ProjectAgentToolsSnapshot>
    >(),
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

function switchFor(name: string): HTMLButtonElement {
  return screen.getByRole("switch", { name: new RegExp(`use ${name}`) }) as HTMLButtonElement;
}

describe("ProjectAgentToolsSection", () => {
  it("renders one row per endpoint with its state", async () => {
    agentMcpApi.listProjectEndpoints.mockResolvedValue(
      snapshot([
        endpoint({ description: "Reads entries", enabled: true }),
        endpoint({
          pluginInstanceId: "acme.notes",
          pluginDisplayName: "Notes",
          endpointId: "notes",
          name: "Team notes",
        }),
      ])
    );
    render(<ProjectAgentToolsSection />);

    await screen.findByTestId("project-agent-tools");
    const rows = screen.getAllByTestId("project-agent-tool-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "LedgerInstalledHousehold ledgerReads entries",
      "NotesInstalledTeam notes",
    ]);
    expect(switchFor("Household ledger").getAttribute("aria-checked")).toBe("true");
    expect(switchFor("Team notes").getAttribute("aria-checked")).toBe("false");
  });

  it("renders nothing when no plugin offers agent tools here", async () => {
    agentMcpApi.listProjectEndpoints.mockResolvedValue(snapshot([]));
    const { container } = render(<ProjectAgentToolsSection />);

    await waitFor(() => expect(agentMcpApi.listProjectEndpoints).toHaveBeenCalled());
    await act(async () => {});
    expect(container.innerHTML).toBe("");
  });

  it("toggling calls main and shows the state main answers with", async () => {
    agentMcpApi.listProjectEndpoints.mockResolvedValue(snapshot([endpoint()]));
    agentMcpApi.setProjectEndpointEnabled.mockResolvedValue(
      snapshot([endpoint({ enabled: true })])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    fireEvent.click(switchFor("Household ledger"));

    expect(agentMcpApi.setProjectEndpointEnabled).toHaveBeenCalledWith({
      pluginInstanceId: "acme.ledger",
      endpointId: "data",
      enabled: true,
    });
    await waitFor(() =>
      expect(switchFor("Household ledger").getAttribute("aria-checked")).toBe("true")
    );
  });

  it("keeps the old state and offers a retry when the change fails", async () => {
    agentMcpApi.listProjectEndpoints.mockResolvedValue(snapshot([endpoint({ enabled: true })]));
    agentMcpApi.setProjectEndpointEnabled.mockRejectedValueOnce(new Error("boom"));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    fireEvent.click(switchFor("Household ledger"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Household ledger");
    expect(switchFor("Household ledger").getAttribute("aria-checked")).toBe("true");

    agentMcpApi.setProjectEndpointEnabled.mockResolvedValueOnce(snapshot([endpoint()]));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(switchFor("Household ledger").getAttribute("aria-checked")).toBe("false")
    );
    expect(agentMcpApi.setProjectEndpointEnabled).toHaveBeenLastCalledWith({
      pluginInstanceId: "acme.ledger",
      endpointId: "data",
      enabled: false,
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lets a stale answer be turned off but never back on", async () => {
    agentMcpApi.listProjectEndpoints.mockResolvedValue(
      snapshot([endpoint({ enabled: true, available: false })])
    );
    agentMcpApi.setProjectEndpointEnabled.mockResolvedValue(snapshot([]));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    const toggle = switchFor("Household ledger");
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);

    expect(agentMcpApi.setProjectEndpointEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    await waitFor(() => expect(screen.queryByTestId("project-agent-tools")).toBeNull());
  });

  it("points at the MCP server only while it is off", async () => {
    agentMcpApi.listProjectEndpoints.mockResolvedValue(snapshot([endpoint()], false));
    render(<ProjectAgentToolsSection />);
    const section = await screen.findByTestId("project-agent-tools");
    expect(section.textContent).toContain("MCP server, which is off");

    agentMcpApi.listProjectEndpoints.mockResolvedValue(snapshot([endpoint()], true));
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
    agentMcpApi.listProjectEndpoints.mockResolvedValue(snapshot([]));
    render(<ProjectAgentToolsSection />);
    await waitFor(() => expect(agentMcpApi.listProjectEndpoints).toHaveBeenCalledTimes(1));

    agentMcpApi.listProjectEndpoints.mockResolvedValue(snapshot([endpoint()]));
    act(() => {
      fire();
    });

    await screen.findByTestId("project-agent-tools");
  });

  it("stops listening on unmount", async () => {
    agentMcpApi.listProjectEndpoints.mockResolvedValue(snapshot([]));
    const { unmount } = render(<ProjectAgentToolsSection />);
    await waitFor(() => expect(agentMcpApi.listProjectEndpoints).toHaveBeenCalled());

    unmount();
    expect(unsubscribeProvenance).toHaveBeenCalled();
    expect(unsubscribeRuntimeStatus).toHaveBeenCalled();
    expect(unsubscribeMcpState).toHaveBeenCalled();
    agentMcpApi.listProjectEndpoints.mockClear();
    window.dispatchEvent(new Event("focus"));
    expect(agentMcpApi.listProjectEndpoints).not.toHaveBeenCalled();
  });

  it("tells an installed plugin apart from a project copy with the same name", async () => {
    agentMcpApi.listProjectEndpoints.mockResolvedValue(
      snapshot([
        endpoint(),
        endpoint({ pluginInstanceId: `project__${"a".repeat(64)}__acme.ledger` }),
      ])
    );
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    const labels = screen.getAllByRole("switch").map((el) => el.getAttribute("aria-label") ?? "");
    expect(new Set(labels).size).toBe(2);
    expect(labels.some((l) => l.includes("(project)"))).toBe(true);
    expect(labels.some((l) => l.includes("(installed)"))).toBe(true);
  });

  it("a read that fails mid-toggle never discards the toggle's answer", async () => {
    agentMcpApi.listProjectEndpoints.mockResolvedValueOnce(snapshot([endpoint()]));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    const write = deferred<ProjectAgentToolsSnapshot>();
    agentMcpApi.setProjectEndpointEnabled.mockReturnValueOnce(write.promise);
    fireEvent.click(switchFor("Household ledger"));

    const read = deferred<ProjectAgentToolsSnapshot>();
    agentMcpApi.listProjectEndpoints.mockReturnValueOnce(read.promise);
    act(() => provenanceListener?.());
    await act(async () => read.reject(new Error("offline")));

    await act(async () => write.resolve(snapshot([endpoint({ enabled: true })])));
    expect(switchFor("Household ledger").getAttribute("aria-checked")).toBe("true");
  });

  it("a read sent before a toggle lands can't paint the switch back", async () => {
    agentMcpApi.listProjectEndpoints.mockResolvedValueOnce(snapshot([endpoint()]));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tools");

    const read = deferred<ProjectAgentToolsSnapshot>();
    agentMcpApi.listProjectEndpoints.mockReturnValueOnce(read.promise);
    act(() => provenanceListener?.());

    agentMcpApi.setProjectEndpointEnabled.mockResolvedValueOnce(
      snapshot([endpoint({ enabled: true })])
    );
    fireEvent.click(switchFor("Household ledger"));
    await waitFor(() =>
      expect(switchFor("Household ledger").getAttribute("aria-checked")).toBe("true")
    );

    await act(async () => read.resolve(snapshot([endpoint()])));
    expect(switchFor("Household ledger").getAttribute("aria-checked")).toBe("true");
  });

  it("flags a failed refresh over rows it can no longer vouch for", async () => {
    agentMcpApi.listProjectEndpoints.mockResolvedValueOnce(snapshot([endpoint()]));
    render(<ProjectAgentToolsSection />);
    await screen.findByTestId("project-agent-tool-row");

    agentMcpApi.listProjectEndpoints.mockRejectedValueOnce(new Error("offline"));
    act(() => provenanceListener?.());
    expect((await screen.findByRole("alert")).textContent).toContain("out of date");
    expect(screen.getByTestId("project-agent-tool-row")).toBeTruthy();

    agentMcpApi.listProjectEndpoints.mockResolvedValueOnce(snapshot([endpoint()]));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("offers a retry when the first read fails", async () => {
    agentMcpApi.listProjectEndpoints.mockRejectedValueOnce(new Error("offline"));
    render(<ProjectAgentToolsSection />);

    await screen.findByRole("alert");
    agentMcpApi.listProjectEndpoints.mockResolvedValueOnce(snapshot([endpoint()]));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByTestId("project-agent-tool-row");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
