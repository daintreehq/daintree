import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advertRecordPath,
  clearAdvertRecord,
  reapOrphanedAdvert,
  saveAdvertRecord,
  type AdvertRecordDeps,
} from "../advertRecord.js";

const FILE = "dns-sd";
const ARGS = ["-R", "studio", "_daintree._tcp", "local", "22"];

let dir: string;
let alive: Map<number, { startTime: string; argv: string[] }>;
let signals: Array<[number, NodeJS.Signals | 0]>;
let timers: Array<() => void>;

function deps(overrides: Partial<AdvertRecordDeps> = {}): AdvertRecordDeps {
  return {
    platform: "linux",
    ownerPid: 500,
    startTime: (pid) => alive.get(pid)?.startTime ?? null,
    argv: (pid) => alive.get(pid)?.argv ?? null,
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      if (!alive.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
    setTimer: (fn) => {
      timers.push(fn);
    },
    ...overrides,
  };
}

// The launch that crashed: owner 100 spawned advert 200.
function recordOrphan(): void {
  alive.set(100, { startTime: "10", argv: ["daintree"] });
  alive.set(200, { startTime: "20", argv: [FILE, ...ARGS] });
  expect(saveAdvertRecord(dir, { pid: 200, file: FILE, args: ARGS }, deps({ ownerPid: 100 }))).toBe(
    true
  );
  alive.delete(100);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "advert-record-"));
  alive = new Map();
  signals = [];
  timers = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("reapOrphanedAdvert", () => {
  it("ends the advert a crashed launch left running, then drops the record", () => {
    recordOrphan();
    reapOrphanedAdvert(dir, deps());
    expect(signals).toContainEqual([200, "SIGTERM"]);
    expect(fs.existsSync(advertRecordPath(dir))).toBe(false);
  });

  it("escalates to SIGKILL only if the same process is still there", () => {
    recordOrphan();
    reapOrphanedAdvert(dir, deps());
    timers[0]!();
    expect(signals).toContainEqual([200, "SIGKILL"]);

    signals.length = 0;
    recordOrphan();
    reapOrphanedAdvert(dir, deps());
    alive.set(200, { startTime: "99", argv: ["other"] });
    timers[1]!();
    expect(signals.filter(([, s]) => s === "SIGKILL")).toEqual([]);
  });

  it("signals nothing when the pid now belongs to another process", () => {
    recordOrphan();
    alive.set(200, { startTime: "999", argv: [FILE, ...ARGS] });
    reapOrphanedAdvert(dir, deps());
    expect(signals.filter(([, s]) => s !== 0)).toEqual([]);
    expect(fs.existsSync(advertRecordPath(dir))).toBe(false);
  });

  it("signals nothing when another program's dns-sd has the pid and start time", () => {
    recordOrphan();
    alive.set(200, { startTime: "20", argv: [FILE, "-R", "Printer", "_ipp._tcp", "local", "631"] });
    reapOrphanedAdvert(dir, deps());
    expect(signals.filter(([, s]) => s !== 0)).toEqual([]);
  });

  it("signals nothing when the start time was never recorded", () => {
    alive.set(200, { startTime: "20", argv: [FILE, ...ARGS] });
    saveAdvertRecord(dir, { pid: 200, file: FILE, args: ARGS }, deps({ startTime: () => null }));
    reapOrphanedAdvert(dir, deps());
    expect(signals.filter(([, s]) => s !== 0)).toEqual([]);
  });

  it("leaves a live host's advert and record alone", () => {
    recordOrphan();
    alive.set(100, { startTime: "10", argv: ["daintree"] });
    reapOrphanedAdvert(dir, deps());
    expect(signals.filter(([, s]) => s !== 0)).toEqual([]);
    expect(fs.existsSync(advertRecordPath(dir))).toBe(true);
  });

  it("treats a reused owner pid as a dead owner", () => {
    recordOrphan();
    alive.set(100, { startTime: "77", argv: ["something-else"] });
    reapOrphanedAdvert(dir, deps());
    expect(signals).toContainEqual([200, "SIGTERM"]);
  });

  it("leaves this process's own record alone", () => {
    alive.set(500, { startTime: "5", argv: ["daintree"] });
    alive.set(200, { startTime: "20", argv: [FILE, ...ARGS] });
    saveAdvertRecord(dir, { pid: 200, file: FILE, args: ARGS }, deps());
    reapOrphanedAdvert(dir, deps());
    expect(signals).toEqual([]);
    expect(fs.existsSync(advertRecordPath(dir))).toBe(true);
  });

  it("drops a malformed record without signalling", () => {
    fs.writeFileSync(advertRecordPath(dir), "{not json");
    reapOrphanedAdvert(dir, deps());
    expect(signals).toEqual([]);
    expect(fs.existsSync(advertRecordPath(dir))).toBe(false);
  });

  it("matches the joined command line on macOS", () => {
    recordOrphan();
    const mac = deps({
      platform: "darwin",
      argv: (pid) => (pid === 200 ? [[FILE, ...ARGS].join(" ")] : null),
    });
    reapOrphanedAdvert(dir, mac);
    expect(signals).toContainEqual([200, "SIGTERM"]);
  });

  it("does nothing on platforms with no advert", () => {
    recordOrphan();
    reapOrphanedAdvert(dir, deps({ platform: "win32" }));
    expect(signals).toEqual([]);
    expect(fs.existsSync(advertRecordPath(dir))).toBe(true);
  });
});

describe("advert record file", () => {
  it("clears only the record that names the pid", () => {
    recordOrphan();
    clearAdvertRecord(dir, 201);
    expect(fs.existsSync(advertRecordPath(dir))).toBe(true);
    clearAdvertRecord(dir, 200);
    expect(fs.existsSync(advertRecordPath(dir))).toBe(false);
  });

  it("records nothing for a spawn that has no pid", () => {
    expect(saveAdvertRecord(dir, { pid: 0, file: FILE, args: ARGS }, deps())).toBe(false);
    expect(fs.existsSync(advertRecordPath(dir))).toBe(false);
  });
});

void vi;
