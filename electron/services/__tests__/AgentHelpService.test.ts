import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { AgentHelpService } from "../AgentHelpService.js";
import { execFile } from "child_process";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

describe("AgentHelpService", () => {
  let service: AgentHelpService;
  const mockedExecFile = vi.mocked(execFile);

  beforeEach(() => {
    service = new AgentHelpService();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("getHelp", () => {
    it("returns help output for valid agent", async () => {
      mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
        callback(null, { stdout: "Usage: claude [options]", stderr: "" });
        return {} as any;
      });

      const result = await service.getHelp("claude");

      expect(result).toEqual({
        stdout: "Usage: claude [options]",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      });

      expect(mockedExecFile).toHaveBeenCalledWith(
        "claude",
        ["--help"],
        expect.objectContaining({
          timeout: 5000,
          maxBuffer: 256 * 1024,
          shell: false,
          windowsHide: true,
        }),
        expect.any(Function)
      );
    });

    it("uses custom help args from agent config", async () => {
      mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
        callback(null, { stdout: "Help output", stderr: "" });
        return {} as any;
      });

      await service.getHelp("claude");

      expect(mockedExecFile).toHaveBeenCalledWith(
        "claude",
        ["--help"],
        expect.any(Object),
        expect.any(Function)
      );
    });

    it("throws error for unknown agent", async () => {
      await expect(service.getHelp("unknown-agent")).rejects.toThrow(
        "Unknown agent: unknown-agent"
      );
    });

    it("throws error for invalid command", async () => {
      vi.doUnmock("../../../shared/config/agentRegistry.js");
      const { AGENT_REGISTRY } = await import("../../../shared/config/agentRegistry.js");
      (AGENT_REGISTRY as any)["test-agent"] = {
        id: "test-agent",
        name: "Test",
        command: "invalid;command",
      };

      await expect(service.getHelp("test-agent")).rejects.toThrow("Invalid command");

      delete (AGENT_REGISTRY as any)["test-agent"];
    });

    it("handles non-zero exit code", async () => {
      mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
        const error: any = new Error("Command failed");
        error.code = 1;
        error.stdout = "Partial output";
        error.stderr = "Error message";
        callback(error);
        return {} as any;
      });

      const result = await service.getHelp("claude");

      expect(result).toEqual({
        stdout: "Partial output",
        stderr: "Error message",
        exitCode: 1,
        timedOut: false,
        truncated: false,
      });
    });

    it("handles timeout", async () => {
      mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
        const error: any = new Error("Timeout");
        error.killed = true;
        error.signal = "SIGTERM";
        error.stdout = "Partial";
        error.stderr = "";
        callback(error);
        return {} as any;
      });

      const result = await service.getHelp("claude");

      expect(result.timedOut).toBe(true);
      expect(result.stdout).toBe("Partial");
    });

    it("handles buffer overflow", async () => {
      mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
        const error: any = new Error("Buffer overflow");
        error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        error.stdout = "x".repeat(256 * 1024);
        error.stderr = "";
        callback(error);
        return {} as any;
      });

      const result = await service.getHelp("claude");

      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBeLessThanOrEqual(256 * 1024);
    });

    it("caches results", async () => {
      mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
        callback(null, { stdout: "Cached output", stderr: "" });
        return {} as any;
      });

      await service.getHelp("claude");
      expect(mockedExecFile).toHaveBeenCalledTimes(1);

      await service.getHelp("claude");
      expect(mockedExecFile).toHaveBeenCalledTimes(1);
    });

    it("bypasses cache when refresh is true", async () => {
      mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
        callback(null, { stdout: "Fresh output", stderr: "" });
        return {} as any;
      });

      await service.getHelp("claude");
      expect(mockedExecFile).toHaveBeenCalledTimes(1);

      await service.getHelp("claude", true);
      expect(mockedExecFile).toHaveBeenCalledTimes(2);
    });

    it("respects cache TTL", async () => {
      mockedExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
        callback(null, { stdout: "Output", stderr: "" });
        return {} as any;
      });

      await service.getHelp("claude");
      expect(mockedExecFile).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(11 * 60 * 1000);

      await service.getHelp("claude");
      expect(mockedExecFile).toHaveBeenCalledTimes(2);
    });
  });

  describe("command validation", () => {
    it("rejects empty command", async () => {
      vi.doUnmock("../../../shared/config/agentRegistry.js");
      const { AGENT_REGISTRY } = await import("../../../shared/config/agentRegistry.js");
      (AGENT_REGISTRY as any)["empty"] = {
        id: "empty",
        name: "Empty",
        command: "",
      };

      await expect(service.getHelp("empty")).rejects.toThrow("Invalid command");

      delete (AGENT_REGISTRY as any)["empty"];
    });

    it("rejects command with invalid characters", async () => {
      vi.doUnmock("../../../shared/config/agentRegistry.js");
      const { AGENT_REGISTRY } = await import("../../../shared/config/agentRegistry.js");
      (AGENT_REGISTRY as any)["bad"] = {
        id: "bad",
        name: "Bad",
        command: "cmd && rm -rf /",
      };

      await expect(service.getHelp("bad")).rejects.toThrow("Invalid command");

      delete (AGENT_REGISTRY as any)["bad"];
    });
  });
});
