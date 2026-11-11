import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDispatchResult } from "../../../../shared/types/actions.js";
import type { LinkSession } from "../../link/session.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import type { MetricsSessionContext } from "../../metrics/hostMetricsHost.js";
import { HostPluginControlClient } from "../HostPluginControlClient.js";
import {
  installHostPluginControl,
  type HostPluginAuditEntry,
  type HostPluginControlDeps,
} from "../hostPluginControl.js";
import { pluginCredentialFor } from "../linkMethods.js";

const HOST_ID = "studio";
const PROJECT = "p".repeat(64);
const SHELL_SECRET = "s".repeat(43);

let dir: string;
let links: { host: LinkSession; client: LinkSession };

beforeEach(async () => {
  dir = await makeTempDir();
  links = await openSessionPair(dir);
});

afterEach(async () => {
  links.host.close("test");
  links.client.close("test");
  await removeTempDir(dir);
});

function shellClient(session: LinkSession | null = links.client): HostPluginControlClient {
  return new HostPluginControlClient({
    hosts: () => [{ hostId: HOST_ID, name: "Studio", connection: { status: "disconnected" } }],
    listHostProjects: async () => [],
    connect: async () => undefined,
    session: async () => session,
    credential: () => pluginCredentialFor(SHELL_SECRET),
  });
}

function installOnHost(overrides: Partial<HostPluginControlDeps> = {}) {
  const audits: HostPluginAuditEntry[] = [];
  const runWithoutView = vi.fn(async (): Promise<ActionDispatchResult | null> => ({
    ok: true,
    result: { worktrees: [] },
  }));
  const ctx = {
    session: links.host,
    sessionId: "link-1",
    client: { clientName: "Greg's MacBook" },
  } as unknown as MetricsSessionContext;
  const dispose = installHostPluginControl(
    { sessions: [ctx], onSession: () => () => {} } as never,
    {
      acceptsRemoteControl: () => true,
      hasProject: async (projectId) => projectId === PROJECT,
      standing: () => ({ kind: "vacant" }),
      hasViewlessForm: () => true,
      runWithoutView,
      audit: (entry) => audits.push(entry),
      pty: () => null,
      ...overrides,
    }
  );
  return { audits, runWithoutView, dispose };
}

describe("a Shell plugin's call over a real link (#16767)", () => {
  it("arrives on the host as that plugin from that Shell, and its answer comes back", async () => {
    const host = installOnHost();

    const result = await shellClient().dispatch(
      { hostId: HOST_ID, pluginId: "acme.beads" },
      { projectId: PROJECT, actionId: "worktree.list", args: {} }
    );

    expect(result).toEqual({ ok: true, result: { worktrees: [] } });
    expect(host.runWithoutView).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: PROJECT, actionId: "worktree.list", source: "plugin" })
    );
    expect(host.audits).toEqual([
      expect.objectContaining({ pluginId: "acme.beads", shellName: "Greg's MacBook" }),
    ]);
    host.dispose();
  });

  it("carries a host-side refusal back to the plugin as its answer", async () => {
    const host = installOnHost({ acceptsRemoteControl: () => false });
    const result = await shellClient().dispatch(
      { hostId: HOST_ID, pluginId: "acme.beads" },
      { projectId: PROJECT, actionId: "worktree.list", args: {} }
    );
    expect(result).toMatchObject({ ok: false, error: { code: "HOST_REFUSED" } });
    expect(host.runWithoutView).not.toHaveBeenCalled();
    host.dispose();
  });

  it("hears HOST_REFUSED from a host from before plugins could reach it", async () => {
    // Nothing installed on the host: the method is unknown there.
    const client = shellClient();
    const result = await client.dispatch(
      { hostId: HOST_ID, pluginId: "acme.beads" },
      { projectId: PROJECT, actionId: "worktree.list", args: {} }
    );
    expect(result).toMatchObject({ ok: false, error: { code: "HOST_REFUSED" } });
    expect(
      await client.agentInput({ hostId: HOST_ID, pluginId: "acme.beads" }, "t-1", {
        op: "interrupt",
      })
    ).toMatchObject({ status: "refused" });
  });

  it("sends nothing when the host can't be reached", async () => {
    const result = await shellClient(null).dispatch(
      { hostId: HOST_ID, pluginId: "acme.beads" },
      { projectId: PROJECT, actionId: "worktree.list", args: {} }
    );
    expect(result).toMatchObject({ ok: false, error: { code: "HOST_UNREACHABLE" } });
  });

  it("answers not-found on the host for an agent its plugin never launched there", async () => {
    const host = installOnHost();
    expect(
      await shellClient().agentInput({ hostId: HOST_ID, pluginId: "acme.beads" }, "t-1", {
        op: "submit",
        text: "continue",
      })
    ).toEqual({ status: "not-found" });
    host.dispose();
  });

  it("carries every input shape to the host, which checks its own record of the launch", async () => {
    const pty = {
      write: vi.fn(),
      submit: vi.fn(),
      batchDoubleEscape: vi.fn(),
      getTerminalAsync: vi.fn(async (id: string) => ({
        id,
        cwd: "/srv",
        spawnedAt: 1,
        kind: "terminal",
        hasPty: true,
        detectedAgentId: "claude",
        agentState: "working",
      })),
      getSerializedStateAsync: vi.fn(async () => ({ data: "" })),
      getTerminalProjectId: () => PROJECT,
    };
    const host = installOnHost({
      runWithoutView: async () => ({ ok: true, result: { launched: true, terminalId: "t-9" } }),
      pty: () => pty as unknown as ReturnType<HostPluginControlDeps["pty"]>,
    });
    const client = shellClient();
    const target = { hostId: HOST_ID, pluginId: "acme.beads" };
    await client.dispatch(target, {
      projectId: PROJECT,
      actionId: "agent.launch",
      args: { agentId: "claude" },
    });

    expect((await client.agentInput(target, "t-9", { op: "interrupt" })).status).toBe("sent");
    expect(pty.batchDoubleEscape).toHaveBeenCalledWith(["t-9"]);
    expect(await client.agentInput(target, "t-9", { op: "sendKeys", keys: ["Escape"] })).toEqual({
      status: "sent",
      keys: ["Escape"],
    });
    expect(pty.write).toHaveBeenCalledTimes(1);
    // A choice reads the screen to find its label; this one shows none.
    expect((await client.agentInput(target, "t-9", { op: "sendKeys", choose: "Yes" })).status).toBe(
      "refused"
    );
    expect(pty.getSerializedStateAsync).toHaveBeenCalled();
    expect(await client.agentInput(target, "t-9", { op: "submit", text: "continue" })).toEqual({
      status: "sent",
    });
    expect(pty.submit).toHaveBeenCalledWith("t-9", "continue");
    expect(
      await client.agentInput({ ...target, pluginId: "acme.other" }, "t-9", { op: "interrupt" })
    ).toEqual({ status: "not-found" });
    host.dispose();
  });
});

