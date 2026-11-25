import { describe, expect, it, vi } from "vitest";
import type { CanopyHostEvent } from "../../../../shared/types/ipc/canopyHost.js";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import type { EventMessage } from "../../link/messages.js";
import { CanopyHostsClient } from "../client.js";
import { AppError } from "../../../utils/errorTypes.js";
import { CANOPY_VIEWER_ENDPOINT_PREFIX, CanopyLinkMethod } from "../linkMethods.js";
import { CanopyViewers } from "../viewer.js";

const VIEW = 7;
const VIEW_ON_LOCAL = null;
const KNOWN_HOSTS = new Set(["studio", "attic"]);

type HostAnswer = (method: string, payload: Record<string, unknown>) => unknown;

function setup(options: { answer?: HostAnswer; hostForView?: (id: number) => string | null } = {}) {
  const calls: Array<{ hostId: string; method: string; payload: Record<string, unknown> }> = [];
  const answer: HostAnswer =
    options.answer ??
    ((method, payload) => {
      if (method !== CanopyLinkMethod.SIGN_IN) return null;
      if (payload.op === "start") return { terminalId: "daintree-sign-in-1", spawnedAt: 100 };
      if (payload.op === "watch") return { watchId: 9, snapshot: { data: "", cols: 80, rows: 24 } };
      return null;
    });
  const connections = new Map<string, { callHost: (m: string, p: unknown) => Promise<unknown> }>();
  for (const hostId of ["studio", "attic"]) {
    connections.set(hostId, {
      callHost: vi.fn(async (method: string, payload: unknown) => {
        calls.push({ hostId, method, payload: payload as Record<string, unknown> });
        return answer(method, payload as Record<string, unknown>);
      }),
    });
  }
  const sessionListeners: Array<(hostId: string, session: unknown) => void> = [];
  const viewerListeners: Array<(hostId: string, event: EventMessage) => void> = [];
  const useChecks: Array<(hostId: string) => boolean> = [];
  const sent: Array<{ webContentsId: number; event: CanopyHostEvent }> = [];
  const connect = vi.fn();
  let viewerCount = 0;
  const client = new CanopyHostsClient({
    manager: {
      get: (hostId) => connections.get(hostId),
      connect,
      touch: () => {},
      addUseCheck: (check) => {
        useChecks.push(check);
        return () => {};
      },
      onSessionOpened: (listener) => {
        sessionListeners.push(listener as (typeof sessionListeners)[number]);
        return () => {};
      },
      onViewerEvent: (listener) => {
        viewerListeners.push(listener);
        return () => {};
      },
    },
    registry: {
      get: (hostId) => (KNOWN_HOSTS.has(hostId) ? { id: hostId } : null),
      onChange: () => () => {},
    },
    hostForView: options.hostForView ?? (() => VIEW_ON_LOCAL),
    local: new CanopyViewers({
      source: { observeCanopy: () => () => {}, observeFleet: () => null },
      invoke: async () => wrapSuccess(null),
    }),
    localClient: { clientId: "local", clientName: "mbp", platform: "darwin", kind: "local" },
    send: (webContentsId, event) => {
      sent.push({ webContentsId, event });
      return true;
    },
    watchView: () => () => {},
    newViewerId: () => `v${++viewerCount}`,
  });
  client.start();
  const fakeSession = { registerCallHandler: () => () => {} };
  return {
    client,
    calls,
    connections,
    sent,
    connect,
    inUse: (hostId: string) => useChecks.some((check) => check(hostId)),
    sessionOpened: (hostId: string) => sessionListeners.forEach((l) => l(hostId, fakeSession)),
    viewerEvent: (hostId: string, event: EventMessage) =>
      viewerListeners.forEach((l) => l(hostId, event)),
  };
}

