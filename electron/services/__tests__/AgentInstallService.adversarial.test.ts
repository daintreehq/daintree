import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const spawnMock = vi.hoisted(() => vi.fn());
const getAgentConfigMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("../../../shared/config/agentRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/config/agentRegistry.js")>();
  return {
    ...actual,
    getAgentConfig: getAgentConfigMock,
  };
});

import { isBlockExecutable, runAgentInstall } from "../AgentInstallService.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  emitStdout(text: string): void;
  emitStderr(text: string): void;
  emitClose(code: number | null): void;
  emitError(err: Error): void;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.emitStdout = (t: string) => child.stdout.emit("data", Buffer.from(t));
  child.emitStderr = (t: string) => child.stderr.emit("data", Buffer.from(t));
  child.emitClose = (c: number | null) => child.emit("close", c);
  child.emitError = (e: Error) => child.emit("error", e);
  return child;
}

const originalPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p });
}

describe("AgentInstallService adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("linux");
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe("isBlockExecutable — manual-only detection", () => {
    it("rejects piped shell installs (curl | bash)", () => {
      expect(isBlockExecutable({ commands: ["curl https://example.com/install.sh | bash"] })).toBe(
        false
      );
    });

    it("rejects piped powershell-to-iex", () => {
      expect(isBlockExecutable({ commands: ['powershell -Command "irm https://x | iex"'] })).toBe(
        false
      );
    });

    it("rejects piped zsh", () => {
      expect(isBlockExecutable({ commands: ["curl https://a | zsh"] })).toBe(false);
    });

    it("accepts plain package-manager installs", () => {
      expect(isBlockExecutable({ commands: ["npm install -g foo"] })).toBe(true);
    });

    it("returns false for an empty command list", () => {
      expect(isBlockExecutable({ commands: [] })).toBe(false);
    });

    it("rejects the whole block if any command is manual-only", () => {
      expect(
        isBlockExecutable({
          commands: ["npm install -g foo", "curl https://x | bash"],
        })
      ).toBe(false);
    });
  });

  describe("runAgentInstall", () => {
    it("short-circuits before spawn when the agent is unknown", async () => {
      getAgentConfigMock.mockReturnValue(undefined);

      const result = await runAgentInstall({ agentId: "ghost", jobId: "j1" }, vi.fn());

      expect(result).toEqual({
        success: false,
        exitCode: null,
        error: "Unknown agent: ghost",
      });
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("OS-specific block wins over generic and falls back to index 0 when methodIndex is out of range", async () => {
      setPlatform("darwin");
      getAgentConfigMock.mockReturnValue({
        install: {
          byOs: {
            macos: [{ commands: ["brew install foo"] }],
            generic: [{ commands: ["wget foo"] }],
          },
        },
      });
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);
      const onProgress = vi.fn();
      const pending = runAgentInstall({ agentId: "a", jobId: "j1", methodIndex: 99 }, onProgress);
      child.emitClose(0);
      const result = await pending;

      expect(result.success).toBe(true);
      expect(spawnMock).toHaveBeenCalledWith(
        "brew",
        expect.arrayContaining(["install", "foo"]),
        expect.any(Object)
      );
      expect(spawnMock.mock.calls.some(([bin]) => bin === "wget")).toBe(false);
    });

    it("Windows npm installs append suppression flags and use shell:true with CI env", async () => {
      setPlatform("win32");
      getAgentConfigMock.mockReturnValue({
        install: {
          byOs: { windows: [{ commands: ["npm install -g foo"] }] },
        },
      });
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const pending = runAgentInstall({ agentId: "a", jobId: "j1" }, vi.fn());
      child.emitClose(0);
      await pending;

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [bin, args, opts] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { shell: boolean; env: Record<string, string> },
      ];
      expect(bin).toBe("npm");
      for (const flag of [
        "--silent",
        "--no-progress",
        "--no-audit",
        "--no-fund",
        "--no-update-notifier",
      ]) {
        expect(args).toContain(flag);
      }
      expect(opts.shell).toBe(true);
      expect(opts.env.CI).toBe("1");
      expect(opts.env.NO_UPDATE_NOTIFIER).toBe("1");
    });

    it("forwards progress events with correct stream + jobId across multiple commands in order", async () => {
      getAgentConfigMock.mockReturnValue({
        install: {
          byOs: {
            linux: [{ commands: ["echo cmd1", "echo cmd2"] }],
          },
        },
      });
      const children: FakeChild[] = [makeFakeChild(), makeFakeChild()];
      let n = 0;
      spawnMock.mockImplementation(() => children[n++]);
      const onProgress = vi.fn();

      const pending = runAgentInstall({ agentId: "a", jobId: "j1" }, onProgress);
      children[0].emitStdout("a");
      children[0].emitStderr("b");
      children[0].emitClose(0);
      await Promise.resolve();
      children[1].emitStdout("c");
      children[1].emitClose(0);
      const result = await pending;

      expect(result.success).toBe(true);
      expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
        { jobId: "j1", chunk: "a", stream: "stdout" },
        { jobId: "j1", chunk: "b", stream: "stderr" },
        { jobId: "j1", chunk: "c", stream: "stdout" },
      ]);
    });

    it("child 'error' emits stderr progress and returns exitCode 1 without hanging", async () => {
      getAgentConfigMock.mockReturnValue({
        install: { byOs: { linux: [{ commands: ["nope"] }] } },
      });
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);
      const onProgress = vi.fn();

      const pending = runAgentInstall({ agentId: "a", jobId: "j1" }, onProgress);
      child.emitError(new Error("spawn ENOENT"));
      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(onProgress).toHaveBeenCalledWith({
        jobId: "j1",
        chunk: "spawn ENOENT\n",
        stream: "stderr",
      });
      expect(result.error).toContain("nope");
    });

    it("first non-zero command aborts the remaining commands", async () => {
      getAgentConfigMock.mockReturnValue({
        install: {
          byOs: { linux: [{ commands: ["cmd1", "cmd2"] }] },
        },
      });
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const pending = runAgentInstall({ agentId: "a", jobId: "j1" }, vi.fn());
      child.emitClose(2);
      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(result.error).toContain("cmd1");
    });

    it("empty commands array in the chosen block returns a stable descriptive error", async () => {
      getAgentConfigMock.mockReturnValue({
        install: { byOs: { linux: [{ commands: [] }] } },
      });

      const result = await runAgentInstall({ agentId: "a", jobId: "j1" }, vi.fn());

      expect(result).toEqual({
        success: false,
        exitCode: null,
        error: expect.stringMatching(/manual execution|No commands/),
      });
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("missing install blocks entirely returns a stable descriptive error", async () => {
      getAgentConfigMock.mockReturnValue({ install: { byOs: {} } });

      const result = await runAgentInstall({ agentId: "a", jobId: "j1" }, vi.fn());

      expect(result.success).toBe(false);
      expect(result.error).toContain("No install blocks");
    });

    describe("env sandboxing and secret scrubbing (issue #6247)", () => {
      const originalEnv = process.env;

      afterEach(() => {
        process.env = originalEnv;
      });

      it("does not pass ANTHROPIC_API_KEY or GITHUB_TOKEN into the spawned child env", async () => {
        process.env = {
          ...originalEnv,
          ANTHROPIC_API_KEY: "sk-ant-x",
          GITHUB_TOKEN: "ghp_x",
          OPENAI_API_KEY: "sk-x",
          PATH: process.env.PATH ?? "/usr/bin",
          HOME: process.env.HOME ?? "/home/u",
        } as NodeJS.ProcessEnv;

        getAgentConfigMock.mockReturnValue({
          install: { byOs: { linux: [{ commands: ["npm install -g foo"] }] } },
        });
        const child = makeFakeChild();
        spawnMock.mockReturnValue(child);

        const pending = runAgentInstall({ agentId: "a", jobId: "j1" }, vi.fn());
        child.emitClose(0);
        await pending;

        const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
        expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(opts.env.GITHUB_TOKEN).toBeUndefined();
        expect(opts.env.OPENAI_API_KEY).toBeUndefined();
        expect(opts.env.CI).toBe("1");
        expect(opts.env.NO_UPDATE_NOTIFIER).toBe("1");
      });

      it("preserves proxy and version-manager vars needed for installs", async () => {
        process.env = {
          ...originalEnv,
          PATH: process.env.PATH ?? "/usr/bin",
          HOME: process.env.HOME ?? "/home/u",
          HTTPS_PROXY: "http://proxy:8080",
          NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-ca.pem",
          NVM_DIR: "/home/u/.nvm",
        } as NodeJS.ProcessEnv;

        getAgentConfigMock.mockReturnValue({
          install: { byOs: { linux: [{ commands: ["npm install -g foo"] }] } },
        });
        const child = makeFakeChild();
        spawnMock.mockReturnValue(child);

        const pending = runAgentInstall({ agentId: "a", jobId: "j1" }, vi.fn());
        child.emitClose(0);
        await pending;

        const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
        expect(opts.env.HTTPS_PROXY).toBe("http://proxy:8080");
        expect(opts.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp-ca.pem");
        expect(opts.env.NVM_DIR).toBe("/home/u/.nvm");
      });

      it("scrubs secrets from spawn-error messages emitted via the 'error' event", async () => {
        getAgentConfigMock.mockReturnValue({
          install: { byOs: { linux: [{ commands: ["nope"] }] } },
        });
        const child = makeFakeChild();
        spawnMock.mockReturnValue(child);
        const onProgress = vi.fn();

        const pending = runAgentInstall({ agentId: "a", jobId: "j1" }, onProgress);
        const leakingKey = "sk-ant-" + "A".repeat(95);
        child.emitError(new Error(`spawn failed for env=${leakingKey}`));
        await pending;

        const errorEvent = onProgress.mock.calls
          .map(([e]) => e as { stream: string; chunk: string })
          .find((e) => e.stream === "stderr" && e.chunk.includes("spawn failed"));
        expect(errorEvent).toBeDefined();
        expect(errorEvent!.chunk).not.toContain(leakingKey);
        expect(errorEvent!.chunk).toContain("[REDACTED]");
      });

      it("scrubs secrets from streamed stdout chunks at the emit boundary", async () => {
        getAgentConfigMock.mockReturnValue({
          install: { byOs: { linux: [{ commands: ["npm install -g foo"] }] } },
        });
        const child = makeFakeChild();
        spawnMock.mockReturnValue(child);
        const onProgress = vi.fn();

        const pending = runAgentInstall({ agentId: "a", jobId: "j1" }, onProgress);
        const leakingKey = "sk-ant-" + "A".repeat(95);
        child.emitStdout(`npm warn deprecated\nleak ${leakingKey} trailing\n`);
        child.emitStderr(`auth failure ghp_${"B".repeat(40)}\n`);
        child.emitClose(0);
        await pending;

        const stdoutEvents = onProgress.mock.calls
          .map(([e]) => e as { stream: string; chunk: string })
          .filter((e) => e.stream === "stdout");
        const stderrEvents = onProgress.mock.calls
          .map(([e]) => e as { stream: string; chunk: string })
          .filter((e) => e.stream === "stderr");

        for (const ev of stdoutEvents) {
          expect(ev.chunk).not.toContain(leakingKey);
        }
        expect(stdoutEvents.some((e) => e.chunk.includes("[REDACTED]"))).toBe(true);
        for (const ev of stderrEvents) {
          expect(ev.chunk).not.toMatch(/ghp_[A-Z]{40}/);
        }
        expect(stderrEvents.some((e) => e.chunk.includes("[REDACTED]"))).toBe(true);
      });
    });

    it("finalize is idempotent — close after error does not emit a second result", async () => {
      getAgentConfigMock.mockReturnValue({
        install: { byOs: { linux: [{ commands: ["cmd1"] }] } },
      });
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const pending = runAgentInstall({ agentId: "a", jobId: "j1" }, vi.fn());
      child.emitError(new Error("boom"));
      child.emitClose(0);
      const result = await pending;

      expect(result.exitCode).toBe(1);
      expect(result.success).toBe(false);
    });
  });
});
