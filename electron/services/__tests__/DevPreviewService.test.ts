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
  setIpcDataMirror: ReturnType<typeof vi.fn>;
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
  emitter.setIpcDataMirror = vi.fn();
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

  describe("attach()", () => {
    it("creates a browser-only session when no dev command is available", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      const statusEvents: { status: DevPreviewStatus; message: string }[] = [];
      service.on("status", (e) => statusEvents.push(e));

      await service.attach({
        panelId: "panel-1",
        ptyId: "pty-1",
        cwd: "/test/project",
      });

      const session = service.getSession("panel-1");
      expect(session).toBeDefined();
      expect(session?.status).toBe("running");
      expect(session?.statusMessage).toBe("Browser-only mode (no dev command)");
      expect(session?.ptyId).toBe("pty-1");
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

      await service.attach({
        panelId: "panel-2",
        ptyId: "pty-2",
        cwd: "/test/npm-project",
      });

      // Should NOT spawn - attach subscribes to existing PTY
      expect(mockPtyClient.spawn).not.toHaveBeenCalled();

      const session = service.getSession("panel-2");
      expect(session?.status).toBe("starting");
      expect(session?.devCommand).toBe("npm run dev");
      expect(session?.packageManager).toBe("npm");
      expect(session?.ptyId).toBe("pty-2");
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

      await service.attach({
        panelId: "panel-3",
        ptyId: "pty-3",
        cwd: "/test/pnpm-project",
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

      await service.attach({
        panelId: "panel-4",
        ptyId: "pty-4",
        cwd: "/test/yarn-project",
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

      await service.attach({
        panelId: "panel-5",
        ptyId: "pty-5",
        cwd: "/test/bun-project",
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

      await service.attach({
        panelId: "panel-6",
        ptyId: "pty-6",
        cwd: "/test/start-only",
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

      await service.attach({
        panelId: "panel-7",
        ptyId: "pty-7",
        cwd: "/test/custom-cmd",
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

      await service.attach({
        panelId: "panel-8",
        ptyId: "pty-8",
        cwd: "/test/needs-install",
      });

      const session = service.getSession("panel-8");
      expect(session?.status).toBe("installing");
      expect(session?.installCommand).toBe("npm install");

      expect(statusEvents[0].status).toBe("installing");
      expect(statusEvents[0].message).toBe("Installing dependencies...");
    });

    it("reuses existing session when reattaching with same config", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await service.attach({
        panelId: "panel-1",
        ptyId: "pty-1",
        cwd: "/tmp/test",
        devCommand: "npm run dev",
      });

      const firstSession = service.getSession("panel-1");
      const firstPtyId = firstSession!.ptyId;

      await service.attach({
        panelId: "panel-1",
        ptyId: "pty-1",
        cwd: "/tmp/test",
        devCommand: "npm run dev",
      });

      const secondSession = service.getSession("panel-1");
      expect(secondSession!.ptyId).toBe(firstPtyId);
    });

    it("detaches and reattaches when cwd changes for the same panel", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await service.attach({
        panelId: "panel-1",
        ptyId: "pty-1",
        cwd: "/tmp/test",
        devCommand: "npm run dev",
      });

      const firstSession = service.getSession("panel-1");
      expect(firstSession).toBeDefined();

      await service.attach({
        panelId: "panel-1",
        ptyId: "pty-2",
        cwd: "/tmp/test2",
        devCommand: "npm run dev",
      });

      // PTY kill is NOT called - detach just removes listeners
      expect(mockPtyClient.kill).not.toHaveBeenCalled();
      const secondSession = service.getSession("panel-1");
      expect(secondSession!.ptyId).toBe("pty-2");
    });
  });

  describe("detach()", () => {
    it("detaches an existing session and removes it", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await service.attach({
        panelId: "panel-detach-test",
        ptyId: "pty-detach",
        cwd: "/test",
      });

      expect(service.getSession("panel-detach-test")).toBeDefined();

      service.detach("panel-detach-test");

      expect(service.getSession("panel-detach-test")).toBeUndefined();
    });

    it("is a no-op for non-existent session", () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      // Should not throw
      service.detach("non-existent");
      expect(mockPtyClient.kill).not.toHaveBeenCalled();
    });

    it("does NOT kill the PTY process when detaching", async () => {
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

      await service.attach({
        panelId: "panel-kill-test",
        ptyId: "pty-kill",
        cwd: "/test",
      });

      service.detach("panel-kill-test");

      // Detach should NOT kill the PTY - the standard terminal pipeline owns it
      expect(mockPtyClient.kill).not.toHaveBeenCalled();
    });
  });

  describe("setUrl()", () => {
    it("updates session URL and emits events", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      const urlEvents: { panelId: string; url: string }[] = [];
      service.on("url", (e) => urlEvents.push(e));

      await service.attach({
        panelId: "panel-url",
        ptyId: "pty-url",
        cwd: "/test",
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

      await service.attach({
        panelId: "panel-url-extract",
        ptyId: "pty-url-extract",
        cwd: "/test",
      });

      // Simulate PTY data with URL
      mockPtyClient.emit("data", "pty-url-extract", "Server started at http://localhost:5173/\n");

      expect(urlEvents.length).toBe(1);
      expect(urlEvents[0].url).toBe("http://localhost:5173/");
    });
  });

  describe("session isolation", () => {
    it("maintains separate sessions for different panels", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);

      await service.attach({
        panelId: "panel-1",
        ptyId: "pty-1",
        cwd: "/tmp/project1",
        devCommand: "npm run dev",
      });

      await service.attach({
        panelId: "panel-2",
        ptyId: "pty-2",
        cwd: "/tmp/project2",
        devCommand: "yarn start",
      });

      const session1 = service.getSession("panel-1");
      const session2 = service.getSession("panel-2");

      expect(session1).toBeDefined();
      expect(session2).toBeDefined();
      expect(session1!.ptyId).not.toBe(session2!.ptyId);
    });
  });

  describe("error detection and recovery", () => {
    beforeEach(() => {
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
    });

    it("detects port conflict error and emits error status", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      const statusEvents: { status: DevPreviewStatus; message: string }[] = [];
      service.on("status", (e) => statusEvents.push(e));

      await service.attach({
        panelId: "panel-port-conflict",
        ptyId: "pty-port",
        cwd: "/test/project",
      });

      // Simulate PTY data with port conflict error
      mockPtyClient.emit(
        "data",
        "pty-port",
        "Error: listen EADDRINUSE: address already in use :::3000\n"
      );

      const errorEvent = statusEvents.find((e) => e.status === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.message).toContain("Port 3000 is already in use");
    });

    it("detects missing module error and emits recovery event", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      const statusEvents: { status: DevPreviewStatus; message: string }[] = [];
      const recoveryEvents: { panelId: string; command: string; attempt: number }[] = [];
      service.on("status", (e) => statusEvents.push(e));
      service.on("recovery", (e) => recoveryEvents.push(e));

      await service.attach({
        panelId: "panel-missing-deps",
        ptyId: "pty-missing",
        cwd: "/test/project",
      });

      // Simulate PTY data with missing module error
      mockPtyClient.emit("data", "pty-missing", "Error: Cannot find module 'vite'\n");

      // Wait for async recovery
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have killed the PTY for recovery
      expect(mockPtyClient.kill).toHaveBeenCalledWith("pty-missing");

      // Should emit recovery event instead of spawning
      expect(recoveryEvents.length).toBe(1);
      expect(recoveryEvents[0].panelId).toBe("panel-missing-deps");
      expect(recoveryEvents[0].command).toContain("npm install");

      // Should NOT spawn a new PTY - that's the renderer's job
      expect(mockPtyClient.spawn).not.toHaveBeenCalled();

      // Should emit installing status
      const installingEvent = statusEvents.find((e) => e.status === "installing");
      expect(installingEvent).toBeDefined();
      expect(installingEvent?.message).toContain("Installing missing dependencies");
    });

    it("does not detect errors when session is already running", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      const statusEvents: { status: DevPreviewStatus; message: string }[] = [];
      service.on("status", (e) => statusEvents.push(e));

      await service.attach({
        panelId: "panel-running",
        ptyId: "pty-running",
        cwd: "/test/project",
      });

      // First, set session to running by detecting a URL
      mockPtyClient.emit("data", "pty-running", "Server started at http://localhost:3000\n");

      // Clear events for clarity
      statusEvents.length = 0;

      // Now emit an error - should be ignored since already running
      mockPtyClient.emit(
        "data",
        "pty-running",
        "Error: listen EADDRINUSE: address already in use :::3001\n"
      );

      // No error status should be emitted
      const errorEvent = statusEvents.find((e) => e.status === "error");
      expect(errorEvent).toBeUndefined();
    });

    it("accumulates output buffer for error detection", async () => {
      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      const statusEvents: { status: DevPreviewStatus; message: string }[] = [];
      service.on("status", (e) => statusEvents.push(e));

      await service.attach({
        panelId: "panel-buffer",
        ptyId: "pty-buffer",
        cwd: "/test/project",
      });

      // Send error in chunks
      mockPtyClient.emit("data", "pty-buffer", "Error: listen EADDRINUSE: ");
      mockPtyClient.emit("data", "pty-buffer", "address already in use :::4000\n");

      const errorEvent = statusEvents.find((e) => e.status === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.message).toContain("Port 4000 is already in use");
    });

    it("uses correct package manager for recovery install command", async () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const pathStr = String(p);
        if (pathStr.includes("package.json")) return true;
        if (pathStr.includes("pnpm-lock.yaml")) return true;
        if (pathStr.includes("node_modules")) return true;
        return false;
      });

      const service = new DevPreviewServiceClass(mockPtyClient as unknown as PtyClient);
      const recoveryEvents: { panelId: string; command: string; attempt: number }[] = [];
      service.on("recovery", (e) => recoveryEvents.push(e));

      await service.attach({
        panelId: "panel-pnpm-recovery",
        ptyId: "pty-pnpm",
        cwd: "/test/project",
      });

      const session = service.getSession("panel-pnpm-recovery");
      expect(session?.packageManager).toBe("pnpm");

      // Trigger recovery
      mockPtyClient.emit("data", "pty-pnpm", "Error: Cannot find module 'vite'\n");
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Verify pnpm install command was in the recovery event
      expect(recoveryEvents.length).toBe(1);
      expect(recoveryEvents[0].command).toContain("pnpm install");
    });

    it("installs dependencies for user-provided commands when node_modules is missing", async () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const pathStr = String(p);
        if (pathStr.includes("package.json")) return true;
        if (pathStr.includes("node_modules")) return false; // Missing node_modules
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

      // Start with a user-provided command (not auto-detected)
      await service.attach({
        panelId: "panel-user-cmd-install",
        ptyId: "pty-user-cmd",
        cwd: "/test/project",
        devCommand: "npm run start:dev",
      });

      const session = service.getSession("panel-user-cmd-install");

      // Should be in installing state because node_modules is missing
      expect(session?.status).toBe("installing");
      expect(session?.installCommand).toBe("npm install");

      // First status event should be "installing"
      expect(statusEvents[0].status).toBe("installing");
      expect(statusEvents[0].message).toBe("Installing dependencies...");
    });
  });
});
