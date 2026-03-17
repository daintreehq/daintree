import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { GlobalTerminalScannerService } from "../GlobalTerminalScannerService.js";
import type { DetectedDevServer } from "../../../shared/types/ipc/globalDevServers.js";
import type { PtyClient } from "../PtyClient.js";

function createMockPtyClient() {
  const emitter = new EventEmitter();
  const mock = Object.assign(emitter, {
    getAllTerminalsAsync: vi.fn().mockResolvedValue([]),
    getTerminalAsync: vi.fn().mockResolvedValue(null),
    setIpcDataMirror: vi.fn(),
  });
  return mock;
}

type MockPtyClient = ReturnType<typeof createMockPtyClient>;

describe("GlobalTerminalScannerService", () => {
  let ptyClient: MockPtyClient;
  let service: GlobalTerminalScannerService;
  let onChangedSpy: ReturnType<typeof vi.fn<(servers: DetectedDevServer[]) => void>>;

  beforeEach(() => {
    ptyClient = createMockPtyClient();
    onChangedSpy = vi.fn<(servers: DetectedDevServer[]) => void>();
  });

  function createService() {
    service = new GlobalTerminalScannerService(ptyClient as unknown as PtyClient);
    service.onChanged(onChangedSpy);
    return service;
  }

  it("init sweep registers non-dev-preview terminals with hasPty", async () => {
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      { id: "t1", hasPty: true, kind: "terminal", cwd: "/", spawnedAt: 1 },
      { id: "t2", hasPty: true, kind: "dev-preview", cwd: "/", spawnedAt: 2 },
      { id: "t3", hasPty: false, kind: "terminal", cwd: "/", spawnedAt: 3 },
      { id: "t4", hasPty: true, kind: "agent", cwd: "/", spawnedAt: 4 },
    ]);

    createService();
    await vi.waitFor(() => {
      expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t1", true);
    });

    expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t4", true);
    expect(ptyClient.setIpcDataMirror).not.toHaveBeenCalledWith("t2", true);
    expect(ptyClient.setIpcDataMirror).not.toHaveBeenCalledWith("t3", true);
  });

  it("skips dev-preview terminals on spawn-result", async () => {
    createService();
    await vi.waitFor(() => expect(ptyClient.getAllTerminalsAsync).toHaveBeenCalled());

    ptyClient.getTerminalAsync.mockResolvedValue({
      id: "t5",
      kind: "dev-preview",
      hasPty: true,
      cwd: "/",
      spawnedAt: 5,
    });

    ptyClient.emit("spawn-result", "t5", { success: true });
    await vi.waitFor(() => expect(ptyClient.getTerminalAsync).toHaveBeenCalledWith("t5"));

    expect(ptyClient.setIpcDataMirror).not.toHaveBeenCalledWith("t5", true);
  });

  it("tracks new non-dev-preview terminals on spawn-result", async () => {
    createService();
    await vi.waitFor(() => expect(ptyClient.getAllTerminalsAsync).toHaveBeenCalled());

    ptyClient.getTerminalAsync.mockResolvedValue({
      id: "t6",
      kind: "terminal",
      hasPty: true,
      cwd: "/",
      worktreeId: "wt1",
      title: "My Terminal",
      spawnedAt: 6,
    });

    ptyClient.emit("spawn-result", "t6", { success: true });
    await vi.waitFor(() => expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t6", true));
  });

  it("detects URL from terminal data and disables mirror", async () => {
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      {
        id: "t1",
        hasPty: true,
        kind: "terminal",
        cwd: "/",
        worktreeId: "wt1",
        title: "Dev",
        spawnedAt: 1,
      },
    ]);

    createService();
    await vi.waitFor(() => expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t1", true));

    ptyClient.emit("data", "t1", "Server running at http://localhost:3000\n");

    expect(onChangedSpy).toHaveBeenCalledTimes(1);
    const servers = onChangedSpy.mock.calls[0][0];
    expect(servers).toHaveLength(1);
    expect(servers[0].url).toBe("http://localhost:3000/");
    expect(servers[0].port).toBe(3000);
    expect(servers[0].terminalId).toBe("t1");
    expect(servers[0].worktreeId).toBe("wt1");
    expect(servers[0].terminalTitle).toBe("Dev");

    expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t1", false);
  });

  it("deduplicates by port - replaces older entry", async () => {
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      { id: "t1", hasPty: true, kind: "terminal", cwd: "/", spawnedAt: 1 },
      { id: "t2", hasPty: true, kind: "terminal", cwd: "/", spawnedAt: 2 },
    ]);

    createService();
    await vi.waitFor(() => expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t2", true));

    ptyClient.emit("data", "t1", "http://localhost:3000\n");
    ptyClient.emit("data", "t2", "http://localhost:3000\n");

    const servers = service.getAll();
    expect(servers).toHaveLength(1);
    expect(servers[0].terminalId).toBe("t2");
  });

  it("removes entry and emits change on terminal exit", async () => {
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      { id: "t1", hasPty: true, kind: "terminal", cwd: "/", spawnedAt: 1 },
    ]);

    createService();
    await vi.waitFor(() => expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t1", true));

    ptyClient.emit("data", "t1", "http://localhost:4000\n");
    onChangedSpy.mockClear();

    ptyClient.emit("exit", "t1", 0);

    expect(onChangedSpy).toHaveBeenCalledTimes(1);
    expect(service.getAll()).toHaveLength(0);
  });

  it("does not emit on exit if terminal had no detected URL", async () => {
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      { id: "t1", hasPty: true, kind: "terminal", cwd: "/", spawnedAt: 1 },
    ]);

    createService();
    await vi.waitFor(() => expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t1", true));

    ptyClient.emit("exit", "t1", 0);

    expect(onChangedSpy).not.toHaveBeenCalled();
  });

  it("handles Uint8Array data", async () => {
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      { id: "t1", hasPty: true, kind: "terminal", cwd: "/", spawnedAt: 1 },
    ]);

    createService();
    await vi.waitFor(() => expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t1", true));

    const encoder = new TextEncoder();
    ptyClient.emit("data", "t1", encoder.encode("http://localhost:5000\n"));

    expect(onChangedSpy).toHaveBeenCalledTimes(1);
    expect(service.getAll()[0].port).toBe(5000);
  });

  it("dispose clears all state and removes listeners", async () => {
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      { id: "t1", hasPty: true, kind: "terminal", cwd: "/", spawnedAt: 1 },
    ]);

    createService();
    await vi.waitFor(() => expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t1", true));

    ptyClient.emit("data", "t1", "http://localhost:3000\n");
    ptyClient.setIpcDataMirror.mockClear();

    service.dispose();

    expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t1", false);
    expect(service.getAll()).toHaveLength(0);
    expect(ptyClient.listenerCount("data")).toBe(0);
    expect(ptyClient.listenerCount("exit")).toBe(0);
    expect(ptyClient.listenerCount("spawn-result")).toBe(0);
  });

  it("ignores data for already-found URLs", async () => {
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      { id: "t1", hasPty: true, kind: "terminal", cwd: "/", spawnedAt: 1 },
    ]);

    createService();
    await vi.waitFor(() => expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t1", true));

    ptyClient.emit("data", "t1", "http://localhost:3000\n");
    onChangedSpy.mockClear();

    ptyClient.emit("data", "t1", "http://localhost:4000\n");
    expect(onChangedSpy).not.toHaveBeenCalled();
  });

  it("getAll returns servers sorted by detectedAt", async () => {
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      { id: "t1", hasPty: true, kind: "terminal", cwd: "/", spawnedAt: 1 },
      { id: "t2", hasPty: true, kind: "terminal", cwd: "/", spawnedAt: 2 },
    ]);

    createService();
    await vi.waitFor(() => expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t2", true));

    ptyClient.emit("data", "t2", "http://localhost:4000\n");
    ptyClient.emit("data", "t1", "http://localhost:3000\n");

    const servers = service.getAll();
    expect(servers).toHaveLength(2);
    expect(servers[0].port).toBe(4000);
    expect(servers[1].port).toBe(3000);
  });

  it("skips spawn-result with success: false", async () => {
    createService();
    await vi.waitFor(() => expect(ptyClient.getAllTerminalsAsync).toHaveBeenCalled());

    ptyClient.emit("spawn-result", "t9", { success: false });

    await new Promise((r) => setTimeout(r, 10));
    expect(ptyClient.getTerminalAsync).not.toHaveBeenCalled();
    expect(ptyClient.setIpcDataMirror).not.toHaveBeenCalledWith("t9", true);
  });

  it("tracks terminals with kind: undefined (non-dev-preview)", async () => {
    createService();
    await vi.waitFor(() => expect(ptyClient.getAllTerminalsAsync).toHaveBeenCalled());

    ptyClient.getTerminalAsync.mockResolvedValue({
      id: "t10",
      kind: undefined,
      hasPty: true,
      cwd: "/",
      spawnedAt: 10,
    });

    ptyClient.emit("spawn-result", "t10", { success: true });
    await vi.waitFor(() => expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t10", true));
  });

  it("skips spawn-result when getTerminalAsync returns hasPty: false", async () => {
    createService();
    await vi.waitFor(() => expect(ptyClient.getAllTerminalsAsync).toHaveBeenCalled());

    ptyClient.getTerminalAsync.mockResolvedValue({
      id: "t11",
      kind: "terminal",
      hasPty: false,
      cwd: "/",
      spawnedAt: 11,
    });

    ptyClient.emit("spawn-result", "t11", { success: true });
    await vi.waitFor(() => expect(ptyClient.getTerminalAsync).toHaveBeenCalledWith("t11"));

    expect(ptyClient.setIpcDataMirror).not.toHaveBeenCalledWith("t11", true);
  });

  it("handles terminal exit then respawn with same ID", async () => {
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      { id: "t1", hasPty: true, kind: "terminal", cwd: "/", spawnedAt: 1 },
    ]);

    createService();
    await vi.waitFor(() => expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("t1", true));

    ptyClient.emit("data", "t1", "http://localhost:3000\n");
    ptyClient.emit("exit", "t1", 0);

    expect(service.getAll()).toHaveLength(0);

    ptyClient.getTerminalAsync.mockResolvedValue({
      id: "t1",
      kind: "terminal",
      hasPty: true,
      cwd: "/",
      spawnedAt: 100,
    });

    ptyClient.emit("spawn-result", "t1", { success: true });
    await vi.waitFor(() => expect(ptyClient.setIpcDataMirror).toHaveBeenLastCalledWith("t1", true));

    ptyClient.emit("data", "t1", "http://localhost:5000\n");
    expect(service.getAll()).toHaveLength(1);
    expect(service.getAll()[0].port).toBe(5000);
  });
});
