import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectViewLifecyclePhase } from "@/lib/viewCacheState";

const viewCache = vi.hoisted(() => ({
  cached: false,
  listeners: new Set<(phase: ProjectViewLifecyclePhase) => void>(),
}));

vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewCached: () => viewCache.cached,
  subscribeProjectViewLifecycle: (listener: (phase: ProjectViewLifecyclePhase) => void) => {
    viewCache.listeners.add(listener);
    return () => viewCache.listeners.delete(listener);
  },
}));

import type { AuthorityRequest, AuthorityResponse, AuthorityTransport } from "../parseTransport";
import { WorkerParseSession } from "../WorkerParseSession";

function emit(phase: ProjectViewLifecyclePhase): void {
  viewCache.cached = phase === "cached";
  for (const listener of Array.from(viewCache.listeners)) listener(phase);
}

// Answers every snapshot request at once (with no snapshot), so a tick settles
// and the next cadence step is free to request again.
function makeTransport() {
  const sent: AuthorityRequest[] = [];
  let respond: ((response: AuthorityResponse) => void) | null = null;
  const transport: AuthorityTransport = {
    send: (request) => {
      sent.push(request);
      if (request.type === "snapshot") {
        respond?.({ type: "snapshot", requestId: request.requestId, snapshot: null });
      }
    },
    onResponse: (listener) => {
      respond = listener;
      return () => {
        respond = null;
      };
    },
    dispose: vi.fn(),
  };
  const snapshotRequests = () => sent.filter((request) => request.type === "snapshot").length;
  return { transport, snapshotRequests };
}

describe("WorkerParseSession cadence in a cached project view (#12514)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    viewCache.cached = false;
    viewCache.listeners.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops repainting the mirror while cached and catches up once on reactivation", async () => {
    const { transport, snapshotRequests } = makeTransport();
    const session = new WorkerParseSession(
      transport,
      { write: vi.fn() },
      {
        cols: 80,
        rows: 24,
        scrollback: 1000,
        cadenceMs: 100,
      }
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(snapshotRequests()).toBe(1);

    emit("cached");
    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshotRequests()).toBe(1);

    emit("active");
    // One immediate catch-up, then the cadence resumes; `revealed` right after
    // `active` must not add a second catch-up.
    emit("revealed");
    expect(snapshotRequests()).toBe(2);

    session.dispose();
  });

  it("never starts a cadence for a session created while cached", async () => {
    viewCache.cached = true;
    const { transport, snapshotRequests } = makeTransport();
    const session = new WorkerParseSession(
      transport,
      { write: vi.fn() },
      {
        cols: 80,
        rows: 24,
        scrollback: 1000,
        cadenceMs: 100,
      }
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshotRequests()).toBe(0);

    session.dispose();
  });

  it("drops its lifecycle subscription on dispose", () => {
    const { transport } = makeTransport();
    const session = new WorkerParseSession(
      transport,
      { write: vi.fn() },
      {
        cols: 80,
        rows: 24,
        scrollback: 1000,
      }
    );
    expect(viewCache.listeners.size).toBe(1);

    session.dispose();

    expect(viewCache.listeners.size).toBe(0);
  });
});
