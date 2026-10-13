import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), killed: false, kill: vi.fn() })));

vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("fs", () => ({ existsSync: vi.fn(() => true) }));

import { playSound } from "../soundPlayer.js";

describe("playSound", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    spawnMock.mockClear();
  });

  it.each(["win32", "darwin", "linux"])("hides the player's console window on %s", (platform) => {
    Object.defineProperty(process, "platform", { value: platform });
    playSound("/sounds/chime.wav");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]).toEqual([
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ windowsHide: true }),
    ]);
  });

  it("starts Windows PowerShell by its absolute System32 path", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    playSound("/sounds/chime.wav");
    expect(spawnMock.mock.calls[0]).toEqual([
      expect.stringMatching(
        /^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i
      ),
      expect.any(Array),
      expect.any(Object),
    ]);
  });
});
