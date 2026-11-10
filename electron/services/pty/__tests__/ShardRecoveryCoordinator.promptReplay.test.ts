import { afterEach, describe, expect, it, vi } from "vitest";
import type { PtyHostSpawnOptions } from "../../../../shared/types/pty-host.js";
import {
  clearPluginAgentRegistryForTests,
  registerPluginAgents,
} from "../../../../shared/config/pluginAgentRegistry.js";
import {
  ShardRecoveryCoordinator,
  type ShardRecoveryCoordinatorDeps,
} from "../ShardRecoveryCoordinator.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const ORIGINAL_PLATFORM = process.platform;

function replayedAfterDelivery(platform: NodeJS.Platform, options: Partial<PtyHostSpawnOptions>) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  const pendingSpawns = new Map<string, PtyHostSpawnOptions>();
  const stored = { launchAgentId: "claude", args: ["carrier"], ...options } as PtyHostSpawnOptions;
  pendingSpawns.set("pane", stored);
  const coordinator = new ShardRecoveryCoordinator({
    pendingSpawns,
  } as unknown as ShardRecoveryCoordinatorDeps);
  const shard = { isRunning: () => true, send: vi.fn() };

  coordinator.sendSpawnWithPostInput(
    shard as unknown as Parameters<typeof coordinator.sendSpawnWithPostInput>[0],
    "pane",
    stored
  );
  return pendingSpawns.get("pane")!;
}

function decodedPowerShellCommand(args: readonly string[] | undefined): string {
  const encoded = args?.[(args?.indexOf("-EncodedCommand") ?? -2) + 1] ?? "";
  return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("the carrier a replay rebuilds after spending a session assignment (#16378)", () => {
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
  });

  it("puts a multi-line prompt on one line on Windows, where cmd.exe would cut it short", () => {
    const replay = replayedAfterDelivery("win32", {
      shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      command: `& 'C:\\npm\\claude.cmd' --session-id ${SESSION} "one\`n\`ntwo's"`,
    });

    expect(decodedPowerShellCommand(replay.args)).toBe(`& 'C:\\npm\\claude.cmd' 'one  two''s'`);
    // The saved command keeps the prompt's lines for a launch through the script.
    expect(replay.command).toBe(`& 'C:\\npm\\claude.cmd' "one\`n\`ntwo's"`);
  });

  it("leaves a single-line prompt as it was on Windows", () => {
    const replay = replayedAfterDelivery("win32", {
      shell: "powershell.exe",
      command: `& 'C:\\claude.exe' --session-id ${SESSION} 'one two'`,
    });

    expect(decodedPowerShellCommand(replay.args)).toBe(`& 'C:\\claude.exe' 'one two'`);
  });

  it("keeps a typed nushell prompt's spacing when stripping the spent id", () => {
    const prompt = `"say \\u{22}a  b\\u{22}\\nnext"`;
    const replay = replayedAfterDelivery("linux", {
      shell: "/usr/bin/nu",
      command: `claude --session-id ${SESSION} "$(printf '%b' 'say \\0042a  b\\0042\\nnext')"`,
      postSpawnInput: `claude --session-id ${SESSION} ${prompt}\r`,
    });

    expect(replay.postSpawnInput).toContain(`claude ${prompt}`);
  });

  it("keeps the line breaks on POSIX, where the wrapper builds them", () => {
    const prompt = `"$(printf '%b' 'one\\ntwo')"`;
    const replay = replayedAfterDelivery("linux", {
      shell: "/bin/bash",
      command: `claude --session-id ${SESSION} ${prompt}`,
    });

    expect(replay.args?.at(-1)).toContain(`claude ${prompt}`);
  });
});

describe("replaying a plugin agent's assigned session (#16470)", () => {
  const pi = (resumeArgs: string[]) =>
    registerPluginAgents("digitalfrontier.agents", [
      {
        id: "pi",
        name: "Pi",
        command: "pi",
        color: "#3366ff",
        iconId: "terminal",
        resume: {
          kind: "session-id",
          args: resumeArgs,
          assignSessionIdArgs: ["--session-id", "{sessionId}"],
        },
      },
    ]);
  const launched = {
    launchAgentId: "pi",
    shell: "/bin/bash",
    agentSessionId: SESSION,
    command: `pi --session-id ${SESSION}`,
  };

  afterEach(() => {
    clearPluginAgentRegistryForTests();
    Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
  });

  it("keeps the id when the same flag also resumes, so the pane reopens its own session", () => {
    pi(["--session-id", "{sessionId}"]);

    const replay = replayedAfterDelivery("linux", launched);

    expect(replay.command).toBe(launched.command);
    expect(replay.agentSessionId).toBe(SESSION);
  });

  it("disarms a flag that isn't known to resume, as for any one-shot assignment", () => {
    pi(["--session", "{sessionId}"]);

    const replay = replayedAfterDelivery("linux", launched);

    expect(replay.command).toBe("pi");
    expect(replay.agentSessionId).toBeUndefined();
  });
});
