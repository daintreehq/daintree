import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * A project's engine belongs to the surface that started it.
 *
 * Opening the same project in a second window used to displace the running engine,
 * which silently tore down the conversation the first window was showing. Two engines
 * is not an option either — the engine holds an exclusive flock lease on the project's
 * state, so a sibling queues behind it and times out. Until surfaces can genuinely
 * share one engine (prompt mirroring + per-surface control-plane routing), the second
 * surface is refused in words and the first keeps its conversation.
 */

interface FakeHost {
  sessionId: string;
  disposed: boolean;
}
const hosts: FakeHost[] = [];

vi.mock("../AssistantHostProcess.js", () => ({
  AssistantHostProcess: class {
    private readonly record: FakeHost;
    constructor(opts: { descriptor: { sessionId: string } }) {
      this.record = { sessionId: opts.descriptor.sessionId, disposed: false };
      hosts.push(this.record);
    }
    start() {}
    waitForReady() {
      return Promise.resolve();
    }
    getReadyEvent() {
      return null;
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

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/daintree-second-surface-test", isPackaged: false },
  webContents: { fromId: () => undefined },
}));

vi.mock("../../../ipc/handlers/helpAssistant.js", () => ({
  getHelpAssistantSettings: () => ({ tier: "action" }),
}));

vi.mock("../../HelpSessionService.js", () => ({
  helpSessionService: {
    provisionSession: () =>
      Promise.resolve({
        sessionId: "help_1",
        sessionPath: "/tmp/daintree-second-surface-test/help_1",
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

beforeEach(() => {
  hosts.length = 0;
});

describe("a second surface opening a project that already has an engine", () => {
  it("is refused, and the first window keeps its engine", async () => {
    const service = new AssistantHostService();
    const first = await service.start({
      projectId: PROJECT,
      cwd: CWD,
      windowId: 1,
      webContentsId: 10,
    });

    await expect(
      service.start({ projectId: PROJECT, cwd: CWD, windowId: 2, webContentsId: 11 })
    ).rejects.toThrow(/already open in another window/i);

    // The decisive assertion: the first window's engine was NOT torn down.
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.disposed).toBe(false);
    expect(service.isOwnedBy(first.sessionId, 10)).toBe(true);
  });

  it("lets the SAME surface restart its own engine", async () => {
    const service = new AssistantHostService();
    await service.start({ projectId: PROJECT, cwd: CWD, windowId: 1, webContentsId: 10 });

    // A view re-running its start effect, or switching projects, must be able to
    // replace the engine it owns — that is not the displacement this guards against.
    const second = await service.start({
      projectId: PROJECT,
      cwd: CWD,
      windowId: 1,
      webContentsId: 10,
    });

    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.disposed).toBe(true);
    expect(service.isOwnedBy(second.sessionId, 10)).toBe(true);
  });

  it("frees the project once the holding surface goes away", async () => {
    const service = new AssistantHostService();
    await service.start({ projectId: PROJECT, cwd: CWD, windowId: 1, webContentsId: 10 });

    service.stopByWebContents(10);

    // The refusal is about a LIVE holder, not a permanent claim on the project.
    const afterRelease = await service.start({
      projectId: PROJECT,
      cwd: CWD,
      windowId: 2,
      webContentsId: 11,
    });
    expect(service.isOwnedBy(afterRelease.sessionId, 11)).toBe(true);
  });

  it("does not refuse a different project in another window", async () => {
    const service = new AssistantHostService();
    await service.start({ projectId: PROJECT, cwd: CWD, windowId: 1, webContentsId: 10 });
    await service.start({ projectId: "p2", cwd: "/tmp/other", windowId: 2, webContentsId: 11 });

    expect(hosts).toHaveLength(2);
    expect(hosts.every((h) => !h.disposed)).toBe(true);
  });
});
