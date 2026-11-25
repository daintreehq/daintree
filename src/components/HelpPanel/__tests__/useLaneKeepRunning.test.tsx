// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLaneKeepRunning } from "../useLaneKeepRunning";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

function installHelp(help: { getKeepRunning?: unknown; setKeepRunning?: unknown }) {
  Object.assign(window, { electron: { help } });
}

const flush = () => act(async () => {});

describe("useLaneKeepRunning (#18177)", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
  });

  it("reads the lane on screen's choice, and nothing for no project", async () => {
    const getKeepRunning = vi.fn(async (_projectId: string, slot: number) => slot === 1);
    installHelp({ getKeepRunning, setKeepRunning: vi.fn() });

    const { result, rerender } = renderHook(
      ({ projectId, slot }: { projectId: string | null; slot: number }) =>
        useLaneKeepRunning(projectId, slot),
      { initialProps: { projectId: "proj-1" as string | null, slot: 0 } }
    );
    expect(result.current.keepRunning).toBeNull();
    await flush();
    expect(result.current.keepRunning).toBe(false);

    rerender({ projectId: "proj-1", slot: 1 });
    // Never the previous lane's answer while this one's is read.
    expect(result.current.keepRunning).toBeNull();
    await flush();
    expect(result.current.keepRunning).toBe(true);

    rerender({ projectId: null, slot: 1 });
    expect(result.current.keepRunning).toBeNull();
    expect(getKeepRunning).toHaveBeenCalledTimes(2);
  });

  it("shows a change at once and settles on what main holds, never undone by an earlier read", async () => {
    const read = deferred<boolean>();
    const getKeepRunning = vi.fn(() => read.promise);
    const setKeepRunning = vi.fn(async () => false);
    installHelp({ getKeepRunning, setKeepRunning });
    const { result } = renderHook(() => useLaneKeepRunning("proj-1", 0));

    act(() => result.current.setKeepRunning(true));
    expect(result.current.keepRunning).toBe(true);
    expect(setKeepRunning).toHaveBeenCalledWith("proj-1", 0, true);
    await flush();
    // Main couldn't keep it: what it holds is what shows.
    expect(result.current.keepRunning).toBe(false);

    read.resolve(true);
    await flush();
    expect(result.current.keepRunning).toBe(false);
  });

  it("reads it again on refresh, after a Stop elsewhere turned it off", async () => {
    let held = true;
    installHelp({ getKeepRunning: vi.fn(async () => held), setKeepRunning: vi.fn() });
    const { result } = renderHook(() => useLaneKeepRunning("proj-1", 0));
    await flush();
    expect(result.current.keepRunning).toBe(true);

    held = false;
    act(() => result.current.refresh());
    await flush();
    expect(result.current.keepRunning).toBe(false);
  });
});
