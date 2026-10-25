// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { CanopyModelCatalogue } from "@shared/types/ipc/canopy";
import { CanopyModelChoice, useCanopyModelChoice } from "../CanopyModelChoice";

const variant = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  downloadBytes: 21_000_000,
  installed: false,
  supported: true,
  bench: null,
  ...over,
});
const catalogue = (selected = "light"): CanopyModelCatalogue => ({
  selected,
  variants: [variant("light", "Light"), variant("best", "Best", { downloadBytes: 73_000_000 })],
});

afterEach(cleanup);

describe("useCanopyModelChoice", () => {
  it("lists once, starting from the model the host would use, and keeps the pick", async () => {
    const load = vi.fn(async () => catalogue());
    const { result } = renderHook(() => useCanopyModelChoice(load, "own"));
    expect(result.current.chosen).toBeNull();
    await act(async () => {});
    expect(result.current.chosen).toBe("light");
    act(() => result.current.pick("best"));
    expect(result.current.chosen).toBe("best");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("is not made to list again by a loader made afresh on every render", async () => {
    const load = vi.fn(async () => catalogue());
    const { rerender } = renderHook(() => useCanopyModelChoice(() => load(), "own"));
    await act(async () => {});
    rerender();
    rerender();
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("starts from the model the host says it would use, not the first one listed", async () => {
    const { result } = renderHook(() => useCanopyModelChoice(async () => catalogue("best"), "own"));
    await act(async () => {});
    expect(result.current.chosen).toBe("best");
  });

  it("lists again with that host's own loader, and forgets the pick, when it is another host's", async () => {
    const loads: Record<string, () => Promise<CanopyModelCatalogue>> = {
      "studio-01": vi.fn(async () => catalogue("light")),
      "studio-02": vi.fn(async () => catalogue("best")),
    };
    const { result, rerender } = renderHook(
      ({ host }: { host: string }) => useCanopyModelChoice(loads[host]!, host),
      { initialProps: { host: "studio-01" } }
    );
    await act(async () => {});
    expect(result.current.chosen).toBe("light");
    act(() => result.current.pick("best"));
    rerender({ host: "studio-02" });
    expect(result.current.chosen).toBeNull();
    await act(async () => {});
    expect(loads["studio-01"]).toHaveBeenCalledTimes(1);
    expect(loads["studio-02"]).toHaveBeenCalledTimes(1);
    // The second host's own answer, not the first host's pick carried over.
    act(() => result.current.pick("light"));
    expect(result.current.chosen).toBe("light");
  });

  it("asks for nothing when it is gone before the request would be made", async () => {
    const load = vi.fn(async () => catalogue());
    const { unmount } = renderHook(() => useCanopyModelChoice(load, "own"));
    unmount();
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
  });

  it("asks for nothing while it isn't shown", async () => {
    const load = vi.fn(async () => catalogue());
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useCanopyModelChoice(load, "own", on),
      { initialProps: { on: false } }
    );
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
    expect(result.current.chosen).toBeNull();
    rerender({ on: true });
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reports a list that couldn't be had, whether it rejects or throws outright", async () => {
    const failing: Array<[() => Promise<CanopyModelCatalogue>, string]> = [
      [
        async () => {
          throw new Error("offline");
        },
        "offline",
      ],
      [
        () => {
          throw new Error("no bridge");
        },
        "no bridge",
      ],
    ];
    for (const [load, message] of failing) {
      const { result, unmount } = renderHook(() => useCanopyModelChoice(load, "own"));
      await act(async () => {});
      expect(result.current.error).toContain(message);
      expect(result.current.chosen).toBeNull();
      unmount();
    }
  });
});

describe("CanopyModelChoice", () => {
  function Harness({ unsupported = false }: { unsupported?: boolean }) {
    const loaded = catalogue();
    if (unsupported) loaded.variants[1] = variant("best", "Best", { supported: false });
    const choice = useCanopyModelChoice(async () => loaded, "own");
    return <CanopyModelChoice choice={choice} name="test-model" host="studio-01" />;
  }

  it("shows each model with its size, names the host, and lets one be picked", async () => {
    render(<Harness />);
    expect(screen.getByText("Looking up the models…")).toBeTruthy();
    await act(async () => {});
    expect(screen.getByRole("group", { name: "Model for studio-01" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Light/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Best/ }));
    expect((screen.getByRole("radio", { name: /Best/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: /Best/ }).closest("label")?.textContent).toContain(
      "73 MB"
    );
  });

  it("won't offer a model this version of Daintree can't read", async () => {
    render(<Harness unsupported />);
    await act(async () => {});
    expect((screen.getByRole("radio", { name: /Best/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("radio", { name: /Best/ }).closest("label")?.textContent).toContain(
      "needs a newer version of Daintree"
    );
  });
});
