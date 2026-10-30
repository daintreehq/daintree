// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  SettingsFlushProvider,
  useSettingsTabFlush,
  SettingsFlushContext,
} from "../SettingsFlushRegistry";
import { useContext } from "react";

function wrap({ children }: { children: ReactNode }) {
  return <SettingsFlushProvider>{children}</SettingsFlushProvider>;
}

describe("SettingsFlushRegistry", () => {
  it("registered flush callback runs during flushAll", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(
      () => {
        useSettingsTabFlush("environment", fn, true);
        const ctx = useContext(SettingsFlushContext);
        return ctx;
      },
      { wrapper: wrap }
    );

    await act(async () => {
      await result.current!.flushAll();
    });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flushAll skips disabled callbacks", async () => {
    const fn = vi.fn();
    const { result } = renderHook(
      () => {
        useSettingsTabFlush("environment", fn, false);
        return useContext(SettingsFlushContext);
      },
      { wrapper: wrap }
    );

    await act(async () => {
      await result.current!.flushAll();
    });

    expect(fn).not.toHaveBeenCalled();
  });

  it("re-enabling a flush after disabling re-registers it", async () => {
    const fn = vi.fn();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => {
        useSettingsTabFlush("environment", fn, enabled);
        return useContext(SettingsFlushContext);
      },
      { wrapper: wrap, initialProps: { enabled: true } }
    );

    rerender({ enabled: false });
    await act(async () => {
      await result.current!.flushAll();
    });
    expect(fn).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await act(async () => {
      await result.current!.flushAll();
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flushAll runs all registered tabs and surfaces no error when one rejects", async () => {
    const ok = vi.fn().mockResolvedValue(undefined);
    const bad = vi.fn().mockRejectedValue(new Error("boom"));

    const { result } = renderHook(
      () => {
        useSettingsTabFlush("environment", bad, true);
        useSettingsTabFlush("worktree", ok, true);
        return useContext(SettingsFlushContext);
      },
      { wrapper: wrap }
    );

    // A throw has no message on its page to keep the dialog open for, so it isn't a failure.
    await act(async () => {
      await expect(result.current!.flushAll()).resolves.toEqual([]);
    });

    expect(ok).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it("reports each tab whose flush kept its draft, with where to land, in registration order", async () => {
    let finishWorktree: (failure: { landOn: string }) => void = () => {};
    const environment = vi.fn().mockResolvedValue({ landOn: "env-row" });
    const worktree = vi.fn(
      () => new Promise<{ landOn: string }>((resolve) => (finishWorktree = resolve))
    );
    const assistant = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(
      () => {
        useSettingsTabFlush("worktree", worktree, true);
        useSettingsTabFlush("assistant", assistant, true);
        useSettingsTabFlush("environment", environment, true);
        return useContext(SettingsFlushContext);
      },
      { wrapper: wrap }
    );

    let failed: unknown;
    await act(async () => {
      const pending = result.current!.flushAll();
      // Worktree finishes last but registered first, so it still comes first.
      await Promise.resolve();
      finishWorktree({ landOn: "worktree-path-pattern" });
      failed = await pending;
    });

    expect(failed).toEqual([
      { tab: "worktree", landOn: "worktree-path-pattern" },
      { tab: "environment", landOn: "env-row" },
    ]);
  });

  it("treats a synchronous failure the same as an async one", async () => {
    const { result } = renderHook(
      () => {
        useSettingsTabFlush("environment", () => ({ landOn: "env-row" }), true);
        return useContext(SettingsFlushContext);
      },
      { wrapper: wrap }
    );

    await act(async () => {
      await expect(result.current!.flushAll()).resolves.toEqual([
        { tab: "environment", landOn: "env-row" },
      ]);
    });
  });

  it("invokes the latest callback after rerender", async () => {
    const first = vi.fn();
    const second = vi.fn();

    const { result, rerender } = renderHook(
      ({ fn }: { fn: () => void }) => {
        useSettingsTabFlush("environment", fn, true);
        return useContext(SettingsFlushContext);
      },
      { wrapper: wrap, initialProps: { fn: first } }
    );

    rerender({ fn: second });

    await act(async () => {
      await result.current!.flushAll();
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
