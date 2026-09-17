import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetCdpLeasesForTests,
  acquireCdpLease,
  isCdpDomainEnabled,
} from "../WebContentsCdpService.js";

const WEB_CONTENTS_ID = 7;
const MAIN_FRAME_ID = "frame-main";

class FakeDebugger extends EventEmitter {
  readonly commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  attached = false;
  readonly rejects = new Map<string, Error>();
  /** Holds a command until the promise settles, to open a race window. */
  readonly gates = new Map<string, Promise<void>>();

  isAttached(): boolean {
    return this.attached;
  }
  attach(): void {
    this.attached = true;
  }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params });
    const gate = this.gates.get(method);
    if (gate) await gate;
    const failure = this.rejects.get(method);
    if (failure) throw failure;
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: MAIN_FRAME_ID } } };
    }
    return {};
  }
  methods(): string[] {
    return this.commands.map((c) => c.method);
  }
  count(method: string): number {
    return this.methods().filter((m) => m === method).length;
  }
}

class FakeWebContents extends EventEmitter {
  readonly id = WEB_CONTENTS_ID;
  readonly debugger = new FakeDebugger();
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function makeWebContents(): FakeWebContents {
  return new FakeWebContents();
}

function asWebContents(wc: FakeWebContents): Electron.WebContents {
  return wc as unknown as Electron.WebContents;
}

function createdContext(id: number, frameId: string | undefined, isDefault = true) {
  return { context: { id, auxData: { isDefault, frameId } } };
}

describe("WebContentsCdpService", () => {
  let wc: FakeWebContents;

  beforeEach(() => {
    __resetCdpLeasesForTests();
    wc = makeWebContents();
  });

  afterEach(() => {
    __resetCdpLeasesForTests();
  });

  it("attaches once and enables a domain only for the first holder", async () => {
    const first = await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    const second = await acquireCdpLease(asWebContents(wc), ["Runtime", "Log"]);

    expect(wc.debugger.attached).toBe(true);
    expect(wc.debugger.count("Runtime.enable")).toBe(1);
    expect(wc.debugger.count("Log.enable")).toBe(1);
    expect(isCdpDomainEnabled(WEB_CONTENTS_ID, "Runtime")).toBe(true);
    expect(first.webContentsId).toBe(WEB_CONTENTS_ID);
    expect(second.invalidated).toBe(false);
  });

  it("keeps a domain enabled while another consumer still holds it", async () => {
    const consoleLease = await acquireCdpLease(asWebContents(wc), ["Runtime", "Log"]);
    const bridgeLease = await acquireCdpLease(asWebContents(wc), ["Page", "Runtime"]);

    await consoleLease.release();

    // The console pane's own domain goes off; the one the bridge shares stays on.
    expect(wc.debugger.methods()).toContain("Log.disable");
    expect(wc.debugger.methods()).not.toContain("Runtime.disable");
    expect(isCdpDomainEnabled(WEB_CONTENTS_ID, "Runtime")).toBe(true);

    await bridgeLease.release();
    expect(wc.debugger.methods()).toContain("Runtime.disable");
    expect(wc.debugger.methods()).toContain("Page.disable");
    expect(isCdpDomainEnabled(WEB_CONTENTS_ID, "Runtime")).toBe(false);
  });

  it("is idempotent on release and unbinds once the last lease goes", async () => {
    const lease = await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    await lease.release();
    await lease.release();

    expect(wc.debugger.count("Runtime.disable")).toBe(1);
    expect(wc.debugger.listenerCount("message")).toBe(0);
    expect(wc.debugger.listenerCount("detach")).toBe(0);
  });

  it("tells only the acquisition that enables a domain that it did", async () => {
    const firstSeen: string[] = [];
    const secondSeen: string[] = [];
    const settled: string[] = [];

    await acquireCdpLease(asWebContents(wc), ["Runtime"], {
      onDomainEnable: (domain) => {
        firstSeen.push(domain);
        return () => settled.push(domain);
      },
    });
    await acquireCdpLease(asWebContents(wc), ["Runtime"], {
      onDomainEnable: (domain) => {
        secondSeen.push(domain);
      },
    });

    expect(firstSeen).toEqual(["Runtime"]);
    expect(settled).toEqual(["Runtime"]);
    expect(secondSeen).toEqual([]);
  });

  it("sends one enable when two acquisitions race", async () => {
    let release!: () => void;
    wc.debugger.gates.set(
      "Runtime.enable",
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );

    const both = Promise.all([
      acquireCdpLease(asWebContents(wc), ["Runtime"]),
      acquireCdpLease(asWebContents(wc), ["Runtime"]),
    ]);
    wc.debugger.gates.delete("Runtime.enable");
    release();
    const [a, b] = await both;

    // Two enables would mean two replays of the guest's buffered console traffic.
    expect(wc.debugger.count("Runtime.enable")).toBe(1);
    await a.release();
    expect(wc.debugger.methods()).not.toContain("Runtime.disable");
    await b.release();
    expect(wc.debugger.count("Runtime.disable")).toBe(1);
  });

  it("does not disable a domain re-acquired while the enable was still settling", async () => {
    const lease = await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    const releasing = lease.release();
    // A new pane arrives in the same turn the last one left.
    const next = await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    await releasing;

    expect(isCdpDomainEnabled(WEB_CONTENTS_ID, "Runtime")).toBe(true);
    expect(next.invalidated).toBe(false);
  });

  it("hands back no lease when the domain it had to enable fails", async () => {
    wc.debugger.rejects.set("Runtime.enable", new Error("Target closed"));

    await expect(acquireCdpLease(asWebContents(wc), ["Runtime"])).rejects.toThrow("Target closed");
    // No count left behind: the next acquisition retries the enable.
    wc.debugger.rejects.delete("Runtime.enable");
    await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    expect(wc.debugger.count("Runtime.enable")).toBe(2);
    expect(isCdpDomainEnabled(WEB_CONTENTS_ID, "Runtime")).toBe(true);
  });

  it("tracks default-world contexts and the frame that owns each", async () => {
    const lease = await acquireCdpLease(asWebContents(wc), ["Runtime"]);

    wc.debugger.emit("message", {}, "Runtime.executionContextCreated", createdContext(1, "f-main"));
    wc.debugger.emit("message", {}, "Runtime.executionContextCreated", createdContext(2, "f-ad"));
    // An isolated world is nobody's page.
    wc.debugger.emit(
      "message",
      {},
      "Runtime.executionContextCreated",
      createdContext(3, "f-main", false)
    );
    wc.debugger.emit("message", {}, "Runtime.executionContextDestroyed", {
      executionContextId: 2,
    });

    expect([...lease.contexts.keys()]).toEqual([1]);
    expect(lease.contexts.get(1)).toBe("f-main");

    wc.debugger.emit("message", {}, "Runtime.executionContextsCleared", {});
    expect(lease.contexts.size).toBe(0);
    expect(lease.navigationGeneration).toBe(1);
  });

  it("shares one snapshot with a consumer that arrives after the replay", async () => {
    const first = await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    wc.debugger.emit("message", {}, "Runtime.executionContextCreated", createdContext(1, "f-main"));

    // The late consumer's own enable is a no-op, so CDP replays nothing to it —
    // reading the shared snapshot is what replaces the disable/enable cycle.
    const late = await acquireCdpLease(asWebContents(wc), ["Page", "Runtime"]);
    expect(wc.debugger.count("Runtime.enable")).toBe(1);
    expect(late.contexts.get(1)).toBe("f-main");
    expect(first.contexts).toBe(late.contexts);
  });

  it("clears the snapshot when the Runtime domain goes off", async () => {
    const lease = await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    wc.debugger.emit("message", {}, "Runtime.executionContextCreated", createdContext(1, "f-main"));

    await lease.release();

    // Nothing reports contexts with the domain off, so a kept snapshot would
    // read as current.
    expect(lease.contexts.size).toBe(0);
  });

  it("holds the snapshot at the cap as a page spawns frames", async () => {
    const lease = await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    await lease.refreshMainFrameId();
    wc.debugger.emit(
      "message",
      {},
      "Runtime.executionContextCreated",
      createdContext(1, MAIN_FRAME_ID)
    );
    for (let i = 0; i < 200; i++) {
      wc.debugger.emit(
        "message",
        {},
        "Runtime.executionContextCreated",
        createdContext(100 + i, `f-${i}`)
      );
    }

    expect(lease.contexts.size).toBeLessThanOrEqual(64);
    expect(lease.contexts.get(1)).toBe(MAIN_FRAME_ID);
  });

  it("reads the main frame id from the frame tree on request", async () => {
    const lease = await acquireCdpLease(asWebContents(wc), ["Page", "Runtime"]);
    expect(lease.mainFrameId).toBeNull();

    await expect(lease.refreshMainFrameId()).resolves.toBe(MAIN_FRAME_ID);
    expect(lease.mainFrameId).toBe(MAIN_FRAME_ID);
  });

  it("invalidates every lease and notifies holders when the debugger detaches", async () => {
    const invalidated: string[] = [];
    const consoleLease = await acquireCdpLease(asWebContents(wc), ["Runtime"], {
      onInvalidated: () => invalidated.push("console"),
    });
    const bridgeLease = await acquireCdpLease(asWebContents(wc), ["Page", "Runtime"], {
      onInvalidated: () => invalidated.push("bridge"),
    });
    const before = wc.debugger.commands.length;

    wc.debugger.emit("detach", {}, "target closed");

    expect(invalidated.sort()).toEqual(["bridge", "console"]);
    expect(consoleLease.invalidated).toBe(true);
    expect(bridgeLease.invalidated).toBe(true);
    expect(isCdpDomainEnabled(WEB_CONTENTS_ID, "Runtime")).toBe(false);

    // Nothing is sent down a session that is gone, then or on the late release.
    await consoleLease.release();
    await bridgeLease.release();
    expect(wc.debugger.commands.length).toBe(before);
    expect(wc.debugger.listenerCount("message")).toBe(0);
  });

  it("invalidates its leases when the guest is destroyed", async () => {
    let notified = false;
    const lease = await acquireCdpLease(asWebContents(wc), ["Runtime"], {
      onInvalidated: () => {
        notified = true;
      },
    });

    wc.destroyed = true;
    wc.emit("destroyed");

    expect(notified).toBe(true);
    expect(lease.invalidated).toBe(true);
    await expect(lease.refreshMainFrameId()).resolves.toBeNull();
  });

  it("refuses a lease on a destroyed guest", async () => {
    wc.destroyed = true;
    await expect(acquireCdpLease(asWebContents(wc), ["Runtime"])).rejects.toThrow(/Target closed/);
  });

  it("re-attaches and re-enables after an invalidated session comes back", async () => {
    const lease = await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    wc.debugger.emit("detach", {}, "target closed");
    await lease.release();

    wc.debugger.attached = false;
    await acquireCdpLease(asWebContents(wc), ["Runtime"]);

    expect(wc.debugger.attached).toBe(true);
    expect(wc.debugger.count("Runtime.enable")).toBe(2);
  });

  it("keeps the entry alive until every in-flight release has finished", async () => {
    // Two consumers release at once. If the first release to finish retires the
    // entry, the second one's outstanding disable lands on whatever a fresh
    // acquisition has meanwhile enabled.
    const consoleLease = await acquireCdpLease(asWebContents(wc), ["Runtime", "Log"]);
    const bridgeLease = await acquireCdpLease(asWebContents(wc), ["Page", "Runtime"]);

    let releaseRuntime!: () => void;
    wc.debugger.gates.set(
      "Runtime.disable",
      new Promise<void>((resolve) => {
        releaseRuntime = resolve;
      })
    );

    const tracker = wc.debugger.listeners("message")[0];
    const consoleReleased = consoleLease.release();
    const bridgeReleased = bridgeLease.release();
    // The bridge flipped Runtime to off before parking on the gated command, so
    // the console side's own Runtime step returns at once and it finishes while
    // the bridge is still mid-teardown.
    await consoleReleased;
    const fresh = await acquireCdpLease(asWebContents(wc), ["Page"]);

    // Same entry, so the snapshot and the one context tracker survive the
    // overlap rather than being rebuilt under the release still running.
    expect(wc.debugger.listenerCount("message")).toBe(1);
    expect(wc.debugger.listeners("message")[0]).toBe(tracker);

    wc.debugger.gates.delete("Runtime.disable");
    releaseRuntime();
    await bridgeReleased;

    expect(isCdpDomainEnabled(WEB_CONTENTS_ID, "Page")).toBe(true);
    expect(wc.debugger.count("Page.disable")).toBe(0);
    await fresh.release();
    expect(wc.debugger.count("Page.disable")).toBe(1);
  });

  it("brackets the replay for a consumer that joins an enable already in flight", async () => {
    // One `Runtime.enable` is enough to replay the guest's buffer to every
    // listener, so a late joiner needs its own window or it reads the replay as
    // live traffic and duplicates rows the renderer still holds.
    let releaseEnable!: () => void;
    wc.debugger.gates.set(
      "Runtime.enable",
      new Promise<void>((resolve) => {
        releaseEnable = resolve;
      })
    );

    const opened: string[] = [];
    const closed: string[] = [];
    const first = acquireCdpLease(asWebContents(wc), ["Runtime"]);
    const joiner = acquireCdpLease(asWebContents(wc), ["Runtime"], {
      onDomainEnable: (domain) => {
        opened.push(domain);
        return () => closed.push(domain);
      },
    });

    expect(opened).toEqual(["Runtime"]);
    expect(closed).toEqual([]);

    wc.debugger.gates.delete("Runtime.enable");
    releaseEnable();
    await Promise.all([first, joiner]);

    expect(wc.debugger.count("Runtime.enable")).toBe(1);
    expect(closed).toEqual(["Runtime"]);
  });

  it("does not bracket a consumer that finds the domain already enabled", async () => {
    await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    const opened: string[] = [];
    await acquireCdpLease(asWebContents(wc), ["Runtime"], {
      onDomainEnable: (domain) => {
        opened.push(domain);
      },
    });
    expect(opened).toEqual([]);
  });

  it("never spends the main frame's context on the tracking cap", async () => {
    const lease = await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    // The main frame announces its world before anyone has read the frame tree,
    // which is the ordering console capture produces.
    wc.debugger.emit(
      "message",
      {},
      "Runtime.executionContextCreated",
      createdContext(1, MAIN_FRAME_ID)
    );
    for (let i = 0; i < 200; i++) {
      wc.debugger.emit(
        "message",
        {},
        "Runtime.executionContextCreated",
        createdContext(100 + i, `f-${i}`)
      );
    }
    await lease.refreshMainFrameId();

    // Evicting instead of refusing would have dropped the main frame's entry
    // here, and the bridge would reject the real page for the rest of the
    // document's life — no further replay ever repairs the snapshot.
    expect(lease.contexts.get(1)).toBe(MAIN_FRAME_ID);
    expect(lease.contexts.size).toBeLessThanOrEqual(64);
  });

  it("keeps the main frame's world when the cap is already full", async () => {
    const lease = await acquireCdpLease(asWebContents(wc), ["Page", "Runtime"]);
    await lease.refreshMainFrameId();
    for (let i = 0; i < 80; i++) {
      wc.debugger.emit(
        "message",
        {},
        "Runtime.executionContextCreated",
        createdContext(200 + i, `f-${i}`)
      );
    }
    wc.debugger.emit(
      "message",
      {},
      "Runtime.executionContextCreated",
      createdContext(9, MAIN_FRAME_ID)
    );

    expect(lease.contexts.get(9)).toBe(MAIN_FRAME_ID);
  });

  it("keeps a domain it failed to switch off recorded as on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lease = await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    wc.debugger.emit("message", {}, "Runtime.executionContextCreated", createdContext(1, "f-main"));
    wc.debugger.rejects.set("Runtime.disable", new Error("something unexpected"));

    await lease.release();

    // The guest still has Runtime on, so a second `Runtime.enable` would be a
    // no-op that replays nothing — and a consumer waiting on that replay for
    // its contexts would wait forever.
    expect(isCdpDomainEnabled(WEB_CONTENTS_ID, "Runtime")).toBe(true);
    expect(lease.contexts.get(1)).toBe("f-main");

    const next = await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    expect(wc.debugger.count("Runtime.enable")).toBe(1);
    expect(next.contexts.get(1)).toBe("f-main");
    warn.mockRestore();
  });

  it("refuses the lease when the session is lost while an enable waits its turn", async () => {
    // A start can queue its enable behind another holder's disable. If the
    // debugger detaches in that window the lease is already dead, and handing it
    // back would let the caller store it and skip every later acquisition.
    const first = await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    let releaseDisable!: () => void;
    wc.debugger.gates.set(
      "Runtime.disable",
      new Promise<void>((resolve) => {
        releaseDisable = resolve;
      })
    );
    const releasing = first.release();

    const queued = acquireCdpLease(asWebContents(wc), ["Runtime"]);
    const settled = queued.then(
      () => "resolved",
      () => "rejected"
    );
    wc.debugger.emit("detach", {}, "target closed");
    wc.debugger.gates.delete("Runtime.disable");
    releaseDisable();
    await releasing;

    await expect(settled).resolves.toBe("rejected");
  });

  it("admits the main frame's world announced after the cap is full", async () => {
    // Replay order is creation order, so a document that already had many
    // frames can present them before the world the bridge actually cares about.
    const lease = await acquireCdpLease(asWebContents(wc), ["Page", "Runtime"]);
    for (let i = 0; i < 80; i++) {
      wc.debugger.emit(
        "message",
        {},
        "Runtime.executionContextCreated",
        createdContext(300 + i, `f-${i}`)
      );
    }
    wc.debugger.emit(
      "message",
      {},
      "Runtime.executionContextCreated",
      createdContext(5, MAIN_FRAME_ID)
    );
    await lease.refreshMainFrameId();

    expect(lease.contexts.get(5)).toBe(MAIN_FRAME_ID);
    expect(lease.contexts.size).toBeLessThanOrEqual(64);
  });

  it("never evicts the first world seen, before the frame tree is known", async () => {
    const lease = await acquireCdpLease(asWebContents(wc), ["Runtime"]);
    wc.debugger.emit(
      "message",
      {},
      "Runtime.executionContextCreated",
      createdContext(1, MAIN_FRAME_ID)
    );
    for (let i = 0; i < 200; i++) {
      wc.debugger.emit(
        "message",
        {},
        "Runtime.executionContextCreated",
        createdContext(400 + i, `f-${i}`)
      );
    }

    // `mainFrameId` is still null here, so the first world is the only thing
    // standing in for it.
    expect(lease.mainFrameId).toBeNull();
    expect(lease.contexts.get(1)).toBe(MAIN_FRAME_ID);
  });

  it("does not let a context-tracking failure escape into the debugger emit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await acquireCdpLease(asWebContents(wc), ["Runtime"]);

    expect(() =>
      wc.debugger.emit("message", {}, "Runtime.executionContextCreated", {
        get context() {
          throw new Error("hostile getter");
        },
      })
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