describe("HostPluginControlClient before anything is sent (#16767)", () => {
  it("refuses arguments that aren't plain JSON within the bound, sending nothing", async () => {
    const call = vi.spyOn(links.client, "call");
    const client = shellClient();
    for (const args of [{ ids: new Map([["a", 1]]) }, { big: 1n }, { text: "x".repeat(300_000) }]) {
      expect(
        await client.dispatch(
          { hostId: HOST_ID, pluginId: "acme.beads" },
          { projectId: PROJECT, actionId: "worktree.list", args }
        )
      ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    }
    expect(call).not.toHaveBeenCalled();
  });

  it("sends nothing when the plugin's admission fails once the link is open", async () => {
    const host = installOnHost();
    await expect(
      shellClient().dispatch(
        {
          hostId: HOST_ID,
          pluginId: "acme.beads",
          admit: () => {
            throw new Error("PERMISSION_REQUIRED: switched off");
          },
        },
        { projectId: PROJECT, actionId: "worktree.list", args: {} }
      )
    ).rejects.toThrow(/switched off/);
    expect(host.runWithoutView).not.toHaveBeenCalled();
    expect(host.audits).toEqual([]);
    host.dispose();
  });
});

describe("HostPluginControlClient.listHosts (#16767)", () => {
  it("dials an idle host, leaves one the person disconnected, and lists connected hosts' projects", async () => {
    const states = new Map<string, "connected" | "disconnected">([
      ["idle", "disconnected"],
      ["off", "disconnected"],
      ["up", "connected"],
    ]);
    const connect = vi.fn(async (hostId: string) => {
      states.set(hostId, "connected");
    });
    const client = new HostPluginControlClient({
      hosts: () =>
        [...states].map(([hostId, status]) => ({
          hostId,
          name: hostId.toUpperCase(),
          connection: status === "connected" ? { status, rttMs: null } : { status },
          disconnectedByPerson: hostId === "off",
        })) as never,
      listHostProjects: async (hostId) => [
        { id: `${hostId}-project`, name: `${hostId} project`, path: `/srv/${hostId}` },
      ],
      connect,
      session: async () => null,
      credential: () => null,
    });

    const hosts = await client.listHosts();

    expect(connect.mock.calls.map(([hostId]) => hostId)).toEqual(["idle"]);
    expect(hosts).toEqual([
      {
        hostId: "idle",
        name: "IDLE",
        connection: "connected",
        projects: [{ projectId: "idle-project", name: "idle project" }],
      },
      { hostId: "off", name: "OFF", connection: "disconnected", projects: null },
      {
        hostId: "up",
        name: "UP",
        connection: "connected",
        projects: [{ projectId: "up-project", name: "up project" }],
      },
    ]);
  });
});
