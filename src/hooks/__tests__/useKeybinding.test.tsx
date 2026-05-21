// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const subscribers = new Set<() => void>();
const overrides = new Map<string, string | undefined>();
const displayOverrides = new Map<string, string>();
const lastInvalidKeyRef = { current: null as string | null };

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    subscribe: vi.fn((listener: () => void) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    }),
    getEffectiveCombo: vi.fn((actionId: string) => overrides.get(actionId)),
    getDisplayCombo: vi.fn((actionId: string) => displayOverrides.get(actionId) ?? ""),
    getPendingChord: vi.fn(() => null),
    getLastInvalidKey: vi.fn(() => lastInvalidKeyRef.current),
  },
  normalizeKeyForBinding: (event: KeyboardEvent) => event.key,
}));

import { useEffectiveCombo, useKeybindingDisplay } from "../useKeybinding";
import { useLastInvalidKey } from "../useGlobalKeybindings";
import { keybindingService } from "@/services/KeybindingService";

function notifyAll(): void {
  for (const listener of Array.from(subscribers)) {
    listener();
  }
}

describe("useEffectiveCombo", () => {
  beforeEach(() => {
    subscribers.clear();
    overrides.clear();
    displayOverrides.clear();
    vi.clearAllMocks();
  });

  it("returns the current combo synchronously on mount", () => {
    overrides.set("agent.claude", "Cmd+Shift+C");
    const { result } = renderHook(() => useEffectiveCombo("agent.claude"));
    expect(result.current).toBe("Cmd+Shift+C");
  });

  it("returns undefined when no binding exists", () => {
    const { result } = renderHook(() => useEffectiveCombo("agent.unknown"));
    expect(result.current).toBeUndefined();
  });

  it("re-renders when subscribers are notified and the value changes", () => {
    overrides.set("agent.claude", "Cmd+Shift+C");
    const { result } = renderHook(() => useEffectiveCombo("agent.claude"));
    expect(result.current).toBe("Cmd+Shift+C");

    overrides.set("agent.claude", "Cmd+Shift+X");
    act(() => notifyAll());
    expect(result.current).toBe("Cmd+Shift+X");
  });

  it("re-subscribes when actionId changes", () => {
    overrides.set("agent.claude", "Cmd+Shift+C");
    overrides.set("agent.gemini", "Cmd+Shift+G");

    const { result, rerender } = renderHook(({ id }) => useEffectiveCombo(id), {
      initialProps: { id: "agent.claude" },
    });
    expect(result.current).toBe("Cmd+Shift+C");

    rerender({ id: "agent.gemini" });
    expect(result.current).toBe("Cmd+Shift+G");
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useEffectiveCombo("agent.claude"));
    expect(subscribers.size).toBe(1);

    unmount();
    expect(subscribers.size).toBe(0);
  });

  it("uses a stable subscribe reference across renders (no churn)", () => {
    const { rerender } = renderHook(() => useEffectiveCombo("agent.claude"));
    const callsAfterMount = (keybindingService.subscribe as ReturnType<typeof vi.fn>).mock.calls
      .length;

    rerender();
    rerender();
    rerender();

    expect((keybindingService.subscribe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAfterMount
    );
  });
});

describe("useKeybindingDisplay", () => {
  beforeEach(() => {
    subscribers.clear();
    overrides.clear();
    displayOverrides.clear();
    vi.clearAllMocks();
  });

  it("returns the formatted display combo synchronously on mount", () => {
    displayOverrides.set("agent.claude", "⌘+⇧+C");
    const { result } = renderHook(() => useKeybindingDisplay("agent.claude"));
    expect(result.current).toBe("⌘+⇧+C");
  });

  it("returns an empty string when no binding exists", () => {
    const { result } = renderHook(() => useKeybindingDisplay("agent.unknown"));
    expect(result.current).toBe("");
  });

  it("re-renders when subscribers are notified and the display changes", () => {
    displayOverrides.set("agent.claude", "⌘+⇧+C");
    const { result } = renderHook(() => useKeybindingDisplay("agent.claude"));
    expect(result.current).toBe("⌘+⇧+C");

    displayOverrides.set("agent.claude", "⌘+⇧+X");
    act(() => notifyAll());
    expect(result.current).toBe("⌘+⇧+X");
  });
});

describe("useLastInvalidKey — issue #8105", () => {
  beforeEach(() => {
    subscribers.clear();
    lastInvalidKeyRef.current = null;
    vi.clearAllMocks();
  });

  it("returns null initially", () => {
    const { result } = renderHook(() => useLastInvalidKey());
    expect(result.current).toBeNull();
  });

  it("re-renders with the new value after subscribers are notified", () => {
    const { result } = renderHook(() => useLastInvalidKey());
    expect(result.current).toBeNull();

    lastInvalidKeyRef.current = "y";
    act(() => notifyAll());
    expect(result.current).toBe("y");
  });

  it("re-renders to null after clear + notify", () => {
    lastInvalidKeyRef.current = "y";
    const { result } = renderHook(() => useLastInvalidKey());
    expect(result.current).toBe("y");

    lastInvalidKeyRef.current = null;
    act(() => notifyAll());
    expect(result.current).toBeNull();
  });

  it("uses a stable subscribe reference across renders (no churn)", () => {
    const { rerender } = renderHook(() => useLastInvalidKey());
    const callsAfterMount = (keybindingService.subscribe as ReturnType<typeof vi.fn>).mock.calls
      .length;

    rerender();
    rerender();

    expect((keybindingService.subscribe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAfterMount
    );
  });
});
