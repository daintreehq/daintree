// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Suspense } from "react";
import { act, render, renderHook } from "@testing-library/react";
import { lazyWithPreload, usePreloadedComponent } from "../lazyWithPreload";

function Greeting({ name }: { name: string }) {
  return <p>hello {name}</p>;
}

describe("lazyWithPreload", () => {
  it("renders a preloaded component in the first commit, without the fallback", async () => {
    const Lazy = lazyWithPreload(
      () => Promise.resolve({ Greeting }),
      (m) => m.Greeting
    );
    await Lazy.preload();

    const { container } = render(
      <Suspense fallback={<span>loading</span>}>
        <Lazy name="palette" />
      </Suspense>
    );

    // Synchronously after the first render: no Suspense round trip happened.
    expect(container.textContent).toBe("hello palette");
  });

  it("falls back to suspending when rendered before the chunk has loaded", async () => {
    let resolve!: (m: { Greeting: typeof Greeting }) => void;
    const Lazy = lazyWithPreload(
      () => new Promise<{ Greeting: typeof Greeting }>((r) => (resolve = r)),
      (m) => m.Greeting
    );

    const { container } = render(
      <Suspense fallback={<span>loading</span>}>
        <Lazy name="dialog" />
      </Suspense>
    );
    expect(container.textContent).toBe("loading");

    await act(async () => {
      resolve({ Greeting });
    });
    expect(container.textContent).toBe("hello dialog");
  });

  it("loads the chunk once however many callers preload it", async () => {
    const load = vi.fn(() => Promise.resolve({ Greeting }));
    const Lazy = lazyWithPreload(load, (m) => m.Greeting);

    await Promise.all([Lazy.preload(), Lazy.preload()]);
    await Lazy.preload();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries a failed load on the next preload", async () => {
    const load = vi
      .fn<() => Promise<{ Greeting: typeof Greeting }>>()
      .mockRejectedValueOnce(new Error("chunk missing"))
      .mockResolvedValueOnce({ Greeting });
    const Lazy = lazyWithPreload(load, (m) => m.Greeting);

    await expect(Lazy.preload()).rejects.toThrow("chunk missing");
    await expect(Lazy.preload()).resolves.toEqual({ Greeting });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("picks the component once per module, for the lazy path and every preload alike", async () => {
    let resolve!: (m: { Greeting: typeof Greeting }) => void;
    const pick = vi.fn((m: { Greeting: typeof Greeting }) => m.Greeting);
    const Lazy = lazyWithPreload(
      () => new Promise<{ Greeting: typeof Greeting }>((r) => (resolve = r)),
      pick
    );

    // Rendered before the chunk lands, so this mount goes through lazy().
    const { container } = render(
      <Suspense fallback={<span>loading</span>}>
        <Lazy name="factory" />
      </Suspense>
    );
    await act(async () => resolve({ Greeting }));
    await Lazy.preload();

    expect(container.textContent).toBe("hello factory");
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it("lets a later preload retry when picking the component throws", async () => {
    const pick = vi
      .fn<(m: { Greeting: typeof Greeting }) => typeof Greeting>()
      .mockImplementationOnce(() => {
        throw new Error("bad module");
      })
      .mockImplementation((m) => m.Greeting);
    const Lazy = lazyWithPreload(() => Promise.resolve({ Greeting }), pick);

    await expect(Lazy.preload()).rejects.toThrow("bad module");
    expect(Lazy.isLoaded()).toBe(false);
    await expect(Lazy.preload()).resolves.toEqual({ Greeting });
    expect(Lazy.isLoaded()).toBe(true);
  });
});

describe("usePreloadedComponent", () => {
  it("is ready from the first render when the chunk has already loaded", async () => {
    const Lazy = lazyWithPreload(
      () => Promise.resolve({ Greeting }),
      (m) => m.Greeting
    );
    await Lazy.preload();

    const { result } = renderHook(() => usePreloadedComponent(Lazy));

    expect(result.current.status).toBe("ready");
  });

  it("loads the chunk itself and turns ready once it lands, without suspending", async () => {
    let resolve!: (m: { Greeting: typeof Greeting }) => void;
    const Lazy = lazyWithPreload(
      () => new Promise<{ Greeting: typeof Greeting }>((r) => (resolve = r)),
      (m) => m.Greeting
    );
    function Host() {
      const load = usePreloadedComponent(Lazy);
      return load.status === "ready" ? <Lazy name="surface" /> : <span>{load.status}</span>;
    }

    // No Suspense boundary above: a suspension here would throw.
    const { container } = render(<Host />);
    expect(container.textContent).toBe("loading");

    await act(async () => resolve({ Greeting }));
    expect(container.textContent).toBe("hello surface");
  });

  it("reports a failed load instead of throwing, and a later mount tries again", async () => {
    const error = new Error("chunk missing");
    const load = vi
      .fn<() => Promise<{ Greeting: typeof Greeting }>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ Greeting });
    const Lazy = lazyWithPreload(load, (m) => m.Greeting);

    const first = renderHook(() => usePreloadedComponent(Lazy));
    await act(async () => {});
    expect(first.result.current).toEqual({ status: "failed", error });
    first.unmount();

    const second = renderHook(() => usePreloadedComponent(Lazy));
    await act(async () => {});
    expect(second.result.current.status).toBe("ready");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("leaves an unmounted host alone when its chunk lands", async () => {
    let resolve!: (m: { Greeting: typeof Greeting }) => void;
    const Lazy = lazyWithPreload(
      () => new Promise<{ Greeting: typeof Greeting }>((r) => (resolve = r)),
      (m) => m.Greeting
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result, unmount } = renderHook(() => usePreloadedComponent(Lazy));
    unmount();
    await act(async () => resolve({ Greeting }));

    expect(result.current.status).toBe("loading");
    expect(Lazy.isLoaded()).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("starts over for a different component instead of keeping the last one's answer", async () => {
    const Loaded = lazyWithPreload(
      () => Promise.resolve({ Greeting }),
      (m) => m.Greeting
    );
    await Loaded.preload();
    let resolve!: (m: { Greeting: typeof Greeting }) => void;
    const Pending = lazyWithPreload(
      () => new Promise<{ Greeting: typeof Greeting }>((r) => (resolve = r)),
      (m) => m.Greeting
    );

    const { result, rerender } = renderHook(({ target }) => usePreloadedComponent(target), {
      initialProps: { target: Loaded as typeof Pending },
    });
    expect(result.current.status).toBe("ready");

    rerender({ target: Pending });
    expect(result.current.status).toBe("loading");

    await act(async () => resolve({ Greeting }));
    expect(result.current.status).toBe("ready");
  });

  it("keeps a different component's answer when the last one's load settles late", async () => {
    let resolveFirst!: (m: { Greeting: typeof Greeting }) => void;
    const First = lazyWithPreload(
      () => new Promise<{ Greeting: typeof Greeting }>((r) => (resolveFirst = r)),
      (m) => m.Greeting
    );
    const error = new Error("chunk missing");
    const secondLoad = vi
      .fn<() => Promise<{ Greeting: typeof Greeting }>>()
      .mockRejectedValue(error);
    const Second = lazyWithPreload(secondLoad, (m) => m.Greeting);

    const { result, rerender } = renderHook(({ target }) => usePreloadedComponent(target), {
      initialProps: { target: First },
    });
    rerender({ target: Second });
    await act(async () => {});
    expect(result.current).toEqual({ status: "failed", error });

    // The first component's load lands after the switch: it must neither
    // overwrite the second's failure nor send the second loading again.
    await act(async () => resolveFirst({ Greeting }));
    expect(result.current).toEqual({ status: "failed", error });
    expect(secondLoad).toHaveBeenCalledTimes(1);
  });
});
