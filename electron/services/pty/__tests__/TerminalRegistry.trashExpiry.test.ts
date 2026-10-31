import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRegistry } from "../TerminalRegistry.js";
import type { TerminalProcess } from "../TerminalProcess.js";
import { events } from "../../events.js";

const TTL_MS = 20_000;

/** The expiries the registry still holds, read through the one private field this suite checks. */
function heldExpiries(registry: TerminalRegistry): number {
  return (registry as unknown as { trashExpiryCallbacks: Map<string, unknown> })
    .trashExpiryCallbacks.size;
}

function addTerminal(registry: TerminalRegistry, id: string): void {
  registry.add(id, { getInfo: () => ({ id }) } as unknown as TerminalProcess);
}

describe("TerminalRegistry early trash expiry (#15728)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs the trash's own expiry once, now, and never again when the timer would have fired", () => {
    const registry = new TerminalRegistry(TTL_MS);
    addTerminal(registry, "t1");
    const onExpire = vi.fn();
    registry.trash("t1", onExpire);
    const cleared = vi.spyOn(events, "emit");

    expect(registry.expireTrashNow("t1")).toBe(true);
    expect(onExpire).toHaveBeenCalledExactlyOnceWith("t1");
    expect(registry.isInTrash("t1")).toBe(false);
    expect(cleared).toHaveBeenCalledWith(
      "terminal:trash-cleared",
      expect.objectContaining({ id: "t1" })
    );

    vi.advanceTimersByTime(TTL_MS * 2);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("reads the original expiry while the expiry runs, as the timer's would", () => {
    vi.setSystemTime(1_000);
    const registry = new TerminalRegistry(TTL_MS);
    addTerminal(registry, "t1");
    let seenExpiresAt: number | undefined;
    registry.trash("t1", (id) => {
      seenExpiresAt = registry.getTrashExpiresAt(id);
    });

    vi.setSystemTime(5_000);
    registry.expireTrashNow("t1");

    expect(seenExpiresAt).toBe(1_000 + TTL_MS);
  });

  it("refuses a terminal that is not in the trash, restored or never trashed", () => {
    const registry = new TerminalRegistry(TTL_MS);
    addTerminal(registry, "t1");
    addTerminal(registry, "t2");
    const onExpire = vi.fn();
    registry.trash("t1", onExpire);
    expect(registry.restore("t1")).toBe(true);

    expect(registry.expireTrashNow("t1")).toBe(false);
    expect(registry.expireTrashNow("t2")).toBe(false);

    vi.advanceTimersByTime(TTL_MS * 2);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("forgets a deleted terminal's expiry, so a later trash under its id runs only its own", () => {
    const registry = new TerminalRegistry(TTL_MS);
    addTerminal(registry, "t1");
    const first = vi.fn();
    registry.trash("t1", first);
    registry.delete("t1");

    addTerminal(registry, "t1");
    const second = vi.fn();
    registry.trash("t1", second);
    registry.expireTrashNow("t1");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("lets go of a trash's expiry when it is restored, deleted, run or disposed", () => {
    const registry = new TerminalRegistry(TTL_MS);
    for (const id of ["restored", "deleted", "expired", "disposed"]) {
      addTerminal(registry, id);
      registry.trash(id, () => {});
    }
    expect(heldExpiries(registry)).toBe(4);

    registry.restore("restored");
    registry.delete("deleted");
    registry.expireTrashNow("expired");
    expect(heldExpiries(registry)).toBe(1);

    registry.dispose();
    expect(heldExpiries(registry)).toBe(0);
  });
});
