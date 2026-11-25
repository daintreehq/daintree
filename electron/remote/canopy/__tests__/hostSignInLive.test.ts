import { EventEmitter } from "node:events";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { quoteLaunchArgOptional } from "../../../../shared/utils/shellEscape.js";

const refs = vi.hoisted(() => ({
  ptyClient: null as unknown,
  cliService: null as unknown,
}));

vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => refs.ptyClient,
  getCliAvailabilityServiceRef: () => refs.cliService,
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

describe("liveHostSignInDeps().spawn", () => {
  it("runs the agent's own sign-in in a terminal in no project, ending with it", async () => {
    const { client, spawns } = fakePtyClient();
    refs.ptyClient = client;
    const started = await liveHostSignInDeps().spawn({
      terminalId: "daintree-sign-in-1",
      agentId: "claude",
    });
    expect(started).toEqual({ spawnedAt: 1234 });
    expect(spawns).toHaveLength(1);
    const { id, options } = spawns[0]!;
    expect(id).toBe("daintree-sign-in-1");
    expect(options.projectId).toBeNull();
    expect(options.kind).toBe("terminal");
    expect(options.cwd).toBe(os.homedir());
    expect(options.restore).toBe(false);
    if (process.platform !== "win32") {
      const script = options.args?.at(-1) ?? "";
      // The command runs once, then the shell exits rather than staying on.
      expect(script.split("\n")).toEqual(["trap : INT", "claude auth login", "exit"]);
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
    await liveHostSignInDeps().spawn({ terminalId: "daintree-sign-in-2", agentId: "codex" });
    if (process.platform !== "win32") {
      const line = (spawns[0]!.options.args?.at(-1) ?? "").split("\n")[1];
      expect(line).toMatch(/^'?\/home\/me\/\.local\/bin\/codex'? login$/);
    }
  });

  it("refuses an agent this host doesn't know, starting nothing", async () => {
    const { client } = fakePtyClient();
    refs.ptyClient = client;
    await expect(
      liveHostSignInDeps().spawn({ terminalId: "daintree-sign-in-3", agentId: "no-such-agent" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(client.spawn).not.toHaveBeenCalled();
  });

  it("says a terminal that didn't start in words that aren't an old host's", async () => {
    const { client } = fakePtyClient(false);
    refs.ptyClient = client;
    await expect(
      liveHostSignInDeps().spawn({ terminalId: "daintree-sign-in-4", agentId: "claude" })
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