describe("CanopyHostsClient sign-ins", () => {
  it("asks the named host to start the agent's sign-in, and holds its link meanwhile", async () => {
    const s = setup();
    await expect(s.client.startSignIn(VIEW, "dialog-1", "studio", "claude")).resolves.toEqual({
      terminalId: "daintree-sign-in-1",
      spawnedAt: 100,
    });
    expect(s.calls).toEqual([
      {
        hostId: "studio",
        method: CanopyLinkMethod.SIGN_IN,
        payload: { viewerId: "v1", op: "start", agentId: "claude" },
      },
    ]);
    expect(s.inUse("studio")).toBe(true);
    expect(s.inUse("attic")).toBe(false);
  });

  it("starts one on the window's own host too, through a viewer of its own", async () => {
    const s = setup({ hostForView: () => "studio" });
    await s.client.startSignIn(VIEW, "dialog-1", "studio", "codex");
    expect(s.calls[0]).toMatchObject({ hostId: "studio", payload: { op: "start" } });
  });

  it("never dials a host that isn't connected", async () => {
    const s = setup();
    // Still in the host list, just not connected.
    s.connections.delete("attic");
    await expect(s.client.startSignIn(VIEW, "dialog-1", "attic", "claude")).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
    expect(s.connect).not.toHaveBeenCalled();
    expect(s.inUse("attic")).toBe(false);
  });

  it("refuses This Mac and hosts it doesn't know", async () => {
    const s = setup();
    await expect(s.client.startSignIn(VIEW, "dialog-1", "local", "claude")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(s.client.startSignIn(VIEW, "dialog-1", "nowhere", "claude")).rejects.toMatchObject(
      { code: "NOT_FOUND" }
    );
    expect(s.calls).toEqual([]);
  });

  it("says a host from before sign-ins needs a newer Daintree, and keeps nothing open", async () => {
    const s = setup({
      answer: () => {
        throw new AppError({ code: "UNSUPPORTED", message: "Unknown method: canopy.sign-in" });
      },
    });
    await expect(s.client.startSignIn(VIEW, "dialog-1", "studio", "claude")).rejects.toMatchObject({
      code: "UNSUPPORTED",
      userMessage: "This host needs a newer Daintree to sign in its agents from here.",
    });
    expect(s.inUse("studio")).toBe(false);
  });

  it("watches, types and sizes through the viewer that started it, and routes its bytes by consumer", async () => {
    const s = setup();
    await s.client.startSignIn(VIEW, "dialog-1", "studio", "claude");
    const view = await s.client.signInStep(VIEW, "dialog-1", { op: "watch" });
    expect(view?.watchId).toBe(9);
    await s.client.signInStep(VIEW, "dialog-1", { op: "input", watchId: 9, data: "code\r" });
    await s.client.signInStep(VIEW, "dialog-1", { op: "resize", watchId: 9, cols: 100, rows: 30 });
    expect(s.calls.slice(1).map((call) => call.payload)).toEqual([
      { viewerId: "v1", op: "watch" },
      { viewerId: "v1", op: "input", watchId: 9, data: "code\r" },
      { viewerId: "v1", op: "resize", watchId: 9, cols: 100, rows: 30 },
    ]);

    const chunk = { kind: "data", watchId: 9, runId: "daintree-sign-in-1", data: "Paste code:" };
    s.viewerEvent("studio", {
      endpointId: `${CANOPY_VIEWER_ENDPOINT_PREFIX}v1`,
      channel: "canopy:terminal-data",
      args: [chunk],
    } as EventMessage);
    // Only the host it was opened on speaks for it.
    s.viewerEvent("attic", {
      endpointId: `${CANOPY_VIEWER_ENDPOINT_PREFIX}v1`,
      channel: "canopy:terminal-data",
      args: [chunk],
    } as EventMessage);
    expect(s.sent).toEqual([
      {
        webContentsId: VIEW,
        event: { kind: "sign-in-terminal-data", hostId: "studio", consumer: "dialog-1", chunk },
      },
    ]);
  });

  it("sends only the step's own fields, and refuses a malformed one", async () => {
    const s = setup();
    await s.client.startSignIn(VIEW, "dialog-1", "studio", "claude");
    await s.client.signInStep(VIEW, "dialog-1", {
      op: "input",
      watchId: 9,
      data: "y",
      agentId: "other",
    });
    expect(s.calls[1]!.payload).toEqual({ viewerId: "v1", op: "input", watchId: 9, data: "y" });
    await expect(
      s.client.signInStep(VIEW, "dialog-1", { op: "resize", watchId: 9, cols: 0, rows: 30 })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("lets the host end it when the consumer closes, and refuses typing after", async () => {
    const s = setup();
    await s.client.startSignIn(VIEW, "dialog-1", "studio", "claude");
    s.client.releaseSignIn(VIEW, "dialog-1");
    expect(s.calls.at(-1)).toMatchObject({
      method: CanopyLinkMethod.RELEASE,
      payload: { viewerId: "v1" },
    });
    expect(s.inUse("studio")).toBe(false);
    await expect(
      s.client.signInStep(VIEW, "dialog-1", { op: "input", watchId: 9, data: "y" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      s.client.signInStep(VIEW, "dialog-1", { op: "unwatch", watchId: 9 })
    ).resolves.toBeNull();
  });

  it("ends a sign-in released while it started, on the host and here", async () => {
    let finish: (value: unknown) => void = () => {};
    const s = setup({
      answer: (method) =>
        method === CanopyLinkMethod.SIGN_IN
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : null,
    });
    const started = s.client.startSignIn(VIEW, "dialog-1", "studio", "claude");
    s.client.releaseSignIn(VIEW, "dialog-1");
    expect(s.calls.map((call) => call.method)).toEqual([
      CanopyLinkMethod.SIGN_IN,
      CanopyLinkMethod.RELEASE,
    ]);
    finish({ terminalId: "daintree-sign-in-1", spawnedAt: 100 });
    await expect(started).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(s.inUse("studio")).toBe(false);
  });

  it("runs one sign-in per consumer", async () => {
    const s = setup();
    await s.client.startSignIn(VIEW, "dialog-1", "studio", "claude");
    await expect(s.client.startSignIn(VIEW, "dialog-1", "studio", "codex")).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("says the stream ended when the link to its host comes back, and opens nothing again", async () => {
    const s = setup();
    await s.client.startSignIn(VIEW, "dialog-1", "studio", "claude");
    await s.client.signInStep(VIEW, "dialog-1", { op: "watch" });
    const before = s.calls.length;
    s.sessionOpened("studio");
    expect(s.sent).toEqual([
      {
        webContentsId: VIEW,
        event: {
          kind: "sign-in-terminal-data",
          hostId: "studio",
          consumer: "dialog-1",
          chunk: { kind: "ended", watchId: 9, runId: "daintree-sign-in-1" },
        },
      },
    ]);
    // Its viewer went with the old link: nothing is started or watched again.
    expect(s.calls.slice(before).filter((call) => call.method === CanopyLinkMethod.SIGN_IN)).toEqual(
      []
    );
    expect(s.inUse("studio")).toBe(false);
    await expect(
      s.client.signInStep(VIEW, "dialog-1", { op: "input", watchId: 9, data: "y" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
