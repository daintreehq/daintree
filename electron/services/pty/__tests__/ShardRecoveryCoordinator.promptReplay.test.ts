import { afterEach, describe, expect, it, vi } from "vitest";
import type { PtyHostSpawnOptions } from "../../../../shared/types/pty-host.js";
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

  it("keeps the line breaks on POSIX, where the wrapper builds them", () => {
    const prompt = `"$(printf '%b' 'one\\ntwo')"`;
    const replay = replayedAfterDelivery("linux", {
      shell: "/bin/bash",
      command: `claude --session-id ${SESSION} ${prompt}`,
    });

    expect(replay.args?.at(-1)).toContain(`claude ${prompt}`);
  });
});
