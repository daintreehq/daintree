import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CENSUS_COOLDOWN_BASE_MS,
  CENSUS_COOLDOWN_CEILING_MS,
  CENSUS_FAILURES_BEFORE_COOLDOWN,
  CENSUS_PIPELINE,
  CENSUS_REQUEST_TIMEOUT_MS,
  CENSUS_SENTINEL_PREFIX,
  WindowsProcessCensus,
} from "../WindowsProcessCensus.js";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("child_process", () => ({ spawn: mockSpawn }));

type FakeStream = EventEmitter & { setEncoding: () => void; resume: () => void };

function makeStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.setEncoding = vi.fn();
  stream.resume = vi.fn();
  return stream;
}

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: FakeStream;
  stderr: FakeStream;
  stdin: EventEmitter & { write: (chunk: string) => boolean; end: () => void };
  kill: ReturnType<typeof vi.fn>;
  writes: string[];
}

function makeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  const writes: string[] = [];
  child.pid = pid;
  child.stdout = makeStream();
  child.stderr = makeStream();
  child.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn(),
  });
  child.kill = vi.fn();
  child.writes = writes;
  return child;
}

/** The id the helper wrote for its most recent request. */
function lastRequestId(child: FakeChild): string {
  return child.writes[child.writes.length - 1].trim();
}

function respond(child: FakeChild, payload: string, id: string = lastRequestId(child)): void {
  child.stdout.emit("data", `${payload}\n${CENSUS_SENTINEL_PREFIX}${id}\n`);
}

let children: FakeChild[] = [];

