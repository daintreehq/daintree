// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanopyPendingPopOut } from "@shared/types/ipc/canopy";
import { useCanopyStore } from "@/store/canopyStore";
import { receiveCanopyPopOuts } from "../canopyWindowPopOut";

const order: string[] = [];
const peekPopOut = vi.fn<() => Promise<CanopyPendingPopOut | null>>();
const acknowledgePopOut = vi.fn(async ({ id }: { id: number }) => {
  order.push(`ack ${id}`);
  return true;
});
let waiting: () => void = () => {};
const offWaiting = vi.fn();

const pending = (id: number, query: string): CanopyPendingPopOut => ({
  id,
  popOut: {
    hostId: "studio",
    query,
    selection: { kind: "worker", runId: "run-2" },
    roleFilter: "workers",
    unreadOnly: false,
    keptUnread: [],
    archivedExpanded: true,
    trashExpanded: false,
    workOf: null,
  },
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let unsubscribe: () => void = () => {};

beforeEach(() => {
  order.length = 0;
  peekPopOut.mockReset();
  peekPopOut.mockResolvedValue(null);
  acknowledgePopOut.mockClear();
  offWaiting.mockClear();
  Object.defineProperty(window, "electron", {
    value: {
      canopyWindow: {
        peekPopOut,
        acknowledgePopOut,
        onPopOutWaiting: (listener: () => void) => {
          waiting = listener;
          return offWaiting;
        },
      },
    },
    configurable: true,
    writable: true,
  });
  unsubscribe = useCanopyStore.subscribe((state, prev) => {
    if (state.popOutLanding !== prev.popOutLanding && state.popOutLanding !== null) {
      order.push(`took ${state.popOutLanding.query}`);
    }
  });
});

afterEach(() => {
  unsubscribe();
  useCanopyStore.setState({
    hostId: null,
    roleFilter: "all",
    archivedExpanded: false,
    popOutLanding: null,
  });
});

describe("the Canopy window taking up a popped-out dialog (#16338)", () => {
  it("takes up one waiting from before it booted, and says so only once it has it", async () => {
    peekPopOut.mockResolvedValueOnce(pending(11, "deploy"));

    const stop = receiveCanopyPopOuts();
    await flush();

    expect(useCanopyStore.getState().hostId).toBe("studio");
    expect(useCanopyStore.getState().roleFilter).toBe("workers");
    expect(useCanopyStore.getState().archivedExpanded).toBe(true);
    expect(order).toEqual(["took deploy", "ack 11"]);
    stop();
    expect(offWaiting).toHaveBeenCalledTimes(1);
  });

  it("takes up one popped out while it stands, when main says one waits", async () => {
    const stop = receiveCanopyPopOuts();
    await flush();
    expect(acknowledgePopOut).not.toHaveBeenCalled();

    peekPopOut.mockResolvedValueOnce(pending(12, "build"));
    waiting();
    await flush();

    expect(useCanopyStore.getState().popOutLanding?.query).toBe("build");
    expect(acknowledgePopOut).toHaveBeenCalledWith({ id: 12 });
    stop();
  });

  it("lands once on the same pop-out asked for twice, answering both", async () => {
    peekPopOut.mockResolvedValue(pending(13, "twice"));

    const stop = receiveCanopyPopOuts();
    waiting();
    await flush();

    expect(order.filter((step) => step.startsWith("took"))).toEqual(["took twice"]);
    expect(acknowledgePopOut).toHaveBeenCalledTimes(2);
    stop();
  });
});
