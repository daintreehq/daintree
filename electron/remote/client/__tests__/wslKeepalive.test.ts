import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WslKeepalive, type KeeperChild } from "../wslKeepalive.js";

class FakeKeeper extends EventEmitter implements KeeperChild {
  ended = false;
  killed: NodeJS.Signals[] = [];
  stdin = new Writable({
    write: (_chunk, _enc, callback) => callback(),
    final: (callback) => {
      this.ended = true;
      callback();
    },
  });

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    return true;
  }

  exit(): void {
    this.emit("exit", 0, null);
  }
}

describe("WslKeepalive", () => {
  let spawned: Array<{ args: string[]; child: FakeKeeper }>;
  let keepalive: WslKeepalive;

  beforeEach(() => {
    vi.useFakeTimers();
    spawned = [];
    keepalive = new WslKeepalive({
      wslPath: "wsl.exe",
      releaseGraceMs: 1_000,
      touchTtlMs: 60_000,
      spawn: (_wsl, args) => {
        const child = new FakeKeeper();
        spawned.push({ args, child });
        return child;
      },
    });
  });

  afterEach(() => {
    keepalive.dispose();
    vi.useRealTimers();
  });

  it("starts one keeper per distro, whatever the name's case, that reads a stdin nobody writes", () => {
    keepalive.want("Ubuntu-24.04");
    keepalive.touch("ubuntu-24.04");
    keepalive.want("Debian");
    expect(spawned.map((s) => s.args)).toEqual([
      ["-d", "Ubuntu-24.04", "--cd", "~", "--exec", "/bin/cat"],
      ["-d", "Debian", "--cd", "~", "--exec", "/bin/cat"],
    ]);
    expect(keepalive.isHeld("UBUNTU-24.04")).toBe(true);
  });

  it("keeps a wanted distro running until it is released, by ending stdin", async () => {
    keepalive.want("Ubuntu");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(keepalive.isHeld("Ubuntu")).toBe(true);
    const keeper = spawned[0]!.child;
    keepalive.release("Ubuntu");
    await vi.advanceTimersByTimeAsync(0);
    expect(keeper.ended).toBe(true);
    keeper.exit();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(keeper.killed).toEqual([]);
    expect(keepalive.isHeld("Ubuntu")).toBe(false);
  });

  it("lets a distro that was only checked stop a while after the last command", async () => {
    keepalive.touch("FedoraLinux-44");
    await vi.advanceTimersByTimeAsync(45_000);
    // Another command extends the hold.
    keepalive.touch("FedoraLinux-44");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(keepalive.isHeld("FedoraLinux-44")).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(keepalive.isHeld("FedoraLinux-44")).toBe(false);
    expect(spawned[0]!.child.ended).toBe(true);
  });

  it("keeps a touched distro that a link then wants", async () => {
    keepalive.touch("Ubuntu");
    keepalive.want("Ubuntu");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(keepalive.isHeld("Ubuntu")).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  it("kills a keeper that doesn't exit once its stdin closes", async () => {
    keepalive.want("Debian");
    const stuck = spawned[0]!.child;
    keepalive.release("Debian");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stuck.killed).toEqual(["SIGTERM"]);
  });

  it("starts a keeper again after one exited on its own (wsl --shutdown)", () => {
    keepalive.want("Ubuntu");
    spawned[0]!.child.exit();
    expect(keepalive.isHeld("Ubuntu")).toBe(false);
    keepalive.want("Ubuntu");
    expect(spawned).toHaveLength(2);
  });

  it("forgets a keeper wsl.exe couldn't start, without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    keepalive.want("Ubuntu");
    spawned[0]!.child.emit("error", new Error("spawn wsl.exe ENOENT"));
    expect(keepalive.isHeld("Ubuntu")).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("releases everything on dispose and holds nothing after", async () => {
    keepalive.want("Ubuntu");
    keepalive.touch("Debian");
    keepalive.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawned.every((s) => s.child.ended)).toBe(true);
    keepalive.want("Fedora");
    keepalive.touch("Fedora");
    expect(spawned).toHaveLength(2);
  });
});
