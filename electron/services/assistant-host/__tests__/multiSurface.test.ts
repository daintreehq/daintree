import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * One project, one engine, many surfaces.
 *
 * Opening a project in a second window used to displace the running engine, silently
 * tearing down the conversation the first window was showing. Two engines is not the
 * alternative: the engine holds an exclusive flock lease on the project's state, so a
 * sibling queues behind it and times out. So surfaces SHARE one engine — which only
 * works if the things a shared engine cannot do for itself are done here: mirroring
 * prompts it never echoes, moving the control plane to the window being used, and
 * refcounting so the last surface out turns the lights off.
 */

interface FakeHost {
  sessionId: string;
  disposed: boolean;
  prompts: string[];
  emit: (event: unknown) => void;
}
const hosts: FakeHost[] = [];

vi.mock("../AssistantHostProcess.js", () => ({
  AssistantHostProcess: class {
    private readonly record: FakeHost;
    private readonly transcript: unknown[] = [];
    private readonly recorded: Array<{ text: string; afterSeq: number }> = [];
    constructor(opts: { descriptor: { sessionId: string }; onEvent: (e: unknown) => void }) {
      this.record = {
        sessionId: opts.descriptor.sessionId,
        disposed: false,
        prompts: [],
        emit: (event: unknown) => {
          this.transcript.push(event);
          opts.onEvent(event);
        },
      };
      hosts.push(this.record);
    }
    start() {}
    waitForReady() {
      return Promise.resolve();
    }
    getReadyEvent() {
      return { type: "host:ready", sessionId: this.record.sessionId, seq: 1, autoApprove: false };
    }
    getTranscript() {
      return { events: [...this.transcript], prompts: [...this.recorded], truncated: false };
    }
    recordPrompt(text: string) {
      this.recorded.push({ text, afterSeq: 1 });
    }
    hasExited() {
      return false;
    }
    send() {
      return true;
    }
    getPid() {
      return 1234;
    }
    takePreReadyEvents() {
      return [];
    }
    dispose() {
      this.record.disposed = true;
    }
    waitForExit() {
      return Promise.resolve();
    }
  },
}));

const REAL_PLATFORM = process.platform;
beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

vi.mock("../resolveAssistantBinary.js", () => ({
  ASSISTANT_BIN_ENV: "DAINTREE_ASSISTANT_BIN",
  resolveAssistantBinary: () =>
    Promise.resolve({ path: "/nonexistent/daintree-assistant", source: "repo" }),
}));

const delivered = new Map<number, Array<{ channel: string; payload: unknown }>>();
const destroyed = new Set<number>();

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/daintree-multisurface-test", isPackaged: false },
  webContents: {
    fromId: (id: number) => ({
      isDestroyed: () => destroyed.has(id),
      send: (channel: string, payload: unknown) => {
        const list = delivered.get(id) ?? [];
        list.push({ channel, payload });
        delivered.set(id, list);
      },
    }),
  },
}));

vi.mock("../../../ipc/handlers/helpAssistant.js", () => ({
  getHelpAssistantSettings: () => ({ tier: "action" }),
}));

vi.mock("../../HelpSessionService.js", () => ({
  helpSessionService: {
    provisionSession: () =>
      Promise.resolve({
        sessionId: "help_1",
        sessionPath: "/tmp/daintree-multisurface-test/help_1",
        token: "tok",
        tier: "action",
        mcpUrl: "http://127.0.0.1:1/mcp",
        windowId: 1,
      }),
    markEngineSession: () => true,
    getDebugLoggingPreference: () => false,
    getDebugLogging: () => false,
    getBypassPermissions: () => false,
    revokeSession: () => Promise.resolve(),
  },
}));

const { AssistantHostService } = await import("../AssistantHostService.js");

const PROJECT = "p1";
const CWD = "/tmp/project";

const deliveriesTo = (id: number) => delivered.get(id) ?? [];
const peerPromptsTo = (id: number) =>
  deliveriesTo(id).filter((d) => d.channel === "assistant-host:peer-prompt");

beforeEach(() => {
  hosts.length = 0;
  delivered.clear();
  destroyed.clear();
});

async function twoSurfaces() {
  const service = new AssistantHostService();
  const first = await service.start({
    projectId: PROJECT,
    cwd: CWD,
    windowId: 1,
    webContentsId: 10,
  });
  const second = await service.start({
    projectId: PROJECT,
    cwd: CWD,
    windowId: 2,
    webContentsId: 11,
  });
  return { service, first, second };
}

