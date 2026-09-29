// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Suspense, createElement, type ComponentType } from "react";
import { act, render, renderHook } from "@testing-library/react";
import { lazyWithPreload, usePreloadOnIntent } from "../react/lazyWithPreload.js";

function Greeting({ name }: { name: string }) {
  return createElement("p", null, `hello ${name}`);
}

function inSuspense(child: ReturnType<typeof createElement>) {
  return createElement(Suspense, { fallback: createElement("span", null, "loading") }, child);
}

describe("lazyWithPreload", () => {
  it("renders a preloaded default export in the first commit, without the fallback", async () => {
    const Lazy = lazyWithPreload(() => Promise.resolve({ default: Greeting }));
    await Lazy.preload();
    expect(Lazy.isLoaded()).toBe(true);

    const { container } = render(inSuspense(createElement(Lazy, { name: "palette" })));
    expect(container.textContent).toBe("hello palette");
  });

  it("picks a named export", async () => {
    const Lazy = lazyWithPreload(
      () => Promise.resolve({ Greeting }),
      (m) => m.Greeting
    );
    await Lazy.preload();
    const { container } = render(inSuspense(createElement(Lazy, { name: "named" })));
    expect(container.textContent).toBe("hello named");
  });

  it("suspends when rendered before the chunk has loaded", async () => {
    let resolve!: (m: { default: ComponentType<{ name: string }> }) => void;
    const Lazy = lazyWithPreload(
      () => new Promise<{ default: ComponentType<{ name: string }> }>((r) => (resolve = r))
    );
    const { container } = render(inSuspense(createElement(Lazy, { name: "dialog" })));
    expect(container.textContent).toBe("loading");

    await act(async () => resolve({ default: Greeting }));
    expect(container.textContent).toBe("hello dialog");
  });

  it("loads once however many callers preload, and retries a failed load", async () => {
    const load = vi
      .fn<() => Promise<{ default: typeof Greeting }>>()
      .mockRejectedValueOnce(new Error("chunk missing"))
      .mockResolvedValue({ default: Greeting });
    const Lazy = lazyWithPreload(load);

    await expect(Lazy.preload()).rejects.toThrow("chunk missing");
    await Promise.all([Lazy.preload(), Lazy.preload()]);
    await Lazy.preload();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retries after `pick` throws", async () => {
    const pick = vi
      .fn<(m: { Greeting: typeof Greeting }) => typeof Greeting>()
      .mockImplementationOnce(() => {
        throw new Error("no export");
      })
      .mockImplementation((m) => m.Greeting);
    const Lazy = lazyWithPreload(() => Promise.resolve({ Greeting }), pick);
    await expect(Lazy.preload()).rejects.toThrow("no export");
    await Lazy.preload();
    expect(Lazy.isLoaded()).toBe(true);
  });
});

describe("usePreloadOnIntent", () => {
  it("preloads on pointer enter or focus and swallows failures", async () => {
    const preload = vi.fn(() => Promise.reject(new Error("offline")));
    const { result } = renderHook(() => usePreloadOnIntent({ preload }));
    result.current.onPointerEnter();
    result.current.onFocus();
    await Promise.resolve();
    expect(preload).toHaveBeenCalledTimes(2);
  });
});
