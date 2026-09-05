import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
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
      expect(script).toContain("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
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

    it("ignores a response framed for a different request id", async () => {
      vi.useFakeTimers();
      const census = new WindowsProcessCensus();
      const pending = census.request();

      children[0].stdout.emit("data", `[]\n${CENSUS_SENTINEL_PREFIX}999\n`);

      const settled = vi.fn();
      void pending.then(settled, settled);
      await Promise.resolve();
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
