import { EventEmitter } from "node:events";
import { mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { quoteLaunchArgOptional } from "../../../../shared/utils/shellEscape.js";

const refs = vi.hoisted(() => ({
  ptyClient: null as unknown,
  cliService: null as unknown,
  versions: null as unknown,
  userData: "",
}));

vi.mock("electron", () => ({ app: { getPath: () => refs.userData } }));

vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => refs.ptyClient,
  getCliAvailabilityServiceRef: () => refs.cliService,
  getAgentVersionService: () => refs.versions,
}));

import { agentSignInCommand, liveHostSignInDeps } from "../hostSignInLive.js";

interface SpawnCall {
  id: string;
  options: {
    cwd: string;
    shell?: string;
    args?: string[];
    kind?: string;
    projectId?: string | null;
    restore?: boolean;
  };
}

function fakePtyClient(succeeds = true) {
  const emitter = new EventEmitter();
  const spawns: SpawnCall[] = [];
  const client = {
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    off: (event: string, listener: (...args: unknown[]) => void) => emitter.off(event, listener),
    emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    spawn: vi.fn((id: string, options: SpawnCall["options"]) => {
      spawns.push({ id, options });
      queueMicrotask(() => emitter.emit("spawn-result", id, { success: succeeds, id }));
    }),
    getTerminalAsync: vi.fn(async () => ({ spawnedAt: 1234 })),
    kill: vi.fn(),
  };
  return { client, spawns };
}

beforeEach(() => {
  refs.ptyClient = null;
  refs.cliService = null;
  refs.versions = null;
  refs.userData = mkdtempSync(path.join(os.tmpdir(), "sign-in-"));
});

describe("the command a host's sign-in runs", () => {
  it("is the CLI's own sign-in command, after the copy its launches start", () => {
    expect(agentSignInCommand("claude", ["auth", "login"], "posix", quoteLaunchArgOptional)).toBe(
      "claude auth login"
    );
    expect(
      agentSignInCommand("'/opt/my tools/codex'", ["login"], "posix", quoteLaunchArgOptional)
    ).toBe("'/opt/my tools/codex' login");
  });

  it("opens the CLI as it is when it declares no sign-in command", () => {
    expect(agentSignInCommand("gemini", undefined, "posix", quoteLaunchArgOptional)).toBe("gemini");
  });
});

describe("liveHostSignInDeps().onGone", () => {
  it("hears its own terminal exit or be dropped, and stops hearing when told", () => {
    const { client } = fakePtyClient();
    refs.ptyClient = client;
    const gone = vi.fn();
    const stop = liveHostSignInDeps().onGone("daintree-sign-in-1", gone);
    const emit = (event: string, id: string) => client.emit(event, id);
    emit("exit", "other-terminal");
    expect(gone).not.toHaveBeenCalled();
    emit("terminal-lost", "daintree-sign-in-1");
    emit("exit", "daintree-sign-in-1");
    expect(gone).toHaveBeenCalledTimes(2);
    stop();
    emit("exit", "daintree-sign-in-1");
    expect(gone).toHaveBeenCalledTimes(2);
  });
});

describe("liveHostSignInDeps().spawn", () => {
  it("runs the agent's own sign-in in a terminal in no project, then hands back the host's shell", async () => {
    const { client, spawns } = fakePtyClient();
    refs.ptyClient = client;
    const started = await liveHostSignInDeps().spawn({
      terminalId: "daintree-sign-in-1",
      agentId: "claude",
      cancelled: () => false,
    });
    expect(started).toEqual({ spawnedAt: 1234 });
    expect(spawns).toHaveLength(1);
    const { id, options } = spawns[0]!;
    expect(id).toBe("daintree-sign-in-1");
    expect(options.projectId).toBeNull();
    expect(options.kind).toBe("terminal");
    // A folder of Daintree's own, never the person's home or a project.
    expect(options.cwd).toBe(path.join(refs.userData, "agent-sign-in"));
    expect(statSync(options.cwd).isDirectory()).toBe(true);
    expect(options.restore).toBe(false);
    if (process.platform !== "win32") {
      const lines = (options.args?.at(-1) ?? "").split("\n");
      expect(lines[1]).toBe("claude auth login");
      // What it printed stays on screen under the host's own shell.
      expect(lines.at(-1)).toMatch(/^exec /);
    }
  });

  it("starts the copy of the CLI the host's launches start", async () => {
    const { client, spawns } = fakePtyClient();
    refs.ptyClient = client;
    refs.cliService = {
      getDetails: () => ({
        codex: { state: "ready", resolvedPath: "/home/me/.local/bin/codex", via: "path" },
      }),
    };
    await liveHostSignInDeps().spawn({
      terminalId: "daintree-sign-in-2",
      agentId: "codex",
      cancelled: () => false,
    });
    if (process.platform !== "win32") {
      const line = (spawns[0]!.options.args?.at(-1) ?? "").split("\n")[1];
      expect(line).toMatch(/^'?\/home\/me\/\.local\/bin\/codex'? login$/);
    }
  });

  it("opens a copy older than its sign-in command as it is", async () => {
    const { client, spawns } = fakePtyClient();
    refs.ptyClient = client;
    refs.versions = { getInstalledVersionForLaunch: vi.fn(async () => "2.1.0") };
    await liveHostSignInDeps().spawn({
      terminalId: "daintree-sign-in-5",
      agentId: "claude",
      cancelled: () => false,
    });
    if (process.platform !== "win32") {
      expect((spawns[0]!.options.args?.at(-1) ?? "").split("\n")[1]).toBe("claude");
    }
  });

  it("runs the sign-in command on a copy new enough to have it", async () => {
    const { client, spawns } = fakePtyClient();
    refs.ptyClient = client;
    refs.versions = { getInstalledVersionForLaunch: vi.fn(async () => "2.1.41") };
    await liveHostSignInDeps().spawn({
      terminalId: "daintree-sign-in-6",
      agentId: "claude",
      cancelled: () => false,
    });
    if (process.platform !== "win32") {
      expect((spawns[0]!.options.args?.at(-1) ?? "").split("\n")[1]).toBe("claude auth login");
    }
  });

  it("starts nothing once its dialog has closed", async () => {
    const { client } = fakePtyClient();
    refs.ptyClient = client;
    await expect(
      liveHostSignInDeps().spawn({
        terminalId: "daintree-sign-in-7",
        agentId: "claude",
        cancelled: () => true,
      })
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(client.spawn).not.toHaveBeenCalled();
  });

  it("refuses an agent this host doesn't know, starting nothing", async () => {
    const { client } = fakePtyClient();
    refs.ptyClient = client;
    await expect(
      liveHostSignInDeps().spawn({
        terminalId: "daintree-sign-in-3",
        agentId: "no-such-agent",
        cancelled: () => false,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(client.spawn).not.toHaveBeenCalled();
  });

  it("says a terminal that didn't start in words that aren't an old host's", async () => {
    const { client } = fakePtyClient(false);
    refs.ptyClient = client;
    await expect(
      liveHostSignInDeps().spawn({
        terminalId: "daintree-sign-in-4",
        agentId: "claude",
        cancelled: () => false,
      })
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