beforeEach(() => {
  children = [];
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => {
    const child = makeChild(9000 + children.length);
    children.push(child);
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WindowsProcessCensus", () => {
  describe("transport", () => {
    it("does not start a process until a census is actually demanded", () => {
      new WindowsProcessCensus();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("serves many censuses from ONE PowerShell process", async () => {
      // The whole point of #12243: N censuses used to be N process starts.
      const census = new WindowsProcessCensus();

      for (let i = 0; i < 5; i++) {
        const pending = census.request();
        respond(children[0], "[]");
        await pending;
      }

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(children[0].writes).toHaveLength(5);
    });

    it("writes one newline-terminated request id per census and reuses the child", async () => {
      // `[Console]::In.ReadLine()` blocks until a newline arrives, so a request
      // written without one hangs a real helper forever while every mock in
      // this file answers it happily. The ids must also advance, or the
      // sentinel correlation has nothing to correlate.
      const census = new WindowsProcessCensus();
      for (let i = 0; i < 3; i++) {
        const pending = census.request();
        respond(children[0], "[]");
        await pending;
      }

      expect(children[0].writes).toEqual(["1\n", "2\n", "3\n"]);
      // A helper "reused" by killing it and keeping the reference would pass a
      // spawn count against these fakes.
      expect(children[0].kill).not.toHaveBeenCalled();
      expect(children[0].stdin.end).not.toHaveBeenCalled();
    });

    it("pipes all three streams, decodes stdout as UTF-8, and drains stderr", async () => {
      // stdout without an encoding yields Buffers, which would corrupt a
      // multi-byte character split across a chunk boundary. An undrained
      // stderr pipe eventually blocks the helper mid-census.
      const census = new WindowsProcessCensus();
      const pending = census.request();
      respond(children[0], "[]");
      await pending;

      const opts = mockSpawn.mock.calls[0][2] as { stdio?: unknown };
      expect(opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
      expect(children[0].stdout.setEncoding).toHaveBeenCalledWith("utf8");
      expect(children[0].stderr.resume).toHaveBeenCalled();
    });

    it("spawns powershell directly and hidden, never through a shell", async () => {
      const census = new WindowsProcessCensus();
      const pending = census.request();
      respond(children[0], "[]");
      await pending;

      const [file, args, opts] = mockSpawn.mock.calls[0] as [
        string,
        string[],
        { windowsHide?: boolean; shell?: boolean },
      ];
      expect(file.toLowerCase()).toContain("powershell");
      expect(args).toContain("-NoProfile");
      expect(args).toContain("-NonInteractive");
      expect(args).toContain("-Command");
      expect(opts.windowsHide).toBe(true);
      expect(opts.shell).toBe(false);
    });

    it("sets the BOM-less UTF-8 bootstrap once at startup, outside the request loop", async () => {
      const census = new WindowsProcessCensus();
      const pending = census.request();
      respond(children[0], "[]");
      await pending;

      const args = mockSpawn.mock.calls[0][1] as string[];
      const script = args[args.indexOf("-Command") + 1];
      expect(script).toContain(
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)"
      );
      expect(script).toContain("$OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
      // Before `while`, not inside it: re-running it per request would be
      // wasted work, and a BOM-ful encoding would break every frame but the
      // first (#7955).
      expect(script.indexOf("[Console]::OutputEncoding")).toBeLessThan(script.indexOf("while ("));
    });

    it("silences every non-protocol PowerShell stream", async () => {
      const census = new WindowsProcessCensus();
      const pending = census.request();
      respond(children[0], "[]");
      await pending;

      const args = mockSpawn.mock.calls[0][1] as string[];
      const script = args[args.indexOf("-Command") + 1];
      for (const preference of [
        "$ErrorActionPreference",
        "$ProgressPreference",
        "$WarningPreference",
        "$InformationPreference",
        "$VerbosePreference",
        "$DebugPreference",
      ]) {
        expect(script).toContain(`${preference} = 'SilentlyContinue'`);
      }
    });

    it("keeps PowerShell's own $_ pipeline variable unexpanded", async () => {
      // The script is built with string concatenation precisely so JS never
      // interpolates these.
      const census = new WindowsProcessCensus();
      const pending = census.request();
      respond(children[0], "[]");
      await pending;

      const args = mockSpawn.mock.calls[0][1] as string[];
      const script = args[args.indexOf("-Command") + 1];
      expect(script).toContain("[string]$_.KernelModeTime");
      expect(script).toContain("$_.CreationDate.ToString('o')");
      expect(script).toContain("Get-CimInstance Win32_Process");
      expect(script).toContain(CENSUS_PIPELINE);
    });

    it("reads stdin line by line rather than relying on `-Command -`", async () => {
      // PS 5.1 reads stdin to EOF before executing, so `-Command -` is not a
      // REPL and the loop has to be explicit.
      const census = new WindowsProcessCensus();
      const pending = census.request();
      respond(children[0], "[]");
      await pending;

      const args = mockSpawn.mock.calls[0][1] as string[];
      const script = args[args.indexOf("-Command") + 1];
      expect(args).not.toContain("-");
      expect(script).toContain("[Console]::In.ReadLine()");
      expect(script).toContain("while ($true)");
    });

    it("asks for ExecutablePath so the per-PID image probe is unnecessary", () => {
      expect(CENSUS_PIPELINE).toContain("ExecutablePath");
    });
  });

  describe("framing", () => {
    it("reassembles a payload split across chunk boundaries", async () => {
      const census = new WindowsProcessCensus();
      const pending = census.request();
      const id = lastRequestId(children[0]);

      children[0].stdout.emit("data", '[{"ProcessId":1,');
      children[0].stdout.emit("data", '"Name":"node.exe"}]\n');
      children[0].stdout.emit("data", `${CENSUS_SENTINEL_PREFIX}${id}\n`);

      expect(await pending).toBe('[{"ProcessId":1,"Name":"node.exe"}]');
    });

    it("reassembles a sentinel split across chunk boundaries", async () => {
      const census = new WindowsProcessCensus();
      const pending = census.request();
      const id = lastRequestId(children[0]);
      const sentinel = `${CENSUS_SENTINEL_PREFIX}${id}`;

      children[0].stdout.emit("data", `[]\n${sentinel.slice(0, 8)}`);
      children[0].stdout.emit("data", `${sentinel.slice(8)}\n`);

      expect(await pending).toBe("[]");
    });

    it("does not end a frame on the sentinel literal appearing mid-line", async () => {
      // A user really can run `echo __DAINTREE_CENSUS_END__:1`, and its command
      // line lands inside the payload. Only a whole line terminates a frame.
      const census = new WindowsProcessCensus();
      const pending = census.request();
      const id = lastRequestId(children[0]);
      const payload = `[{"CommandLine":"echo ${CENSUS_SENTINEL_PREFIX}${id}"}]`;

      children[0].stdout.emit("data", `${payload}\n${CENSUS_SENTINEL_PREFIX}${id}\n`);

      expect(await pending).toBe(payload);
    });

    it("waits for the sentinel's line ending before resolving", async () => {
      // The defect this closes: resolving on the id alone leaves the trailing
      // CRLF to arrive with nothing outstanding, which reads as a protocol
      // violation and retires a perfectly healthy helper — putting one
      // PowerShell start back on every poll, and never earning a cooldown
      // because every request "succeeded".
      const census = new WindowsProcessCensus();
      const pending = census.request();
      const id = lastRequestId(children[0]);
      const settled = vi.fn();
      void pending.then(settled, settled);

      children[0].stdout.emit("data", `[]\r\n${CENSUS_SENTINEL_PREFIX}${id}`);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();

      children[0].stdout.emit("data", "\r\n");
      expect(await pending).toBe("[]");
      expect(census.isRunning).toBe(true);

      // The helper survived, so the next census costs no start.
      const next = census.request();
      respond(children[0], "[]");
      await next;
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it("waits for the LF half of a CRLF split across chunks", async () => {
      const census = new WindowsProcessCensus();
      const pending = census.request();
      const id = lastRequestId(children[0]);
      const settled = vi.fn();
      void pending.then(settled, settled);

      children[0].stdout.emit("data", `[]\r\n${CENSUS_SENTINEL_PREFIX}${id}\r`);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();

      children[0].stdout.emit("data", "\n");
      expect(await pending).toBe("[]");
    });

    it("does not accept a longer id that starts with the one it asked for", async () => {
      // Request 1 must not take request 10's answer. Matching the id as a bare
      // prefix is the easy way to get this wrong.
      vi.useFakeTimers();
      const census = new WindowsProcessCensus();
      const pending = census.request();
      const id = lastRequestId(children[0]);
      expect(id).toBe("1");
      const settled = vi.fn();
      void pending.then(settled, settled);

      children[0].stdout.emit("data", `[]\n${CENSUS_SENTINEL_PREFIX}${id}0\n`);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();

      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(CENSUS_REQUEST_TIMEOUT_MS);
      await assertion;
    });

    it("reassembles a sentinel split after a payload long enough to need the scan overlap", async () => {
      // A short payload leaves the incremental scan starting at offset 0, where
      // rescanning the whole buffer and scanning only the new region are the
      // same thing. This one is long enough that they are not.
      const census = new WindowsProcessCensus();
      const pending = census.request();
      const id = lastRequestId(children[0]);
      const sentinel = `${CENSUS_SENTINEL_PREFIX}${id}`;
      const payload = `[{"CommandLine":"${"x".repeat(200_000)}"}]`;

      children[0].stdout.emit("data", `${payload}\r\n${sentinel.slice(0, 9)}`);
      children[0].stdout.emit("data", `${sentinel.slice(9)}\r\n`);

      expect(await pending).toBe(payload);
    });

    it("strips a BOM from a later frame, not just the first", async () => {
      // The encoding bootstrap runs once at startup; a regression that made it
      // per-request, or that lost the BOM-less flag, breaks every frame after
      // the first rather than the first one (#7955).
      const census = new WindowsProcessCensus();
      const first = census.request();
      respond(children[0], "[]");
      await first;

      const second = census.request();
      const id = lastRequestId(children[0]);
      children[0].stdout.emit(
        "data",
        `\uFEFF[{"ProcessId":1}]\r\n${CENSUS_SENTINEL_PREFIX}${id}\r\n`
      );
      expect(await second).toBe('[{"ProcessId":1}]');
    });

    it("rejects and retires a response that never stops arriving, then recovers", async () => {
      const census = new WindowsProcessCensus();
      const pending = census.request();

      const chunk = "x".repeat(1024 * 1024);
      const assertion = expect(pending).rejects.toThrow(/exceeded/);
      for (let i = 0; i < 33 && census.isRunning; i++) {
        children[0].stdout.emit("data", chunk);
      }
      await assertion;

      expect(census.isRunning).toBe(false);
      const next = census.request();
      respond(children[1], "[]");
      expect(await next).toBe("[]");
    });

    it("ignores a response framed for a different request id", async () => {
      vi.useFakeTimers();
      const census = new WindowsProcessCensus();
      const pending = census.request();

      const settled = vi.fn();
      void pending.then(settled, settled);
      children[0].stdout.emit("data", `[]\n${CENSUS_SENTINEL_PREFIX}999\n`);

      // A full timer drain, not one microtask: promise adoption can hide an
      // already-settled response for another turn, and a single
      // `await Promise.resolve()` would let this assertion pass either way.
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();

      await expect(
        (async () => {
          const race = pending;
          await vi.advanceTimersByTimeAsync(CENSUS_REQUEST_TIMEOUT_MS);
          return race;
        })()
      ).rejects.toThrow(/timed out/);
    });

    it("rejects a frame carrying more than the one JSON line it promised", async () => {
      const census = new WindowsProcessCensus();
      const pending = census.request();
      const id = lastRequestId(children[0]);

      children[0].stdout.emit("data", `WARNING: something\n[]\n${CENSUS_SENTINEL_PREFIX}${id}\n`);

      // Picking "the line that looks like JSON" out of noisy output would let
      // unrelated output be trusted as a census. Unexpected stdout is a
      // protocol failure, and the cache keeps its last-good snapshot.
      await expect(pending).rejects.toThrow(/2 lines before its sentinel/);
    });

    it("rejects an empty frame", async () => {
      const census = new WindowsProcessCensus();
      const pending = census.request();
      const id = lastRequestId(children[0]);

      children[0].stdout.emit("data", `${CENSUS_SENTINEL_PREFIX}${id}\n`);

      await expect(pending).rejects.toThrow(/0 lines before its sentinel/);
    });

    it("retires the helper when it writes with nothing outstanding", async () => {
      const census = new WindowsProcessCensus();
      const pending = census.request();
      respond(children[0], "[]");
      await pending;

      children[0].stdout.emit("data", "[]\n");

      expect(census.isRunning).toBe(false);
      expect(children[0].kill).toHaveBeenCalled();
    });
  });

  describe("failure and recovery", () => {
    it("rejects and retires when the helper exits mid-request", async () => {
      const census = new WindowsProcessCensus();
      const pending = census.request();

      children[0].emit("exit", 1, null);

      await expect(pending).rejects.toThrow(/exited/);
      expect(census.isRunning).toBe(false);
    });

    it("starts a replacement helper on the next census after a crash", async () => {
      const census = new WindowsProcessCensus();
      const first = census.request();
      children[0].emit("exit", 1, null);
      await expect(first).rejects.toThrow();

      const second = census.request();
      respond(children[1], "[]");

      expect(await second).toBe("[]");
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it("kills a hung helper once the request deadline passes", async () => {
      vi.useFakeTimers();
      const census = new WindowsProcessCensus();
      const pending = census.request();

      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(CENSUS_REQUEST_TIMEOUT_MS);
      await assertion;

      expect(children[0].kill).toHaveBeenCalled();
      expect(census.isRunning).toBe(false);
    });

    it("does not charge a failure for a helper that dies while idle", async () => {
      vi.useFakeTimers();
      const census = new WindowsProcessCensus();
      const first = census.request();
      respond(children[0], "[]");
      await first;

      children[0].emit("exit", 0, null);

      // Nothing failed, so nothing is on the ladder: the next census starts a
      // replacement immediately rather than entering a cooldown later.
      const second = census.request();
      respond(children[1], "[]");
      expect(await second).toBe("[]");
    });

    it("suppresses launches after consecutive failures, then recovers", async () => {
      vi.useFakeTimers();
      const census = new WindowsProcessCensus();

      for (let i = 0; i < CENSUS_FAILURES_BEFORE_COOLDOWN; i++) {
        const pending = census.request();
        children[i].emit("exit", 1, null);
        await expect(pending).rejects.toThrow();
      }

      const spawnsBefore = mockSpawn.mock.calls.length;
      await expect(census.request()).rejects.toThrow(/cooling down/);
      // The point of the cooldown is that a broken machine costs no starts.
      expect(mockSpawn.mock.calls.length).toBe(spawnsBefore);

      await vi.advanceTimersByTimeAsync(15_000);
      const recovered = census.request();
      respond(children[children.length - 1], "[]");
      expect(await recovered).toBe("[]");

      // A success clears the streak, so the next fault starts from the top of
      // the ladder rather than the ceiling.
      const after = census.request();
      children[children.length - 1].emit("exit", 1, null);
      await expect(after).rejects.toThrow(/exited/);
      const retry = census.request();
      respond(children[children.length - 1], "[]");
      expect(await retry).toBe("[]");
    });

    it("rejects on an asynchronous child error event", async () => {
      // spawn() can succeed and then emit ENOENT, which is a different code
      // path from the synchronous throw below.
      const census = new WindowsProcessCensus();
      const pending = census.request();

      children[0].emit("error", new Error("spawn powershell.exe ENOENT"));

      await expect(pending).rejects.toThrow(/ENOENT/);
      expect(census.isRunning).toBe(false);
    });

    it("survives a stdin error arriving after the helper was retired", async () => {
      // The teardown race this closes: detaching stdin's error handler a beat
      // before end()/kill() lets a queued EPIPE become an unhandled 'error',
      // and the pty-host's uncaughtException handler exits — taking every
      // terminal with it.
      const census = new WindowsProcessCensus();
      const pending = census.request();
      respond(children[0], "[]");
      await pending;

      census.dispose();

      expect(() => children[0].stdin.emit("error", new Error("EPIPE"))).not.toThrow();
      expect(() => children[0].emit("error", new Error("EPIPE"))).not.toThrow();
    });

    it("does not charge a late frame from a retired helper to its replacement", async () => {
      const census = new WindowsProcessCensus();
      const first = census.request();
      respond(children[0], "[]");
      await first;
      expect(census.retireIfIdle()).toBe(true);

      const second = census.request();
      // The retired child's stream is still live in this fake; a frame from it
      // must not resolve — or retire — the request the replacement is serving.
      children[0].stdout.emit("data", `[]\n${CENSUS_SENTINEL_PREFIX}2\n`);
      expect(census.isRunning).toBe(true);

      respond(children[1], '[{"ProcessId":7}]');
      expect(await second).toBe('[{"ProcessId":7}]');
    });

    it("walks the cooldown ladder at its published boundaries", async () => {
      vi.useFakeTimers();
      const census = new WindowsProcessCensus();

      const failOnce = async (): Promise<void> => {
        const pending = census.request();
        children[children.length - 1].emit("exit", 1, null);
        await expect(pending).rejects.toThrow();
      };

      for (let i = 0; i < CENSUS_FAILURES_BEFORE_COOLDOWN; i++) await failOnce();

      // 15s, then 30s, then the 60s ceiling — each checked just short of the
      // boundary and again at it, so a constant delay of any single length
      // cannot satisfy the whole ladder.
      for (const expectedMs of [
        CENSUS_COOLDOWN_BASE_MS,
        CENSUS_COOLDOWN_BASE_MS * 2,
        CENSUS_COOLDOWN_CEILING_MS,
        CENSUS_COOLDOWN_CEILING_MS,
      ]) {
        await vi.advanceTimersByTimeAsync(expectedMs - 1);
        await expect(census.request()).rejects.toThrow(/cooling down/);
        await vi.advanceTimersByTimeAsync(1);
        await failOnce();
      }
    });

    it("does not let an idle death alone push the helper toward a cooldown", async () => {
      vi.useFakeTimers();
      const census = new WindowsProcessCensus();
      const first = census.request();
      respond(children[0], "[]");
      await first;

      // Nothing was outstanding, so this is not a failure and must not be
      // charged. Two real failures after it are still below the threshold.
      children[0].emit("exit", 0, null);
      for (let i = 0; i < CENSUS_FAILURES_BEFORE_COOLDOWN - 1; i++) {
        const pending = census.request();
        children[children.length - 1].emit("exit", 1, null);
        await expect(pending).rejects.toThrow();
      }

      const recovered = census.request();
      respond(children[children.length - 1], "[]");
      expect(await recovered).toBe("[]");
    });

    it("charges a synchronous spawn failure to the same ladder", async () => {
      mockSpawn.mockImplementation(() => {
        throw new Error("spawn powershell.exe ENOENT");
      });
      const census = new WindowsProcessCensus();

      for (let i = 0; i < CENSUS_FAILURES_BEFORE_COOLDOWN; i++) {
        await expect(census.request()).rejects.toThrow(/ENOENT/);
      }
      await expect(census.request()).rejects.toThrow(/cooling down/);
    });

    it("rejects a request when the write to stdin throws", async () => {
      const census = new WindowsProcessCensus();
      mockSpawn.mockImplementationOnce(() => {
        const child = makeChild(9999);
        children.push(child);
        child.stdin.write = vi.fn(() => {
          throw new Error("EPIPE");
        });
        return child;
      });

      await expect(census.request()).rejects.toThrow(/EPIPE/);
      expect(census.isRunning).toBe(false);
    });

    it("refuses a second concurrent request", async () => {
      const census = new WindowsProcessCensus();
      const first = census.request();

      await expect(census.request()).rejects.toThrow(/already serving/);

      respond(children[0], "[]");
      await first;
    });
  });

  describe("retirement", () => {
    it("retires an idle helper and starts a fresh one on the next census", async () => {
      const census = new WindowsProcessCensus();
      const first = census.request();
      respond(children[0], "[]");
      await first;

      expect(census.retireIfIdle()).toBe(true);
      expect(census.isRunning).toBe(false);
      expect(children[0].stdin.end).toHaveBeenCalled();
      expect(children[0].kill).toHaveBeenCalled();

      const second = census.request();
      respond(children[1], "[]");
      expect(await second).toBe("[]");
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it("refuses to retire while a census is in flight", async () => {
      const census = new WindowsProcessCensus();
      const pending = census.request();

      expect(census.retireIfIdle()).toBe(false);
      expect(census.isRunning).toBe(true);

      respond(children[0], "[]");
      await pending;
    });

    it("reports no retirement when nothing is running", () => {
      expect(new WindowsProcessCensus().retireIfIdle()).toBe(false);
    });

    it("exposes the live helper PID and drops it on retirement", async () => {
      const census = new WindowsProcessCensus();
      expect(census.pid).toBeNull();

      const pending = census.request();
      expect(census.pid).toBe(children[0].pid);
      respond(children[0], "[]");
      await pending;

      census.retireIfIdle();
      expect(census.pid).toBeNull();
    });

    it("dispose rejects the in-flight census, kills the helper, and stays down", async () => {
      const census = new WindowsProcessCensus();
      const pending = census.request();

      census.dispose();

      await expect(pending).rejects.toThrow(/disposed/);
      expect(children[0].kill).toHaveBeenCalled();
      await expect(census.request()).rejects.toThrow(/disposed/);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it("dispose is safe with no helper running", () => {
      const census = new WindowsProcessCensus();
      expect(() => {
        census.dispose();
        census.dispose();
      }).not.toThrow();
    });
  });
});
