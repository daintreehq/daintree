import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { PtyClient } from "../PtyClient.js";
import type { DevPreviewStatus } from "../DevPreviewService.js";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

import { existsSync } from "fs";
import { readFile } from "fs/promises";

interface MockPtyClient extends EventEmitter {
  spawn: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  hasTerminal: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

function createMockPtyClient(): MockPtyClient {
  const emitter = new EventEmitter() as MockPtyClient;
  emitter.spawn = vi.fn();
  emitter.submit = vi.fn();
  emitter.kill = vi.fn().mockResolvedValue(undefined);
  emitter.hasTerminal = vi.fn().mockReturnValue(true);
  emitter.write = vi.fn();
  emitter.resize = vi.fn();
  emitter.dispose = vi.fn();
  return emitter;
}

describe("DevPreviewService", () => {
  let mockPtyClient: MockPtyClient;
  let DevPreviewServiceClass: typeof import("../DevPreviewService.js").DevPreviewService;

  beforeEach(async () => {
    vi.resetModules();
    mockPtyClient = createMockPtyClient();

    // Default: no package.json
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFile).mockRejectedValue(new Error("File not found"));

    const module = await import("../DevPreviewService.js");
    DevPreviewServiceClass = module.DevPreviewService;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("start()", () => {
    it("creates a browser-only session when no dev command is available", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      const statusEvents: { status: DevPreviewStatus; message: string }[] = [];
      service.on("status", (e) => statusEvents.push(e));

      await service.start({
        panelId: "panel-1",
        cwd: "/test/project",
        cols: 80,
        rows: 24,
      });

      const session = service.getSession("panel-1");
      expect(session).toBeDefined();
      expect(session?.status).toBe("running");
      expect(session?.statusMessage).toBe("Browser-only mode (no dev command)");
      expect(session?.ptyId).toBe("");
      expect(mockPtyClient.spawn).not.toHaveBeenCalled();

      expect(statusEvents.length).toBe(1);
      expect(statusEvents[0].status).toBe("running");
    });

    it("creates session with auto-detected npm dev command", async () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const pathStr = String(p);
        if (pathStr.includes("package.json")) return true;
        if (pathStr.includes("node_modules")) return true;
        return false;
      });

      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          scripts: { dev: "vite" },
        })
      );

      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      const statusEvents: { status: DevPreviewStatus; message: string }[] = [];
      service.on("status", (e) => statusEvents.push(e));

      await service.start({
        panelId: "panel-2",
        cwd: "/test/npm-project",
        cols: 80,
        rows: 24,
      });

