import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerExitCleanupHandlers, __resetExitCleanupHandlersForTest } from "../launch";

// Guards the #10566 orphan-reaping wiring: the harness reaps leaked e2e
// Electron helpers when a worker is killed mid-launch (CI timeout / Ctrl+C).
// These tests assert the registration is correct and idempotent. They never
// emit the signals — the handlers call process.exit(), which would tear down
// the vitest worker — so behavior is checked via listener bookkeeping only.

type SignalListener = NodeJS.SignalsListener;

let sigintBaseline: SignalListener[];
let sigtermBaseline: SignalListener[];

beforeEach(() => {
  __resetExitCleanupHandlersForTest();
  sigintBaseline = process.listeners("SIGINT") as SignalListener[];
  sigtermBaseline = process.listeners("SIGTERM") as SignalListener[];
});

afterEach(() => {
  // Remove only the listeners our code added; leave any pre-existing ones
  // (e.g. the test runner's own) intact.
  for (const l of process.listeners("SIGINT") as SignalListener[]) {
    if (!sigintBaseline.includes(l)) process.removeListener("SIGINT", l);
  }
  for (const l of process.listeners("SIGTERM") as SignalListener[]) {
    if (!sigtermBaseline.includes(l)) process.removeListener("SIGTERM", l);
  }
  __resetExitCleanupHandlersForTest();
});

describe("registerExitCleanupHandlers", () => {
  it("registers exactly one SIGINT and one SIGTERM handler", () => {
    registerExitCleanupHandlers();
    expect(process.listenerCount("SIGINT")).toBe(sigintBaseline.length + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBaseline.length + 1);
  });

  it("is idempotent — repeated calls do not stack listeners", () => {
    registerExitCleanupHandlers();
    const sigintAfterFirst = process.listenerCount("SIGINT");
    const sigtermAfterFirst = process.listenerCount("SIGTERM");

    registerExitCleanupHandlers();
    registerExitCleanupHandlers();

    expect(process.listenerCount("SIGINT")).toBe(sigintAfterFirst);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermAfterFirst);
  });

  it("re-registers after the guard is reset", () => {
    registerExitCleanupHandlers();
    __resetExitCleanupHandlersForTest();
    // Drop the first registration's listeners so we measure a clean delta.
    for (const l of process.listeners("SIGINT") as SignalListener[]) {
      if (!sigintBaseline.includes(l)) process.removeListener("SIGINT", l);
    }
    for (const l of process.listeners("SIGTERM") as SignalListener[]) {
      if (!sigtermBaseline.includes(l)) process.removeListener("SIGTERM", l);
    }

    registerExitCleanupHandlers();
    expect(process.listenerCount("SIGINT")).toBe(sigintBaseline.length + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBaseline.length + 1);
  });
});
