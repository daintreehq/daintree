// @vitest-environment jsdom
import { StrictMode, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import { useHostChannel } from "../react/useHostChannel";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function codedError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

interface Target {
  pluginId: string;
  channel: string;
}

let invokeMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeMock = vi.fn();
  vi.stubGlobal("electron", { plugin: { invoke: invokeMock, on: vi.fn(), onPanel: vi.fn() } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderTarget(initial: Target, wrapper?: (props: { children: ReactNode }) => ReactNode) {
  return renderHook(
    ({ pluginId, channel }: Target) => useHostChannel<object, { from: string }>(pluginId, channel),
    { initialProps: initial, wrapper }
  );
}

describe("useHostChannel when its target changes with a call in flight", () => {
  it("drops an old-target failure that settles after a channel change", async () => {
    const old = deferred();
    invokeMock.mockReturnValueOnce(old.promise);
    const { result, rerender } = renderTarget({ pluginId: "acme.p", channel: "a" });

    let pending!: Promise<{ from: string } | undefined>;
    act(() => {
      pending = result.current.invoke({});
    });
    expect(result.current.loading).toBe(true);

    rerender({ pluginId: "acme.p", channel: "b" });
    expect(result.current.loading).toBe(false);

    await act(async () => {
      old.reject(new Error("old channel failed"));
      await expect(pending).resolves.toBeUndefined();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.disconnected).toBe(false);
  });

  it("drops an old-target HOST_DISCONNECTED failure that settles after a channel change", async () => {
    const old = deferred();
    invokeMock.mockReturnValueOnce(old.promise);
    const { result, rerender } = renderTarget({ pluginId: "acme.p", channel: "a" });

    let pending!: Promise<{ from: string } | undefined>;
    act(() => {
      pending = result.current.invoke({});
    });
    rerender({ pluginId: "acme.p", channel: "b" });

    await act(async () => {
      old.reject(codedError("HOST_DISCONNECTED", "old channel disconnected"));
      await expect(pending).resolves.toBeUndefined();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.disconnected).toBe(false);
  });

  it("resolves an old-target success to undefined and leaves disconnected as the last real call set it", async () => {
    invokeMock.mockRejectedValueOnce(codedError("HOST_DISCONNECTED"));
    const old = deferred<{ from: string }>();
    invokeMock.mockReturnValueOnce(old.promise);
    const { result, rerender } = renderTarget({ pluginId: "acme.p", channel: "a" });

    await act(async () => {
      await result.current.invoke({});
    });
    expect(result.current.disconnected).toBe(true);

    let pending!: Promise<{ from: string } | undefined>;
    act(() => {
      pending = result.current.invoke({});
    });
    rerender({ pluginId: "acme.p", channel: "b" });

    await act(async () => {
      old.resolve({ from: "a" });
      await expect(pending).resolves.toBeUndefined();
    });

    expect(result.current.disconnected).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("protects a pluginId-only change the same way", async () => {
    const old = deferred();
    invokeMock.mockReturnValueOnce(old.promise);
    const { result, rerender } = renderTarget({ pluginId: "acme.one", channel: "query" });

    let pending!: Promise<{ from: string } | undefined>;
    act(() => {
      pending = result.current.invoke({});
    });
    rerender({ pluginId: "acme.two", channel: "query" });

    await act(async () => {
      old.reject(codedError("HOST_DISCONNECTED", "old plugin disconnected"));
      await expect(pending).resolves.toBeUndefined();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.disconnected).toBe(false);
  });

  it("keeps a first new-target call in flight when the old call fails first, then applies it", async () => {
    const old = deferred();
    const next = deferred<{ from: string }>();
    invokeMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderTarget({ pluginId: "acme.p", channel: "a" });

    let oldPending!: Promise<{ from: string } | undefined>;
    act(() => {
      oldPending = result.current.invoke({});
    });
    rerender({ pluginId: "acme.p", channel: "b" });

    let nextPending!: Promise<{ from: string } | undefined>;
    act(() => {
      nextPending = result.current.invoke({});
    });
    expect(invokeMock).toHaveBeenLastCalledWith("acme.p", "b", {});

    await act(async () => {
      old.reject(codedError("HOST_DISCONNECTED"));
      await expect(oldPending).resolves.toBeUndefined();
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.disconnected).toBe(false);

    await act(async () => {
      next.resolve({ from: "b" });
      await expect(nextPending).resolves.toEqual({ from: "b" });
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("drops an old success that settles after the first new-target call failed", async () => {
    const old = deferred<{ from: string }>();
    const next = deferred();
    invokeMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderTarget({ pluginId: "acme.p", channel: "a" });

    let oldPending!: Promise<{ from: string } | undefined>;
    act(() => {
      oldPending = result.current.invoke({});
    });
    rerender({ pluginId: "acme.p", channel: "b" });

    let nextPending!: Promise<{ from: string } | undefined>;
    act(() => {
      nextPending = result.current.invoke({});
    });

    await act(async () => {
      next.reject(codedError("HOST_DISCONNECTED", "b disconnected"));
      await expect(nextPending).resolves.toBeUndefined();
    });
    expect(result.current.error?.message).toBe("b disconnected");
    expect(result.current.disconnected).toBe(true);

    await act(async () => {
      old.resolve({ from: "a" });
      await expect(oldPending).resolves.toBeUndefined();
    });
    expect(result.current.error?.message).toBe("b disconnected");
    expect(result.current.disconnected).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it("drops an old-target failure after a channel change under StrictMode, and applies the next call", async () => {
    const old = deferred();
    const next = deferred<{ from: string }>();
    invokeMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderTarget({ pluginId: "acme.p", channel: "a" }, StrictMode);

    let oldPending!: Promise<{ from: string } | undefined>;
    act(() => {
      oldPending = result.current.invoke({});
    });
    rerender({ pluginId: "acme.p", channel: "b" });

    await act(async () => {
      old.reject(codedError("HOST_DISCONNECTED"));
      await expect(oldPending).resolves.toBeUndefined();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.disconnected).toBe(false);

    let nextPending!: Promise<{ from: string } | undefined>;
    act(() => {
      nextPending = result.current.invoke({});
    });
    await act(async () => {
      next.resolve({ from: "b" });
      await expect(nextPending).resolves.toEqual({ from: "b" });
    });
    expect(result.current.loading).toBe(false);
  });
  it.each([
    ["success", (d: Deferred<unknown>) => d.resolve({ from: "a" })],
    ["ordinary failure", (d: Deferred<unknown>) => d.reject(new Error("a failed"))],
    [
      "HOST_DISCONNECTED failure",
      (d: Deferred<unknown>) => d.reject(codedError("HOST_DISCONNECTED")),
    ],
  ])("drops an old %s after an a-to-b-to-a change with no new invoke", async (_label, settle) => {
    const old = deferred();
    invokeMock.mockReturnValueOnce(old.promise);
    const { result, rerender } = renderTarget({ pluginId: "acme.p", channel: "a" });

    let pending!: Promise<{ from: string } | undefined>;
    act(() => {
      pending = result.current.invoke({});
    });
    rerender({ pluginId: "acme.p", channel: "b" });
    rerender({ pluginId: "acme.p", channel: "a" });
    expect(result.current.loading).toBe(false);

    await act(async () => {
      settle(old);
      await expect(pending).resolves.toBeUndefined();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.disconnected).toBe(false);
  });

  it("does not let a stale ordinary failure clear a disconnected flag a real call set", async () => {
    invokeMock.mockRejectedValueOnce(codedError("HOST_DISCONNECTED"));
    const old = deferred();
    invokeMock.mockReturnValueOnce(old.promise);
    const { result, rerender } = renderTarget({ pluginId: "acme.p", channel: "a" });

    await act(async () => {
      await result.current.invoke({});
    });
    expect(result.current.disconnected).toBe(true);

    let pending!: Promise<{ from: string } | undefined>;
    act(() => {
      pending = result.current.invoke({});
    });
    rerender({ pluginId: "acme.p", channel: "b" });

    await act(async () => {
      old.reject(new Error("SCHEMA_ERROR: bad args"));
      await expect(pending).resolves.toBeUndefined();
    });
    expect(result.current.disconnected).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("keeps a pending call across a rerender with the same target", async () => {
    const call = deferred<{ from: string }>();
    invokeMock.mockReturnValueOnce(call.promise);
    const { result, rerender } = renderTarget({ pluginId: "acme.p", channel: "a" });
    const firstInvoke = result.current.invoke;

    let pending!: Promise<{ from: string } | undefined>;
    act(() => {
      pending = result.current.invoke({});
    });
    rerender({ pluginId: "acme.p", channel: "a" });
    expect(result.current.invoke).toBe(firstInvoke);
    expect(result.current.loading).toBe(true);

    await act(async () => {
      call.resolve({ from: "a" });
      await expect(pending).resolves.toEqual({ from: "a" });
    });
    expect(result.current.loading).toBe(false);
  });
});

describe("useHostChannel first call from an effect", () => {
  function Probe({
    target,
    onSettle,
    report,
  }: {
    target: Target;
    onSettle: (value: unknown) => void;
    report: (state: { loading: boolean; error: Error | null }) => void;
  }) {
    const { invoke, loading, error } = useHostChannel(target.pluginId, target.channel);
    const firedFor = useRef<string | null>(null);
    useEffect(() => {
      const key = `${target.pluginId}\u0000${target.channel}`;
      if (firedFor.current === key) return;
      firedFor.current = key;
      void invoke({}).then(onSettle);
    }, [invoke, target.pluginId, target.channel, onSettle]);
    report({ loading, error });
    return null;
  }

  it("applies a once-only first call made on mount under StrictMode", async () => {
    const first = deferred<{ from: string }>();
    invokeMock.mockReturnValueOnce(first.promise);
    const onSettle = vi.fn();
    const states: Array<{ loading: boolean; error: Error | null }> = [];
    render(
      <StrictMode>
        <Probe
          target={{ pluginId: "acme.p", channel: "a" }}
          onSettle={onSettle}
          report={(s) => states.push(s)}
        />
      </StrictMode>
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.loading).toBe(true);

    await act(async () => {
      first.resolve({ from: "a" });
      await first.promise;
    });
    expect(onSettle).toHaveBeenCalledWith({ from: "a" });
    expect(states.at(-1)).toEqual({ loading: false, error: null });
  });

  it("applies a once-only first call made by an effect right after a target change, with the old call still in flight, under StrictMode", async () => {
    const old = deferred();
    const next = deferred();
    invokeMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const onSettle = vi.fn();
    const states: Array<{ loading: boolean; error: Error | null }> = [];
    const report = (s: { loading: boolean; error: Error | null }) => states.push(s);
    const { rerender } = render(
      <StrictMode>
        <Probe target={{ pluginId: "acme.p", channel: "a" }} onSettle={onSettle} report={report} />
      </StrictMode>
    );
    rerender(
      <StrictMode>
        <Probe target={{ pluginId: "acme.p", channel: "b" }} onSettle={onSettle} report={report} />
      </StrictMode>
    );
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith("acme.p", "b", {});
    expect(states.at(-1)?.loading).toBe(true);

    await act(async () => {
      old.reject(new Error("a failed"));
      await old.promise.catch(() => {});
    });
    expect(states.at(-1)).toEqual({ loading: true, error: null });

    await act(async () => {
      next.reject(new Error("b failed"));
      await next.promise.catch(() => {});
    });
    expect(states.at(-1)?.loading).toBe(false);
    expect(states.at(-1)?.error?.message).toBe("b failed");
    expect(onSettle).toHaveBeenCalledTimes(2);
    expect(onSettle).toHaveBeenNthCalledWith(1, undefined);
    expect(onSettle).toHaveBeenNthCalledWith(2, undefined);
  });
});

describe("useHostChannel first new-target call from a child's effect", () => {
  type Phase = "passive" | "layout";

  function Child({
    target,
    invoke,
    phase,
    onSettle,
  }: {
    target: Target;
    invoke: (args: object) => Promise<unknown>;
    phase: Phase;
    onSettle: (value: unknown) => void;
  }) {
    const firedFor = useRef<string | null>(null);
    const useChosenEffect = phase === "layout" ? useLayoutEffect : useEffect;
    useChosenEffect(() => {
      const key = `${target.pluginId}\u0000${target.channel}`;
      if (firedFor.current === key) return;
      firedFor.current = key;
      void invoke({}).then(onSettle);
    }, [invoke, target.pluginId, target.channel, onSettle]);
    return null;
  }

  function Parent({
    target,
    phase,
    onSettle,
    report,
  }: {
    target: Target;
    phase: Phase;
    onSettle: (value: unknown) => void;
    report: (state: { loading: boolean; error: Error | null }) => void;
  }) {
    const { invoke, loading, error } = useHostChannel(target.pluginId, target.channel);
    report({ loading, error });
    return <Child target={target} invoke={invoke} phase={phase} onSettle={onSettle} />;
  }

  it.each<Phase>(["passive", "layout"])(
    "applies the first new-target call a child's %s effect makes in the commit that changes the target, under StrictMode",
    async (phase) => {
      const old = deferred();
      const next = deferred<{ from: string }>();
      invokeMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
      const onSettle = vi.fn();
      const states: Array<{ loading: boolean; error: Error | null }> = [];
      const report = (s: { loading: boolean; error: Error | null }) => states.push(s);
      const { rerender } = render(
        <StrictMode>
          <Parent
            target={{ pluginId: "acme.p", channel: "a" }}
            phase={phase}
            onSettle={onSettle}
            report={report}
          />
        </StrictMode>
      );
      rerender(
        <StrictMode>
          <Parent
            target={{ pluginId: "acme.p", channel: "b" }}
            phase={phase}
            onSettle={onSettle}
            report={report}
          />
        </StrictMode>
      );
      expect(invokeMock).toHaveBeenCalledTimes(2);
      expect(invokeMock).toHaveBeenLastCalledWith("acme.p", "b", {});
      expect(states.at(-1)).toEqual({ loading: true, error: null });

      await act(async () => {
        old.reject(codedError("HOST_DISCONNECTED"));
        await old.promise.catch(() => {});
      });
      expect(states.at(-1)).toEqual({ loading: true, error: null });

      await act(async () => {
        next.resolve({ from: "b" });
        await next.promise;
      });
      expect(states.at(-1)).toEqual({ loading: false, error: null });
      expect(onSettle).toHaveBeenNthCalledWith(1, undefined);
      expect(onSettle).toHaveBeenNthCalledWith(2, { from: "b" });
    }
  );
});
