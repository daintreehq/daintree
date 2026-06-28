// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { FileDecoration } from "@shared/types/forge";

const { getDecorationsMock, onDecorationsChangedMock } = vi.hoisted(() => ({
  getDecorationsMock: vi.fn(),
  onDecorationsChangedMock: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
    electron: {
      plugin: {
        getDecorations: getDecorationsMock,
        onDecorationsChanged: onDecorationsChangedMock,
      },
    },
  });
  getDecorationsMock.mockResolvedValue({});
  onDecorationsChangedMock.mockReturnValue(() => {});
});

async function load() {
  const { useFileTreeDecorations } = await import("../useFileTreeDecorations");
  return useFileTreeDecorations;
}

describe("useFileTreeDecorations", () => {
  it("pulls plugin decorations for a non-diff tree scope and path list", async () => {
    const decos: Record<string, FileDecoration> = { "src/a.ts": { badge: "!" } };
    getDecorationsMock.mockResolvedValue(decos);
    const useFileTreeDecorations = await load();

    const { result } = renderHook(() =>
      useFileTreeDecorations("tree:project", ["src/a.ts", "src/b.ts"])
    );

    await waitFor(() => expect(result.current).toEqual(decos));
    // The general consumer routes the same scope/paths through the host pull —
    // it is NOT limited to the Review Hub's `worktree-diff:*` scope.
    expect(getDecorationsMock).toHaveBeenCalledWith("tree:project", ["src/a.ts", "src/b.ts"]);
  });

  it("skips the IPC pull entirely when disabled (opt-in, cheap)", async () => {
    const useFileTreeDecorations = await load();
    const { result } = renderHook(() =>
      useFileTreeDecorations("tree:project", ["src/a.ts"], false)
    );
    // Disabled → stable empty map, no host round-trip.
    expect(result.current).toEqual({});
    expect(getDecorationsMock).not.toHaveBeenCalled();
  });

  it("returns a stable empty identity across disabled rerenders", async () => {
    const useFileTreeDecorations = await load();
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useFileTreeDecorations("tree:project", ["src/a.ts"], on),
      { initialProps: { on: false } }
    );
    const first = result.current;
    rerender({ on: false });
    expect(result.current).toBe(first);
    expect(getDecorationsMock).not.toHaveBeenCalled();
  });
});
