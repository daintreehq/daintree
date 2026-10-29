// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalSettleWaiterRegistry } from "../TerminalSettleWaiterRegistry";
import type { ManagedTerminal } from "../types";

function makeManaged(): ManagedTerminal {
  const hostElement = document.createElement("div");
  document.body.appendChild(hostElement);
  return {
    hostElement,
    isOpened: true,
    isAttaching: true,
    terminal: { element: document.createElement("div"), cols: 80, rows: 24 },
  } as unknown as ManagedTerminal;
}

describe("TerminalSettleWaiterRegistry attach-settled timeout", () => {
  let managed: ManagedTerminal;
  let registry: TerminalSettleWaiterRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    managed = makeManaged();
    registry = new TerminalSettleWaiterRegistry({
      getInstance: (id) => (id === "t1" ? managed : undefined),
      triggerDeferredVisibilityWake: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("resolves at the deadline when the attach settled without a notify", async () => {
    const wait = registry.waitForAttachSettled("t1", { timeoutMs: 100 });
    managed.isAttaching = false;

    vi.advanceTimersByTime(100);

    await expect(wait).resolves.toBeUndefined();
  });

  it("still rejects at the deadline when the attach never settled", async () => {
    const wait = registry.waitForAttachSettled("t1", { timeoutMs: 100 });
    const outcome = expect(wait).rejects.toThrow("attach settle timeout after 100ms");

    vi.advanceTimersByTime(100);

    await outcome;
  });
});
