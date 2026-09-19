// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalAdoptionEntry } from "@shared/types/ipc/mcpServer";
import {
  cleanupTerminalAdoptionListeners,
  setupTerminalAdoptionListeners,
  useTerminalAdoptionStore,
} from "../terminalAdoptionStore";

const handed: TerminalAdoptionEntry = {
  terminalId: "terminal-1",
  orchestratorPaneId: "pane-orch",
  adoptedAt: 1,
};

let pushListener: ((adoptions: TerminalAdoptionEntry[]) => void) | null = null;
let resolveHydrate: ((adoptions: TerminalAdoptionEntry[]) => void) | null = null;
const unsubscribe = vi.fn();

beforeEach(() => {
  pushListener = null;
  resolveHydrate = null;
  Object.defineProperty(window, "electron", {
    value: {
      events: {
        on: vi.fn((name: string, listener: (adoptions: TerminalAdoptionEntry[]) => void) => {
          expect(name).toBe("terminal:adoptions-changed");
          pushListener = listener;
          return unsubscribe;
        }),
      },
      mcpServer: {
        listTerminalAdoptions: vi.fn(
          () =>
            new Promise<TerminalAdoptionEntry[]>((resolve) => {
              resolveHydrate = resolve;
            })
        ),
      },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanupTerminalAdoptionListeners();
  useTerminalAdoptionStore.getState().applyAdoptions([]);
  unsubscribe.mockClear();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("terminalAdoptionStore (#12490)", () => {
  it("hydrates a cold view from main's list", async () => {
    setupTerminalAdoptionListeners();

    resolveHydrate!([handed]);
    await flush();

    expect(useTerminalAdoptionStore.getState().adoptionsByTerminalId).toEqual({
      "terminal-1": handed,
    });
  });

  it("lets a push win over a pull that resolves after it", async () => {
    setupTerminalAdoptionListeners();

    pushListener!([]);
    resolveHydrate!([handed]);
    await flush();

    expect(useTerminalAdoptionStore.getState().adoptionsByTerminalId).toEqual({});
  });

  it("drops a pull that lands after cleanup, and unsubscribes", async () => {
    setupTerminalAdoptionListeners();
    const resolveStale = resolveHydrate!;

    cleanupTerminalAdoptionListeners();
    resolveStale([handed]);
    await flush();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(useTerminalAdoptionStore.getState().adoptionsByTerminalId).toEqual({});
  });
});
