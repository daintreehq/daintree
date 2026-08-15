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

import {
  isBlockExecutable,
  runAgentInstall,
  resetInFlightInstalls,
} from "../AgentInstallService.js";

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

    it("rejects piped sudo bash", () => {
      expect(isBlockExecutable({ commands: ["curl https://x | sudo bash"] })).toBe(false);
    });

    it("rejects piped sudo sh", () => {
      expect(isBlockExecutable({ commands: ["wget https://x | sudo sh"] })).toBe(false);
    });

    it("rejects piped pwsh (PowerShell Core)", () => {
      expect(isBlockExecutable({ commands: ["irm https://x | pwsh"] })).toBe(false);
    });

    it("rejects piped IEX (uppercase)", () => {
      expect(isBlockExecutable({ commands: ["irm https://x | IEX"] })).toBe(false);
    });

    it("rejects piped Invoke-Expression (long form)", () => {
      expect(isBlockExecutable({ commands: ["irm https://x | Invoke-Expression"] })).toBe(false);
    });

    it("accepts benign pipe without shell interpreter", () => {
      expect(isBlockExecutable({ commands: ["echo foo | grep bar"] })).toBe(true);
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
        { shell: boolean; env: Record<string, string>; windowsHide?: boolean },
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
      expect(opts.windowsHide).toBe(true);
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

describe("AgentInstallService — elevation and prerequisite targets (#11763)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("linux");
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe("sudo gate", () => {
    it("refuses a bare sudo command", () => {
      // No pipe, so the pipe-to-shell regex never saw it: spawning this with
      // piped stdio hangs on a password prompt the user cannot see.
      expect(isBlockExecutable({ commands: ["sudo apt-get install git"] })).toBe(false);
    });

    it("refuses a block where only a later command needs sudo", () => {
      expect(isBlockExecutable({ commands: ["mkdir -p /tmp/x", "sudo apt-get install gh"] })).toBe(
        false
      );
    });

    it("refuses sudo regardless of leading whitespace or case", () => {
      expect(isBlockExecutable({ commands: ["   sudo apt-get install git"] })).toBe(false);
      expect(isBlockExecutable({ commands: ["SUDO apt-get install git"] })).toBe(false);
    });

    it("allows a command that merely mentions sudo later in the line", () => {
      expect(isBlockExecutable({ commands: ["echo run sudo yourself"] })).toBe(true);
    });

    it("allows sudoedit and other commands with a sudo prefix in the name", () => {
      expect(isBlockExecutable({ commands: ["sudoku --solve"] })).toBe(true);
    });

    it("never spawns for a sudo block", async () => {
      getAgentConfigMock.mockReturnValue({
        install: { byOs: { linux: [{ commands: ["sudo apt-get install gh"] }] } },
      });

      const result = await runAgentInstall({ agentId: "gh", jobId: "j-sudo" }, vi.fn());

      expect(result.success).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  describe("prerequisite install targets", () => {
    it("rejects an unknown prerequisite without spawning", async () => {
      const result = await runAgentInstall(
        { prerequisiteTool: "definitely-not-a-tool", jobId: "j2" },
        vi.fn()
      );

      expect(result.success).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("resolves commands from the baseline spec, not from the caller", async () => {
      setPlatform("darwin");
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const promise = runAgentInstall({ prerequisiteTool: "git", jobId: "j3" }, vi.fn());
      await Promise.resolve();
      child.emitClose(0);
      const result = await promise;

      expect(result.success).toBe(true);
      // The renderer named a tool; main chose the binary and its arguments.
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[0]).toBe("brew");
    });

    it("refuses the Linux git block because it needs sudo", async () => {
      setPlatform("linux");

      const result = await runAgentInstall({ prerequisiteTool: "git", jobId: "j4" }, vi.fn());

      expect(result.success).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("does not consult the agent registry for a prerequisite target", async () => {
      setPlatform("darwin");
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const promise = runAgentInstall({ prerequisiteTool: "git", jobId: "j5" }, vi.fn());
      await Promise.resolve();
      child.emitClose(0);
      await promise;

      expect(getAgentConfigMock).not.toHaveBeenCalled();
    });

    it("selects the Command Line Tools block by methodIndex on macOS", async () => {
      setPlatform("darwin");
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const promise = runAgentInstall(
        { prerequisiteTool: "git", methodIndex: 1, jobId: "j6" },
        vi.fn()
      );
      await Promise.resolve();
      child.emitClose(0);
      await promise;

      expect(spawnMock.mock.calls[0]?.[0]).toBe("xcode-select");
    });
  });

  describe("install method validation", () => {
    it.each([99, -1, 1.5, NaN])(
      "rejects out-of-range prerequisite method %s without spawning",
      async (methodIndex) => {
        setPlatform("darwin");

        const result = await runAgentInstall(
          { prerequisiteTool: "git", methodIndex, jobId: "j-idx" },
          vi.fn()
        );

        // Block 0 is `brew install git` and block 1 hands off to Apple's
        // installer — silently substituting one for the other would run an
        // install the caller never asked for.
        expect(result.success).toBe(false);
        expect(spawnMock).not.toHaveBeenCalled();
      }
    );
  });

  describe("concurrent installs", () => {
    beforeEach(() => {
      resetInFlightInstalls();
    });

    it("refuses a second install of the same target while one is running", async () => {
      // Each project view is its own WebContentsView with its own store, so the
      // renderer-side guard cannot see an install started in another view.
      setPlatform("darwin");
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const first = runAgentInstall({ prerequisiteTool: "git", jobId: "job-a" }, vi.fn());
      await Promise.resolve();
      const second = await runAgentInstall({ prerequisiteTool: "git", jobId: "job-b" }, vi.fn());

      expect(second.success).toBe(false);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      child.emitClose(0);
      expect((await first).success).toBe(true);
    });

    it("releases the target once the install settles", async () => {
      setPlatform("darwin");
      const first = makeFakeChild();
      spawnMock.mockReturnValue(first);

      const failed = runAgentInstall({ prerequisiteTool: "git", jobId: "job-a" }, vi.fn());
      await Promise.resolve();
      first.emitClose(1);
      expect((await failed).success).toBe(false);

      const second = makeFakeChild();
      spawnMock.mockReturnValue(second);
      const retry = runAgentInstall({ prerequisiteTool: "git", jobId: "job-b" }, vi.fn());
      await Promise.resolve();
      second.emitClose(0);

      expect((await retry).success).toBe(true);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it("does not block a different target", async () => {
      setPlatform("darwin");
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);
      getAgentConfigMock.mockReturnValue({
        install: { byOs: { macos: [{ commands: ["brew install foo"] }] } },
      });

      const gitInstall = runAgentInstall({ prerequisiteTool: "git", jobId: "job-a" }, vi.fn());
      await Promise.resolve();
      const agentInstall = runAgentInstall({ agentId: "foo", jobId: "job-b" }, vi.fn());
      await Promise.resolve();

      expect(spawnMock).toHaveBeenCalledTimes(2);
      child.emitClose(0);
      await gitInstall;
      await agentInstall;
    });
  });

  describe("windows git command", () => {
    it("passes the agreement flags winget needs under piped stdio", async () => {
      setPlatform("win32");
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const promise = runAgentInstall({ prerequisiteTool: "git", jobId: "j7" }, vi.fn());
      await Promise.resolve();
      child.emitClose(0);
      await promise;

      const args = spawnMock.mock.calls[0]?.[1] as string[];
      expect(spawnMock.mock.calls[0]?.[0]).toBe("winget");
      expect(args).toContain("--accept-source-agreements");
      expect(args).toContain("--accept-package-agreements");
    });
  });
});
