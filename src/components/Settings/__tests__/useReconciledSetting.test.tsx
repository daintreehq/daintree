// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useReconciledSetting, type ReconciledWriteResult } from "../useReconciledSetting";

function setup(fallback = "a") {
  const hook = renderHook(() => useReconciledSetting(fallback));
  const writes: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
    result: Promise<ReconciledWriteResult>;
  }> = [];
  const write = (next: string) => {
    act(() => {
      let resolve = () => {};
      let reject: (error: unknown) => void = () => {};
      const sent = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const result = hook.result.current.write(next, () => sent);
      writes.push({ resolve, reject, result });
    });
  };
  /** Settles the nth write: resolved without an error, rejected with one. */
  const settle = async (index: number, error?: unknown): Promise<ReconciledWriteResult> => {
    const pending = writes[index];
    if (!pending) throw new Error(`write ${index} was never sent`);
    let result: ReconciledWriteResult = { status: "saved" };
    await act(async () => {
      if (error === undefined) pending.resolve();
      else pending.reject(error);
      result = await pending.result;
    });
    return result;
  };
  const shown = () => hook.result.current.value;
  return { hook, write, settle, shown };
}

const failure = new Error("write failed");

describe("useReconciledSetting", () => {
  it("shows a write straight away and keeps it once saved", async () => {
    const { write, settle, shown } = setup();
    write("b");
    expect(shown()).toBe("b");
    expect(await settle(0)).toEqual({ status: "saved" });
    expect(shown()).toBe("b");
  });

  it("rolls the newest failed write back to the last confirmed value", async () => {
    const { write, settle, shown } = setup();
    write("b");
    await settle(0);
    write("c");
    expect(await settle(1, failure)).toEqual({ status: "failed", error: failure });
    expect(shown()).toBe("b");
  });

  it("lets an older write that fails after a newer one saved change nothing", async () => {
    const { write, settle, shown } = setup();
    write("b");
    write("c");
    await settle(1);
    expect(await settle(0, failure)).toEqual({ status: "superseded", error: failure });
    expect(shown()).toBe("c");
  });

  it("lets an older write that fails while a newer one is in flight change nothing", async () => {
    const { write, settle, shown } = setup();
    write("b");
    write("c");
    expect((await settle(0, failure)).status).toBe("superseded");
    expect(shown()).toBe("c");
    await settle(1);
    expect(shown()).toBe("c");
  });

  it("keeps showing the newer write when an older one saves first", async () => {
    const { write, settle, shown } = setup();
    write("b");
    write("c");
    await settle(0);
    expect(shown()).toBe("c");
    // The older success is now the confirmed value the newer write falls back to.
    await settle(1, failure);
    expect(shown()).toBe("b");
  });

  it("falls back to an older write still in flight, then past it if that fails too", async () => {
    const { write, settle, shown } = setup();
    write("b");
    write("c");
    await settle(1, failure);
    expect(shown()).toBe("b");
    expect((await settle(0, failure)).status).toBe("superseded");
    expect(shown()).toBe("a");
  });

  it("stays on an older write in flight once it saves after the newest failed", async () => {
    const { write, settle, shown } = setup();
    write("b");
    write("c");
    await settle(1, failure);
    await settle(0);
    expect(shown()).toBe("b");
    write("d");
    await settle(2, failure);
    expect(shown()).toBe("b");
  });

  it("never lets an older success overtake a newer one", async () => {
    const { write, settle, shown } = setup();
    write("b");
    write("c");
    await settle(1);
    await settle(0);
    expect(shown()).toBe("c");
    // The newer success is the confirmed value a later failure falls back to.
    write("d");
    await settle(2, failure);
    expect(shown()).toBe("c");
  });

  it("rolls back to a hydrated value, keeping hydrate stable across renders", async () => {
    const { hook, write, settle, shown } = setup();
    const { hydrate } = hook.result.current;
    act(() => hydrate("loaded"));
    expect(shown()).toBe("loaded");
    expect(hook.result.current.hydrate).toBe(hydrate);

    write("b");
    await settle(0, failure);
    expect(shown()).toBe("loaded");
  });
});
