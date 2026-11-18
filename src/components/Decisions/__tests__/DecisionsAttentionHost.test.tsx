// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionsOpenAttentionRequest } from "@shared/types/decisionsQuestion";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { DecisionsAttentionHost } from "../DecisionsAttentionHost";

vi.mock("../DecisionsAttentionDialog", () => ({ DecisionsAttentionDialog: () => null }));

const handlers = new Map<string, Set<(payload: DecisionsOpenAttentionRequest) => void>>();

/** Main sending this view an open request, as the preload delivers it. */
function send(name: string, payload: DecisionsOpenAttentionRequest): void {
  for (const handler of [...(handlers.get(name) ?? [])]) handler(payload);
}

beforeEach(() => {
  handlers.clear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      events: {
        on: vi.fn((name: string, handler: (payload: DecisionsOpenAttentionRequest) => void) => {
          if (!handlers.has(name)) handlers.set(name, new Set());
          handlers.get(name)!.add(handler);
          return () => handlers.get(name)?.delete(handler);
        }),
      },
    },
  });
  useDecisionsAttentionStore.setState({
    isOpen: false,
    request: { terminalId: null, returnFocusTo: null, seq: 0 },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
});

describe("DecisionsAttentionHost", () => {
  it("opens the list at the pane a stalled answer's notification names (#17235)", () => {
    render(<DecisionsAttentionHost followsOpenRequests />);

    act(() => send("decisions:open-attention", { terminalId: "term-1" }));
    expect(useDecisionsAttentionStore.getState()).toMatchObject({
      isOpen: true,
      request: { terminalId: "term-1", returnFocusTo: null, seq: 1 },
    });

    // A second click while it is open still lands.
    act(() => send("decisions:open-attention", { terminalId: "term-2" }));
    expect(useDecisionsAttentionStore.getState().request).toEqual({
      terminalId: "term-2",
      returnFocusTo: null,
      seq: 2,
    });
  });

  it("stops following them once it unmounts", () => {
    const { unmount } = render(<DecisionsAttentionHost followsOpenRequests />);
    expect(handlers.get("decisions:open-attention")?.size).toBe(1);

    unmount();
    act(() => send("decisions:open-attention", { terminalId: "term-1" }));

    expect(handlers.get("decisions:open-attention")?.size).toBe(0);
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(false);
  });

  it("follows none where it isn't asked to, as in the Canopy window", () => {
    render(<DecisionsAttentionHost />);

    expect(handlers.has("decisions:open-attention")).toBe(false);
  });
});
