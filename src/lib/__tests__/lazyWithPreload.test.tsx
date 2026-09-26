// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Suspense } from "react";
import { act, render } from "@testing-library/react";
import { lazyWithPreload } from "../lazyWithPreload";

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
});
