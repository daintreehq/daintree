// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Taken and dropped in effects, as the real claim is.
const { claims } = vi.hoisted(() => ({ claims: new Set<string>() }));

vi.mock("@/hooks", async () => {
  const { useEffect } = await import("react");
  return {
    useOverlayClaim: (id: string, active: boolean) => {
      useEffect(() => {
        if (!active) return;
        claims.add(id);
        return () => {
          claims.delete(id);
        };
      }, [id, active]);
    },
  };
});

import { useNativeViewMenu } from "../useNativeViewMenu";

const ID = "portal-all-tabs";

function renderMenu(enabled: boolean) {
  return renderHook(({ enabled }) => useNativeViewMenu(ID, enabled), {
    initialProps: { enabled },
  });
}

beforeEach(() => claims.clear());

describe("useNativeViewMenu", () => {
  it("runs the chosen command once its close has released the page", () => {
    const { result } = renderMenu(true);
    act(() => result.current.setOpen(true));
    expect(claims.has(ID)).toBe(true);

    let claimHeld: boolean | null = null;
    const run = vi.fn(() => {
      claimHeld = claims.has(ID);
    });
    act(() => {
      result.current.afterClose(run)();
      result.current.setOpen(false);
    });

    expect(run).toHaveBeenCalledOnce();
    expect(claimHeld).toBe(false);
  });

  it("treats its trigger going away mid-open as the close, and never replays the choice", () => {
    const { result, rerender } = renderMenu(true);
    act(() => result.current.setOpen(true));
    let claimHeld: boolean | null = null;
    const run = vi.fn(() => {
      claimHeld = claims.has(ID);
    });
    // Chosen, but the unmounting trigger means Radix never reports the close.
    act(() => result.current.afterClose(run)());
    expect(run).not.toHaveBeenCalled();

    rerender({ enabled: false });
    expect(run).toHaveBeenCalledOnce();
    expect(claimHeld).toBe(false);
    expect(result.current.open).toBe(false);
    expect(claims.has(ID)).toBe(false);

    rerender({ enabled: true });
    expect(run).toHaveBeenCalledOnce();
    expect(result.current.open).toBe(false);
    expect(claims.has(ID)).toBe(false);
  });

  it("claims nothing while disabled, even if asked to open", () => {
    const { result } = renderMenu(false);
    act(() => result.current.setOpen(true));

    expect(result.current.open).toBe(false);
    expect(claims.has(ID)).toBe(false);
  });
});
