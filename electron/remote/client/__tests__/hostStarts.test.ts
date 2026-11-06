import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../../utils/errorTypes.js";
import { HostStarts, type HostStartEvent } from "../hostStarts.js";
import { TransportError, type LinkOpenOptions, type LinkTransport } from "../transport.js";

const studio = { kind: "ssh", target: "studio" } as const;
const signal = () => new AbortController().signal;

describe("HostStarts", () => {
  it("never reads as starting while a host is only checked on, whatever the check finds", async () => {
    for (const outcome of ["not-startable", "listening"] as const) {
      let answer!: () => void;
      const changes: string[] = [];
      const starts = new HostStarts({
        setup: {
          ensureHostRunning: () =>
            new Promise((resolve) => {
              answer = () => resolve(outcome);
            }),
        },
        onChange: (hostId) => changes.push(hostId),
      });
      const ensuring = starts.ensureRunning("studio-01", studio, signal());
      expect(starts.isStarting("studio-01")).toBe(false);
      expect(starts.isAttempting("studio-01")).toBe(true);
      answer();
      await expect(ensuring).resolves.toBe(outcome === "listening");
      expect(starts.isStarting("studio-01")).toBe(false);
      expect(starts.isAttempting("studio-01")).toBe(false);
      expect(changes).toEqual([]);
    }
  });

  it("stops attempting when a check fails before any start", async () => {
    const changes: string[] = [];
    const starts = new HostStarts({
      setup: {
        ensureHostRunning: async () => {
          throw new Error("ssh went away");
        },
      },
      onChange: (hostId) => changes.push(hostId),
    });
    await expect(starts.ensureRunning("studio-01", studio, signal())).rejects.toBeInstanceOf(
      TransportError
    );
    expect(starts.isAttempting("studio-01")).toBe(false);
    expect(starts.isStarting("studio-01")).toBe(false);
    expect(changes).toEqual([]);
  });

  it("counts as attempting while only checking on the host, and as starting only from the start", async () => {
    let check!: () => void;
    let finish!: () => void;
    const starts = new HostStarts({
      setup: {
        async ensureHostRunning(_connection, _signal, onStart) {
          await new Promise<void>((resolve) => (check = resolve));
          onStart?.();
          await new Promise<void>((resolve) => (finish = resolve));
          return "started";
        },
      },
      onChange: () => {},
    });
    const ensuring = starts.ensureRunning("studio-01", studio, signal());
    expect(starts.isAttempting("studio-01")).toBe(true);
    expect(starts.isStarting("studio-01")).toBe(false);
    check();
    await vi.waitFor(() => expect(starts.isStarting("studio-01")).toBe(true));
    expect(starts.isAttempting("studio-01")).toBe(true);
    finish();
    await expect(ensuring).resolves.toBe(true);
    expect(starts.isAttempting("studio-01")).toBe(false);
    expect(starts.isStarting("studio-01")).toBe(false);
  });

  it("stays starting until the last of two overlapping starts settles", async () => {
    const finishes: Array<() => void> = [];
    const starts = new HostStarts({
      setup: {
        async ensureHostRunning(_connection, _signal, onStart) {
          onStart?.();
          await new Promise<void>((resolve) => finishes.push(resolve));
          return "started";
        },
      },
      onChange: () => {},
    });
    const first = starts.ensureRunning("studio-01", studio, signal());
    const second = starts.ensureRunning("studio-01", studio, signal());
    finishes[0]!();
    await first;
    expect(starts.isStarting("studio-01")).toBe(true);
    expect(starts.isAttempting("studio-01")).toBe(true);
    finishes[1]!();
    await second;
    expect(starts.isStarting("studio-01")).toBe(false);
    expect(starts.isAttempting("studio-01")).toBe(false);
  });

  it("reads as starting from the start command until it settles, however it ends", async () => {
    for (const ending of ["started", "failed"] as const) {
      let finish!: () => void;
      const seen: boolean[] = [];
      const starts: HostStarts = new HostStarts({
        setup: {
          async ensureHostRunning(_connection, _signal, onStart) {
            onStart?.();
            await new Promise<void>((resolve) => (finish = resolve));
            if (ending === "failed") {
              throw new AppError({
                code: "INTERNAL",
                message: "no session",
                userMessage: "Log in on studio",
              });
            }
            return "started";
          },
        },
        onChange: (hostId) => seen.push(starts.isStarting(hostId)),
      });
      const ensuring = starts.ensureRunning("studio-01", studio, signal());
      expect(starts.isStarting("studio-01")).toBe(true);
      expect(starts.isStarting("mini-02")).toBe(false);
      finish();
      if (ending === "started") {
        await expect(ensuring).resolves.toBe(true);
      } else {
        const error = await ensuring.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(TransportError);
        expect(error).toMatchObject({ detail: "Log in on studio" });
      }
      expect(starts.isStarting("studio-01")).toBe(false);
      expect(starts.isAttempting("studio-01")).toBe(false);
      expect(seen).toEqual([true, false]);
    }
  });

  it("lets a dial start the host only while someone asks for it back (#16170)", async () => {
    const opened: Array<LinkOpenOptions | undefined> = [];
    const inner: LinkTransport = {
      open: async (_signal, options) => {
        opened.push(options);
        throw new Error("no Daintree serving");
      },
    };
    const explicit: boolean[] = [];
    const starts = new HostStarts({
      setup: {
        ensureHostRunning: async (_connection, _signal, _onStart, options) => {
          explicit.push(options?.explicit === true);
          return "listening";
        },
      },
      onChange: () => {},
    });
    const transport = starts.transport("studio-01", inner);
    await transport.open(signal(), { mayStart: false }).catch(() => undefined);
    const release = starts.allowExplicit("studio-01");
    const second = starts.allowExplicit("studio-01");
    await transport.open(signal(), { mayStart: false, fresh: true }).catch(() => undefined);
    await starts.ensureRunning("studio-01", studio, signal());
    // Another host is no one's ask.
    await starts
      .transport("mini", inner)
      .open(signal(), { mayStart: false })
      .catch(() => undefined);
    release();
    release();
    expect(starts.isExplicit("studio-01")).toBe(true);
    second();
    await starts.ensureRunning("studio-01", studio, signal());
    expect(starts.isExplicit("studio-01")).toBe(false);
    expect(opened).toEqual([
      { mayStart: false },
      { mayStart: true, fresh: true },
      { mayStart: false },
    ]);
    expect(explicit).toEqual([true, false]);
  });

  it("tells its observers what each check and start came to, as it happens", async () => {
    const events: HostStartEvent[] = [];
    const outcomes: Array<() => Promise<"listening" | "started" | "not-startable">> = [
      async () => "started",
      async () => "not-startable",
      async () => {
        throw new AppError({
          code: "INTERNAL",
          message: "exit 1",
          userMessage: "Couldn't start Daintree on studio. Log in there",
        });
      },
    ];
    const starts = new HostStarts({
      setup: {
        ensureHostRunning: async (_connection, _signal, onStart, options) => {
          const next = outcomes.shift()!;
          onStart?.();
          if (outcomes.length === 1) options?.onRefused?.("host-mode-off");
          return next();
        },
      },
      onChange: () => {},
    });
    const off = starts.observe("studio-01", (event) => events.push(event));
    await starts.ensureRunning("studio-01", studio, signal());
    await starts.ensureRunning("studio-01", studio, signal());
    await expect(starts.ensureRunning("studio-01", studio, signal())).rejects.toThrow(
      "Log in there"
    );
    off();
    await starts.ensureRunning("studio-01", studio, signal()).catch(() => undefined);
    expect(events).toEqual([
      { kind: "checking" },
      { kind: "start-requested" },
      { kind: "running", started: true },
      { kind: "checking" },
      { kind: "start-requested" },
      { kind: "refused", refusal: "host-mode-off" },
      { kind: "checking" },
      { kind: "start-requested" },
      { kind: "failed", reason: "Couldn't start Daintree on studio. Log in there" },
    ]);
  });

  it("says nothing of a check whose dial was abandoned, whatever it comes to", async () => {
    const events: HostStartEvent[] = [];
    const finishes: Array<() => void> = [];
    const starts = new HostStarts({
      setup: {
        ensureHostRunning: async (_connection, _signal, onStart, options) => {
          const call = finishes.length;
          await new Promise<void>((resolve) => finishes.push(resolve));
          // What a check that ran on regardless would report.
          onStart?.();
          options?.onRefused?.("host-mode-off");
          if (call === 1) throw new Error("ssh went away");
          return "started";
        },
      },
      onChange: () => {},
    });
    starts.observe("studio-01", (event) => events.push(event));
    const first = new AbortController();
    const started = starts.ensureRunning("studio-01", studio, first.signal);
    const second = new AbortController();
    const failed = starts.ensureRunning("studio-01", studio, second.signal);
    expect(events).toEqual([{ kind: "checking" }, { kind: "checking" }]);
    first.abort();
    second.abort();
    for (const finish of finishes) finish();
    await started;
    await failed.catch(() => undefined);
    expect(events).toEqual([{ kind: "checking" }, { kind: "checking" }]);
  });
});
