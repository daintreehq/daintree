import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnectionState, HostDescriptor, HostListEntry } from "@shared/types/remoteHosts";
import type { HostProbeResult } from "@shared/types/ipc/remoteHosts";

const client = vi.hoisted(() => ({
  probe: vi.fn(),
  list: vi.fn(),
  add: vi.fn(),
  connectAndSettle: vi.fn(),
  forget: vi.fn(),
}));
const requestHostSwitch = vi.hoisted(() => vi.fn());
const requestHostUpdate = vi.hoisted(() => vi.fn());
const openHostsSettingsTab = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  shell: true,
  kind: "ssh" as "ssh" | "wsl",
  viewHost: null as string | null,
}));

vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: client }));
vi.mock("@/components/HostSwitch/hostSwitchRequests", () => ({ requestHostSwitch }));
vi.mock("@/components/Settings/Hosts/hostUpdateRequests", () => ({ requestHostUpdate }));
vi.mock("@/components/Settings/Hosts/hostSettingsRequests", () => ({ openHostsSettingsTab }));
vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => env.viewHost }));
vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => env.shell,
  remoteConnectionKind: () => env.kind,
}));

import {
  canOpenResourceBoxOnHost,
  freeHostName,
  openResourceBoxOnHost,
} from "../resourceHostHandoff";

function descriptor(id: string, target: string, ownerWorktreeId?: string): HostDescriptor {
  return {
    id,
    name: id,
    connection: { kind: "ssh", target },
    platform: null,
    arch: null,
    lastHandshake: null,
    lastSeenAt: null,
    addedAt: 0,
    notificationsEnabled: false,
    assistantControlEnabled: true,
    ...(ownerWorktreeId ? { ownerWorktreeId } : {}),
  };
}

function entry(host: HostDescriptor): HostListEntry {
  return {
    descriptor: host,
    connection: { status: "disconnected" },
    summary: null,
  };
}

type ProbeFields = Pick<HostProbeResult, "reachable" | "sshError" | "hostModeListening">;

/** The probe fields the handoff reads; the client mock is untyped, so nothing else is needed. */
function probeResult(overrides: Partial<ProbeFields>): ProbeFields {
  return { reachable: true, sshError: null, hostModeListening: true, ...overrides };
}

const box = {
  worktreeId: "/repo/wt/feature-x",
  worktreePath: "/repo/wt/feature-x",
  projectId: "proj-1",
  sshTarget: "dt-feature-x",
};

const connected: Pick<HostConnectionState, "status"> = { status: "connected" };

