// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

const hintMocks = vi.hoisted(() => {
  const mockShow = vi.fn();
  const mockIncrementCount = vi.fn();
  return {
    mockShow,
    mockIncrementCount,
    mockGetState: vi.fn(() => ({
      hydrated: true,
      counts: {} as Record<string, number>,
      show: mockShow,
      incrementCount: mockIncrementCount,
    })),
    mockGetEffectiveCombo: vi.fn((_actionId: string): string | null => "Cmd+K"),
    mockGetDisplayCombo: vi.fn((_actionId: string): string => "⌘K"),
  };
});

vi.mock("../../store/shortcutHintStore", () => ({
  shortcutHintStore: { getState: hintMocks.mockGetState },
}));

vi.mock("../KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: hintMocks.mockGetEffectiveCombo,
    getDisplayCombo: hintMocks.mockGetDisplayCombo,
  },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { ActionService } from "../ActionService";
import { useOverlayState } from "@/hooks/useOverlayState";
import { useUIStore } from "@/store/uiStore";
import type { ActionDefinition, ActionId } from "@shared/types/actions";

/**
 * Drives the *real* `useOverlayState` hook so the overlay claim is registered
 * by React's own passive effect, exactly as AppDialog registers it in
 * production. The sibling unit tests in ActionService.test.ts mutate the store
 * directly, which proves the comparison logic but not that a mounted dialog's
 * claim actually lands inside the dispatch window — the gap that let issue
 * #11507 regress once already.
 */
function OverlayHarness({ open }: { open: boolean }) {
  useOverlayState(open);
  return null;
}

function makeDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ActionService overlay claim integration", () => {
  let service: ActionService;

  beforeEach(() => {
    service = new ActionService();
    useUIStore.setState({ overlayStack: [] });
    hintMocks.mockShow.mockClear().mockReturnValue(true);
    hintMocks.mockIncrementCount.mockClear();
  });

  afterEach(() => {
    useUIStore.setState({ overlayStack: [] });
  });

  const makeAction = (id: string, run: ActionDefinition["run"]): ActionDefinition => ({
    id: id as ActionId,
    title: "Test",
    description: "Test action",
    category: "test",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run,
  });

  it("suppresses the hint when a dialog mounts and claims the overlay mid-dispatch", async () => {
    const deferred = makeDeferred();
    const { rerender } = render(<OverlayHarness open={false} />);

    service.register(makeAction("test.mountsDialog", () => deferred.promise));
    const dispatched = service.dispatch("test.mountsDialog" as ActionId, undefined, {
      source: "user",
    });

    // The dialog opens while run() is still pending; act() flushes the real
    // passive effect that registers the claim.
    await act(async () => {
      rerender(<OverlayHarness open />);
    });
    expect(useUIStore.getState().overlayStack).toHaveLength(1);

    await act(async () => {
      deferred.resolve();
      await dispatched;
    });

    const result = await dispatched;
    expect(result.ok).toBe(true);
    expect(hintMocks.mockShow).not.toHaveBeenCalled();
    expect(hintMocks.mockIncrementCount).not.toHaveBeenCalled();
  });

  it("still emits the hint when a dialog was already mounted and stays open", async () => {
    const deferred = makeDeferred();
    render(<OverlayHarness open />);
    expect(useUIStore.getState().overlayStack).toHaveLength(1);

    service.register(makeAction("test.insideMountedDialog", () => deferred.promise));
    const dispatched = service.dispatch("test.insideMountedDialog" as ActionId, undefined, {
      source: "user",
    });

    await act(async () => {
      deferred.resolve();
      await dispatched;
    });

    const result = await dispatched;
    expect(result.ok).toBe(true);
    expect(hintMocks.mockIncrementCount).toHaveBeenCalledWith("test.insideMountedDialog");
    expect(hintMocks.mockShow).toHaveBeenCalledWith("test.insideMountedDialog", "⌘K");
  });

  it("still emits the hint when the dialog unmounts and releases its claim mid-dispatch", async () => {
    const deferred = makeDeferred();
    const { rerender } = render(<OverlayHarness open />);
    expect(useUIStore.getState().overlayStack).toHaveLength(1);

    service.register(makeAction("test.closesMountedDialog", () => deferred.promise));
    const dispatched = service.dispatch("test.closesMountedDialog" as ActionId, undefined, {
      source: "user",
    });

    await act(async () => {
      rerender(<OverlayHarness open={false} />);
    });
    expect(useUIStore.getState().overlayStack).toHaveLength(0);

    await act(async () => {
      deferred.resolve();
      await dispatched;
    });

    const result = await dispatched;
    expect(result.ok).toBe(true);
    expect(hintMocks.mockIncrementCount).toHaveBeenCalledWith("test.closesMountedDialog");
    expect(hintMocks.mockShow).toHaveBeenCalledWith("test.closesMountedDialog", "⌘K");
  });
});