describe("a project open on more than one surface", () => {
  it("joins the running engine instead of starting or displacing one", async () => {
    const { first, second } = await twoSurfaces();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.disposed).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.ready).not.toBe(null);
    // Each surface gets its OWN attachment, which is what makes detach precise.
    expect(second.attachmentId).not.toBe(first.attachmentId);
  });

  it("replays both the engine's events and the prompts it never echoed", async () => {
    const service = new AssistantHostService();
    await service.start({ projectId: PROJECT, cwd: CWD, windowId: 1, webContentsId: 10 });
    const host = hosts[0];
    host?.emit({ type: "turn:start", sessionId: host.sessionId, seq: 2, turnId: "t1" });
    service.send({ type: "prompt", sessionId: host?.sessionId ?? "", text: "hello" }, 10);

    const joined = await service.start({
      projectId: PROJECT,
      cwd: CWD,
      windowId: 2,
      webContentsId: 11,
    });

    expect(joined.replay).toHaveLength(1);
    // Without this the joiner shows answers to questions it never displays.
    expect(joined.replayPrompts.map((p) => p.text)).toEqual(["hello"]);
  });

  it("delivers later engine events to every surface", async () => {
    await twoSurfaces();
    const host = hosts[0];
    host?.emit({ type: "turn:start", sessionId: host.sessionId, seq: 2, turnId: "t1" });
    expect(deliveriesTo(10)).toHaveLength(1);
    expect(deliveriesTo(11)).toHaveLength(1);
  });

  it("mirrors a prompt to the other surfaces but not back to the sender", async () => {
    const { service, first } = await twoSurfaces();
    service.send({ type: "prompt", sessionId: first.sessionId, text: "hello" }, 10);

    expect(peerPromptsTo(11)).toHaveLength(1);
    expect(peerPromptsTo(11)[0]?.payload).toMatchObject({ text: "hello" });
    // The sender already appended it locally; mirroring it back would double the turn.
    expect(peerPromptsTo(10)).toHaveLength(0);
  });

  it("keeps the engine alive when a JOINING surface leaves, and stops it at the last", async () => {
    const { service, first } = await twoSurfaces();

    // Surface 11 joined; its departure is not the control plane's departure.
    service.stopByWebContents(11);
    expect(hosts[0]?.disposed).toBe(false);
    expect(service.isOwnedBy(first.sessionId, 10)).toBe(true);
    expect(service.isOwnedBy(first.sessionId, 11)).toBe(false);

    service.stopByWebContents(10);
    expect(hosts[0]?.disposed).toBe(true);
  });

  it("ends the session when the surface holding the control plane leaves", async () => {
    const { service } = await twoSurfaces();

    // The MCP bearer is pinned to surface 10's view at handshake, and the MCP layer
    // never re-points it (#7003/#9887). Once that view is gone every tool call would
    // target a destroyed target — so the others are not left with an assistant that
    // answers and cannot act. They get an ordinary exit instead.
    service.stopByWebContents(10);
    expect(hosts[0]?.disposed).toBe(true);
  });

  it("ignores a stale detach that names a superseded attachment", async () => {
    const service = new AssistantHostService();
    const first = await service.start({
      projectId: PROJECT,
      cwd: CWD,
      windowId: 1,
      webContentsId: 10,
    });
    // The same surface re-attaches (a view re-running its start effect) BEFORE the
    // previous attach's teardown runs.
    const again = await service.start({
      projectId: PROJECT,
      cwd: CWD,
      windowId: 1,
      webContentsId: 10,
    });
    expect(again.attachmentId).not.toBe(first.attachmentId);

    service.detachSession(again.sessionId, 10, first.attachmentId);

    // The live attachment survives; the engine is not stopped out from under it.
    expect(service.isOwnedBy(again.sessionId, 10)).toBe(true);
    expect(hosts[0]?.disposed).toBe(false);
  });

  it("closing a window that only JOINED leaves the engine running", async () => {
    const { service } = await twoSurfaces();
    service.stopByWindow(2);
    expect(hosts[0]?.disposed).toBe(false);
    service.stopByWindow(1);
    expect(hosts[0]?.disposed).toBe(true);
  });

  it("does not register a surface that went away while its start was queued", async () => {
    const service = new AssistantHostService();
    // Both starts are in flight; the second is queued behind the first, because the
    // queue serializes per project. THIS is the window in which the race lives.
    const firstPending = service.start({
      projectId: PROJECT,
      cwd: CWD,
      windowId: 1,
      webContentsId: 10,
    });
    const secondPending = service.start({
      projectId: PROJECT,
      cwd: CWD,
      windowId: 2,
      webContentsId: 11,
    });
    // The second surface is destroyed while its own start is still queued, so the
    // teardown that would have removed it runs before it was ever registered.
    service.stopByWebContents(11);

    const first = await firstPending;
    await expect(secondPending).rejects.toThrow(/closed before/i);

    // A subscriber left behind here would hold the engine — and the project's lease —
    // open forever, because a quiet engine delivers nothing to reap it lazily.
    expect(service.isOwnedBy(first.sessionId, 11)).toBe(false);
    service.stopByWebContents(10);
    expect(hosts[0]?.disposed).toBe(true);
  });

  it("detaches a destroyed JOINING surface rather than ending the session", async () => {
    const { service, first } = await twoSurfaces();
    destroyed.add(11);
    const host = hosts[0];
    host?.emit({ type: "turn:start", sessionId: host.sessionId, seq: 2, turnId: "t1" });

    expect(service.isOwnedBy(first.sessionId, 11)).toBe(false);
    expect(deliveriesTo(10)).toHaveLength(1);
    expect(hosts[0]?.disposed).toBe(false);
  });

  it("starts a separate engine for a different project", async () => {
    const service = new AssistantHostService();
    await service.start({ projectId: PROJECT, cwd: CWD, windowId: 1, webContentsId: 10 });
    await service.start({ projectId: "p2", cwd: "/tmp/other", windowId: 1, webContentsId: 11 });
    expect(hosts).toHaveLength(2);
    expect(hosts.every((h) => !h.disposed)).toBe(true);
  });
});