      expect(mockPtyClient.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          cwd: "/test/npm-project",
          cols: 80,
          rows: 24,
          kind: "dev-preview",
        })
      );

      const session = service.getSession("panel-2");
      expect(session?.status).toBe("starting");
      expect(session?.devCommand).toBe("npm run dev");
      expect(session?.packageManager).toBe("npm");
    });

    it("creates session with pnpm when pnpm-lock.yaml exists", async () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const pathStr = String(p);
        if (pathStr.includes("package.json")) return true;
        if (pathStr.includes("pnpm-lock.yaml")) return true;
        if (pathStr.includes("node_modules")) return true;
        return false;
      });

      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          scripts: { dev: "vite" },
        })
      );

      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await service.start({
        panelId: "panel-3",
        cwd: "/test/pnpm-project",
        cols: 80,
        rows: 24,
      });

      const session = service.getSession("panel-3");
      expect(session?.devCommand).toBe("pnpm run dev");
      expect(session?.packageManager).toBe("pnpm");
    });

    it("creates session with yarn when yarn.lock exists", async () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const pathStr = String(p);
        if (pathStr.includes("package.json")) return true;
        if (pathStr.includes("yarn.lock")) return true;
        if (pathStr.includes("node_modules")) return true;
        return false;
      });

      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          scripts: { dev: "vite" },
        })
      );

      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await service.start({
        panelId: "panel-4",
        cwd: "/test/yarn-project",
        cols: 80,
        rows: 24,
      });

      const session = service.getSession("panel-4");
      expect(session?.devCommand).toBe("yarn dev");
      expect(session?.packageManager).toBe("yarn");
    });

    it("creates session with bun when bun.lockb exists", async () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const pathStr = String(p);
        if (pathStr.includes("package.json")) return true;
        if (pathStr.includes("bun.lockb")) return true;
        if (pathStr.includes("node_modules")) return true;
        return false;
      });

      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          scripts: { dev: "vite" },
        })
      );

      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await service.start({
        panelId: "panel-5",
        cwd: "/test/bun-project",
        cols: 80,
        rows: 24,
      });

      const session = service.getSession("panel-5");
      expect(session?.devCommand).toBe("bun run dev");
      expect(session?.packageManager).toBe("bun");
    });

    it("uses start script when dev script is not available", async () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const pathStr = String(p);
        if (pathStr.includes("package.json")) return true;
        if (pathStr.includes("node_modules")) return true;
        return false;
      });

      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          scripts: { start: "node server.js" },
        })
      );

      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await service.start({
        panelId: "panel-6",
        cwd: "/test/start-only",
        cols: 80,
        rows: 24,
      });

      const session = service.getSession("panel-6");
      expect(session?.devCommand).toBe("npm run start");
    });

    it("uses provided devCommand instead of auto-detection", async () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const pathStr = String(p);
        if (pathStr.includes("package.json")) return true;
        if (pathStr.includes("node_modules")) return true;
        return false;
      });

      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          scripts: { dev: "vite" },
        })
      );

      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await service.start({
        panelId: "panel-7",
        cwd: "/test/custom-cmd",
        cols: 80,
        rows: 24,
        devCommand: "custom-server --watch",
      });

      const session = service.getSession("panel-7");
      expect(session?.devCommand).toBe("custom-server --watch");
    });

    it("runs install command when node_modules is missing", async () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const pathStr = String(p);
        if (pathStr.includes("package.json")) return true;
        if (pathStr.includes("node_modules")) return false;
        return false;
      });

      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          scripts: { dev: "vite" },
        })
      );

      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      const statusEvents: { status: DevPreviewStatus; message: string }[] = [];
      service.on("status", (e) => statusEvents.push(e));

      await service.start({
        panelId: "panel-8",
        cwd: "/test/needs-install",
        cols: 80,
        rows: 24,
      });

      const session = service.getSession("panel-8");
      expect(session?.status).toBe("installing");
      expect(session?.installCommand).toBe("npm install");

      expect(statusEvents[0].status).toBe("installing");
      expect(statusEvents[0].message).toBe("Installing dependencies...");
    });

    it("stops existing session before starting new one on same panel", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      
      await service.start({
        panelId: "panel-1",
        cwd: "/tmp/test",
        cols: 80,
        rows: 24,
        devCommand: "npm run dev",
      });

      const firstSession = service.getSession("panel-1");
      const firstPtyId = firstSession!.ptyId;

      await service.start({
        panelId: "panel-1",
        cwd: "/tmp/test2",
        cols: 80,
        rows: 24,
        devCommand: "npm start",
      });

      expect(mockPtyClient.kill).toHaveBeenCalledWith(firstPtyId);
      const secondSession = service.getSession("panel-1");
      expect(secondSession!.ptyId).not.toBe(firstPtyId);
    });
  });

  describe("stop()", () => {
    it("stops an existing session and removes it", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await service.start({
        panelId: "panel-stop-test",
        cwd: "/test",
        cols: 80,
        rows: 24,
      });

      expect(service.getSession("panel-stop-test")).toBeDefined();

      await service.stop("panel-stop-test");

      expect(service.getSession("panel-stop-test")).toBeUndefined();
    });

    it("is a no-op for non-existent session", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      // Should not throw
      await expect(service.stop("non-existent")).resolves.toBeUndefined();
      expect(mockPtyClient.kill).not.toHaveBeenCalled();
    });

    it("kills the PTY process when stopping", async () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const pathStr = String(p);
        if (pathStr.includes("package.json")) return true;
        if (pathStr.includes("node_modules")) return true;
        return false;
      });

      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          scripts: { dev: "vite" },
        })
      );

      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await service.start({
        panelId: "panel-kill-test",
        cwd: "/test",
        cols: 80,
        rows: 24,
      });

      const session = service.getSession("panel-kill-test");
      const ptyId = session?.ptyId;

      await service.stop("panel-kill-test");

      expect(mockPtyClient.kill).toHaveBeenCalledWith(ptyId);
    });

    it("emits stopped status when stopping", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      const statusEvents: { status: DevPreviewStatus; panelId: string }[] = [];
      service.on("status", (e) => statusEvents.push(e));

      await service.start({
        panelId: "panel-stop-status",
        cwd: "/test",
        cols: 80,
        rows: 24,
      });

      await service.stop("panel-stop-status");

      const stoppedEvent = statusEvents.find((e) => e.status === "stopped");
      expect(stoppedEvent).toBeDefined();
      expect(stoppedEvent?.panelId).toBe("panel-stop-status");
    });
  });

  describe("restart()", () => {
    it("stops existing session and starts a new one", async () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const pathStr = String(p);
        if (pathStr.includes("package.json")) return true;
        if (pathStr.includes("node_modules")) return true;
        return false;
      });

      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          scripts: { dev: "vite" },
        })
      );

      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await service.start({
        panelId: "panel-restart",
        cwd: "/test/project",
        cols: 80,
        rows: 24,
      });

      const originalSession = service.getSession("panel-restart");
      const originalPtyId = originalSession?.ptyId;

      await service.restart("panel-restart");

      expect(mockPtyClient.kill).toHaveBeenCalledWith(originalPtyId);

      const newSession = service.getSession("panel-restart");
      expect(newSession).toBeDefined();
      expect(newSession?.ptyId).not.toBe(originalPtyId);
    });

    it("is a no-op for non-existent session", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await expect(service.restart("non-existent")).resolves.toBeUndefined();
      expect(mockPtyClient.spawn).not.toHaveBeenCalled();
    });

    it("preserves the original devCommand on restart", async () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const pathStr = String(p);
        if (pathStr.includes("package.json")) return true;
        if (pathStr.includes("node_modules")) return true;
        return false;
      });

      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          scripts: { dev: "vite" },
        })
      );

      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await service.start({
        panelId: "panel-preserve-cmd",
        cwd: "/test",
        cols: 80,
        rows: 24,
        devCommand: "custom-server",
      });

      expect(service.getSession("panel-preserve-cmd")?.devCommand).toBe("custom-server");

      await service.restart("panel-preserve-cmd");

      expect(service.getSession("panel-preserve-cmd")?.devCommand).toBe("custom-server");
    });
  });

  describe("setUrl()", () => {
    it("updates session URL and emits events", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      const urlEvents: { panelId: string; url: string }[] = [];
      service.on("url", (e) => urlEvents.push(e));

      await service.start({
        panelId: "panel-url",
        cwd: "/test",
        cols: 80,
        rows: 24,
      });

      service.setUrl("panel-url", "http://localhost:3000");

      const session = service.getSession("panel-url");
      expect(session?.url).toBe("http://localhost:3000");
      expect(session?.status).toBe("running");

      expect(urlEvents.length).toBe(1);
      expect(urlEvents[0].url).toBe("http://localhost:3000");
    });
  });

  describe("PTY data handling", () => {
    it("extracts localhost URLs from PTY output", async () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const pathStr = String(p);
        if (pathStr.includes("package.json")) return true;
        if (pathStr.includes("node_modules")) return true;
        return false;
      });

      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          scripts: { dev: "vite" },
        })
      );

      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      const urlEvents: { panelId: string; url: string }[] = [];
      service.on("url", (e) => urlEvents.push(e));

      await service.start({
        panelId: "panel-url-extract",
        cwd: "/test",
        cols: 80,
        rows: 24,
      });

      const session = service.getSession("panel-url-extract");
      const ptyId = session?.ptyId;

      // Simulate PTY data with URL
      mockPtyClient.emit("data", ptyId, "Server started at http://localhost:5173/\n");

      expect(urlEvents.length).toBe(1);
      expect(urlEvents[0].url).toBe("http://localhost:5173/");
    });
  });

  describe("session isolation", () => {
    it("maintains separate sessions for different panels", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      
      await service.start({
        panelId: "panel-1",
        cwd: "/tmp/project1",
        cols: 80,
        rows: 24,
        devCommand: "npm run dev",
      });

      await service.start({
        panelId: "panel-2",
        cwd: "/tmp/project2",
        cols: 80,
        rows: 24,
        devCommand: "yarn start",
      });

      const session1 = service.getSession("panel-1");
      const session2 = service.getSession("panel-2");

      expect(session1).toBeDefined();
      expect(session2).toBeDefined();
      expect(session1!.ptyId).not.toBe(session2!.ptyId);
    });
  });
});