describe("resource box handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.shell = true;
    env.kind = "ssh";
    env.viewHost = null;
    client.list.mockResolvedValue([]);
    client.add.mockImplementation(async (payload: { name: string; ownerWorktreeId?: string }) =>
      descriptor(payload.name, box.sshTarget, payload.ownerWorktreeId)
    );
    client.connectAndSettle.mockResolvedValue(connected);
    requestHostSwitch.mockReturnValue(1);
  });

  it("adds the box as a host owned by the worktree and places the branch there", async () => {
    client.probe.mockResolvedValue(probeResult({ hostModeListening: true }));

    const outcome = await openResourceBoxOnHost(box);

    expect(client.add).toHaveBeenCalledWith({
      name: "dt-feature-x",
      connection: { kind: "ssh", target: "dt-feature-x" },
      ownerWorktreeId: box.worktreeId,
    });
    expect(client.connectAndSettle).toHaveBeenCalledWith("dt-feature-x");
    expect(requestHostSwitch).toHaveBeenCalledWith({
      toHostId: "dt-feature-x",
      projectId: "proj-1",
      worktreePath: box.worktreePath,
      askFirst: false,
    });
    expect(requestHostUpdate).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "placing", hostId: "dt-feature-x" });
  });

  it("uses a host the user already has for that target, and never claims it", async () => {
    client.probe.mockResolvedValue(probeResult({ hostModeListening: true }));
    client.list.mockResolvedValue([entry(descriptor("my-box", "dt-feature-x"))]);

    const outcome = await openResourceBoxOnHost(box);

    expect(client.add).not.toHaveBeenCalled();
    expect(requestHostSwitch).toHaveBeenCalledWith(expect.objectContaining({ toHostId: "my-box" }));
    expect(outcome).toEqual({ status: "placing", hostId: "my-box" });
  });

  it("refuses a host another worktree's resource added, rather than sharing it", async () => {
    client.probe.mockResolvedValue(probeResult({ hostModeListening: true }));
    client.list.mockResolvedValue([entry(descriptor("box", "dt-feature-x", "/repo/wt/other"))]);

    await expect(openResourceBoxOnHost(box)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(client.add).not.toHaveBeenCalled();
    expect(requestHostSwitch).not.toHaveBeenCalled();
  });

  it("keeps using a host this worktree's resource already added", async () => {
    client.probe.mockResolvedValue(probeResult({ hostModeListening: true }));
    client.list.mockResolvedValue([entry(descriptor("box", "dt-feature-x", box.worktreeId))]);

    const outcome = await openResourceBoxOnHost(box);

    expect(client.add).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "placing", hostId: "box" });
  });

  it("opens Host setup, without connecting, when Daintree isn't listening there", async () => {
    client.probe.mockResolvedValue(probeResult({ hostModeListening: false }));

    const outcome = await openResourceBoxOnHost(box);

    expect(client.add).toHaveBeenCalled();
    expect(client.connectAndSettle).not.toHaveBeenCalled();
    expect(requestHostUpdate).toHaveBeenCalledWith("dt-feature-x");
    expect(openHostsSettingsTab).toHaveBeenCalled();
    expect(requestHostSwitch).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "setup", hostId: "dt-feature-x" });
  });

  it("opens Host setup when a listener answers but the link doesn't come up", async () => {
    client.probe.mockResolvedValue(probeResult({ hostModeListening: true }));
    client.connectAndSettle.mockResolvedValue({ status: "disconnected" });

    const outcome = await openResourceBoxOnHost(box);

    expect(requestHostUpdate).toHaveBeenCalledWith("dt-feature-x");
    expect(requestHostSwitch).not.toHaveBeenCalled();
    expect(outcome.status).toBe("setup");
  });

  it("adds nothing when ssh can't reach the box, and says so in ssh's words", async () => {
    client.probe.mockResolvedValue(
      probeResult({ reachable: false, sshError: "Host key verification failed." })
    );

    await expect(openResourceBoxOnHost(box)).rejects.toMatchObject({
      userMessage: "Host key verification failed.",
    });
    expect(client.add).not.toHaveBeenCalled();
    expect(requestHostSwitch).not.toHaveBeenCalled();
  });

  it("refuses where hosts aren't reached over ssh, before touching the box", async () => {
    env.kind = "wsl";

    await expect(openResourceBoxOnHost(box)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(client.probe).not.toHaveBeenCalled();
  });

  it("is offered only for a valid target, from a window on this machine, where ssh reaches hosts", () => {
    expect(canOpenResourceBoxOnHost("dt-feature-x")).toBe(true);
    expect(canOpenResourceBoxOnHost(undefined)).toBe(false);
    expect(canOpenResourceBoxOnHost("-oProxyCommand=x")).toBe(false);
    env.viewHost = "studio";
    expect(canOpenResourceBoxOnHost("dt-feature-x")).toBe(false);
    env.viewHost = null;
    env.kind = "wsl";
    expect(canOpenResourceBoxOnHost("dt-feature-x")).toBe(false);
    env.kind = "ssh";
    env.shell = false;
    expect(canOpenResourceBoxOnHost("dt-feature-x")).toBe(false);
  });

  it("adds nothing for a worktree that went away while ssh was asked", async () => {
    client.probe.mockResolvedValue(probeResult({ hostModeListening: true }));

    await expect(openResourceBoxOnHost({ ...box, isCurrent: () => false })).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(client.add).not.toHaveBeenCalled();
  });

  it("takes back the host it added when the worktree went away meanwhile", async () => {
    client.probe.mockResolvedValue(probeResult({ hostModeListening: true }));
    let current = true;
    client.add.mockImplementation(async (payload: { name: string; ownerWorktreeId?: string }) => {
      current = false;
      return descriptor(payload.name, box.sshTarget, payload.ownerWorktreeId);
    });

    await expect(openResourceBoxOnHost({ ...box, isCurrent: () => current })).rejects.toMatchObject(
      { code: "CANCELLED" }
    );
    expect(client.forget).toHaveBeenCalledWith("dt-feature-x");
    expect(client.connectAndSettle).not.toHaveBeenCalled();
    expect(requestHostUpdate).not.toHaveBeenCalled();
  });

  it("places nothing, and leaves the user's own host, when the machine changed while connecting", async () => {
    client.probe.mockResolvedValue(probeResult({ hostModeListening: true }));
    client.list.mockResolvedValue([entry(descriptor("my-box", "dt-feature-x"))]);
    let current = true;
    client.connectAndSettle.mockImplementation(async () => {
      current = false;
      return connected;
    });

    await expect(openResourceBoxOnHost({ ...box, isCurrent: () => current })).rejects.toMatchObject(
      { code: "CANCELLED" }
    );
    expect(requestHostSwitch).not.toHaveBeenCalled();
    expect(client.forget).not.toHaveBeenCalled();
  });

  it("keeps a numbered name inside the host list's 64 characters", () => {
    const long = "a".repeat(64);
    const name = freeHostName(long, [entry(descriptor(long, "x"))]);
    expect(name).toHaveLength(64);
    expect(name.endsWith("-2")).toBe(true);
  });

  it("numbers the box's name past hosts already called that", () => {
    const hosts = [entry(descriptor("box", "a")), entry(descriptor("box-2", "b"))];
    expect(freeHostName("root@box.example.com", hosts)).toBe("box-3");
    expect(freeHostName("root@other", hosts)).toBe("other");
  });
});
