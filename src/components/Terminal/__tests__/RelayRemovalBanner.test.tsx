// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type {
  DecisionsRelayRemoval,
  DecisionsRelayRemovalLocal,
  DecisionsStatus,
} from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import { RelayRemovalBanner, describeRelayRemoval } from "../RelayRemovalBanner";
import { useRelayRemoval } from "../useRelayRemoval";
import { takePendingRelayUrlRequest } from "@/components/Settings/Decisions/relayUrlRequest";

const ID = "daintree-decisions-remove-00000000-0000-4000-8000-000000000001";
const ORIGIN = "https://relay.example.workers.dev";

function removal(
  outcome: DecisionsRelayRemoval["outcome"],
  recorded = true
): DecisionsRelayRemoval {
  return { terminalId: ID, origin: ORIGIN, recorded, deleteLocalHistory: false, outcome };
}

const finished = (local: DecisionsRelayRemovalLocal) =>
  removal({ state: "exited", exitCode: 0, local });

describe("describeRelayRemoval", () => {
  it("says the record stays whenever the removal didn't exit 0 by itself", () => {
    for (const observed of [
      removal({ state: "exited", exitCode: 1, local: "kept" }),
      removal({ state: "interrupted" }),
    ]) {
      const copy = describeRelayRemoval(observed);
      expect(copy.title).toBe("Relay removal didn't finish");
      expect(copy.description).toContain("Daintree kept its record of relay.example.workers.dev");
      expect(copy.settingsSection).toBe("decisions-relay-remove");
    }
    expect(
      describeRelayRemoval(removal({ state: "exited", exitCode: 1, local: "kept" })).description
    ).toMatch(/exited with status 1, so part of the relay may still be in Cloudflare/);
  });

  it("claims no record of a relay that wasn't the one set up here", () => {
    const copy = describeRelayRemoval(
      removal({ state: "exited", exitCode: 1, local: "kept" }, false)
    );
    expect(copy.description).not.toMatch(/record/);
  });

  it("says what became of this computer's record after an exit 0", () => {
    expect(describeRelayRemoval(finished("forgotten"))).toMatchObject({
      settingsSection: "decisions-relay-url",
      actionLabel: "Set up a relay…",
    });
    expect(describeRelayRemoval(finished("forgotten")).description).toMatch(
      /forgot relay\.example\.workers\.dev.*the decision history stays/
    );
    expect(describeRelayRemoval(finished("deleted")).description).toMatch(
      /deleted this computer's Decisions data/
    );
    expect(describeRelayRemoval(finished("none")).description).toMatch(
      /Nothing on this computer changed/
    );
    expect(describeRelayRemoval(finished("changed")).description).toMatch(/another relay identity/);
    expect(describeRelayRemoval(finished("off")).description).toMatch(/kept its record/);
    expect(describeRelayRemoval(finished("failed"))).toMatchObject({ severity: "error" });
    expect(describeRelayRemoval(finished("incomplete")).settingsSection).toBe("decisions-data");
  });

  it("claims nothing it didn't see for a pane it watched no removal under", () => {
    const copy = describeRelayRemoval({ unwatched: true });
    expect(copy.title).toBe("No record of how this removal ended");
    expect(copy.description).not.toMatch(/kept its record/);
  });

  it("gives each thing it says its own key, so a dismissal lasts only until it changes", () => {
    const keys = [
      { unwatched: true as const },
      removal({ state: "running" }),
      removal({ state: "interrupted" }),
      removal({ state: "exited", exitCode: 1, local: "kept" }),
      removal({ state: "exited", exitCode: 2, local: "kept" }),
      finished("pending"),
      finished("forgotten"),
      finished("failed"),
    ].map((observed) => describeRelayRemoval(observed).key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("RelayRemovalBanner", () => {
  afterEach(() => {
    cleanup();
    dispatch.mockReset();
    takePendingRelayUrlRequest();
  });

  it("goes to the relay URL field to set up a new relay once this one is forgotten", () => {
    render(
      <TooltipProvider>
        <RelayRemovalBanner
          copy={describeRelayRemoval(finished("forgotten"))}
          onDismiss={() => {}}
        />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Set up a relay…" }));

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      "app.settings.openTab",
      { tab: "decisions", sectionId: "decisions-relay-url" },
      { source: "user" }
    );
    expect(takePendingRelayUrlRequest()).toBe(true);
  });

  it("offers nothing to do while the removal runs", () => {
    render(
      <TooltipProvider>
        <RelayRemovalBanner
          copy={describeRelayRemoval(removal({ state: "running" }))}
          onDismiss={() => {}}
        />
      </TooltipProvider>
    );
    expect(screen.queryByRole("button", { name: /Settings|relay…/ })).toBeNull();
  });
});

describe("useRelayRemoval", () => {
  let push: ((status: DecisionsStatus) => void) | null;
  const getStatus = vi.fn<() => Promise<DecisionsStatus>>();
  const off = vi.fn();

  beforeEach(() => {
    push = null;
    getStatus.mockReset();
    off.mockReset();
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        decisions: { getStatus },
        events: {
          on: (_name: string, listener: (status: DecisionsStatus) => void) => {
            push = listener;
            return off;
          },
        },
      },
    });
  });

  it("reads and follows nothing for a pane that isn't a removal's", () => {
    const { result } = renderHook(() => useRelayRemoval("pane-1", false));
    expect(result.current).toBeNull();
    expect(getStatus).not.toHaveBeenCalled();
    expect(push).toBeNull();
  });

  it("follows its removal, never letting an older read roll a newer push back", async () => {
    let answer!: (status: DecisionsStatus) => void;
    getStatus.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { result, unmount } = renderHook(() => useRelayRemoval(ID, true));
    expect(result.current).toBeNull();

    act(() =>
      push!({
        state: "connected",
        revision: 5,
        relayRemovals: [finished("forgotten")],
      })
    );
    await act(async () =>
      answer({ state: "connected", revision: 4, relayRemovals: [removal({ state: "running" })] })
    );
    expect(result.current).toEqual(finished("forgotten"));

    unmount();
    expect(off).toHaveBeenCalledOnce();
  });

  it("keeps a pushed outcome when the first read then fails", async () => {
    let fail!: (error: Error) => void;
    getStatus.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    const { result } = renderHook(() => useRelayRemoval(ID, true));

    act(() => push!({ state: "connected", revision: 3, relayRemovals: [finished("forgotten")] }));
    await act(async () => fail(new Error("gone")));

    expect(result.current).toEqual(finished("forgotten"));
  });

  it("says main watches no removal under the id once it has answered without one", async () => {
    getStatus.mockResolvedValue({ state: "off" });
    const { result } = renderHook(() => useRelayRemoval(ID, true));
    await vi.waitFor(() => expect(result.current).toEqual({ unwatched: true }));
  });
});
