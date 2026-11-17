// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useReconciledSetting, type ReconciledWriteResult } from "../useReconciledSetting";

function deferredSend() {
  const pending: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  const send = () =>
    new Promise<void>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  return { send, pending };
}

function setup(fallback = "a") {
  const hook = renderHook(() => useReconciledSetting(fallback));
  const { send, pending } = deferredSend();
  const results: Array<Promise<ReconciledWriteResult>> = [];
  const write = (next: string) => {
    act(() => {
      results.push(hook.result.current.write(next, send));
    });
  };
  const settle = async (index: number, outcome: "resolve" | "reject") => {
    await act(async () => {
      if (outcome === "resolve") pending[index].resolve();
      else pending[index].reject(new Error(`write ${index} failed`));
      await results[index];
    });
    return results[index];
  };
  return { hook, write, settle };
}

describe("useReconciledSetting", () => {
  it("shows a write straight away and keeps it once saved", async () => {
    const { hook, write, settle } = setup();
    write("b");
    expect(hook.result.current.value).toBe("b");
    expect(await settle(0, "resolve")).toEqual({ status: "saved" });
    expect(hook.result.current.value).toBe("b");
  });

  it("rolls the newest failed write back to the last confirmed value", async () => {
    const { hook, write, settle } = setup();
    write("b");
    await settle(0, "resolve");
    write("c");
    const result = await settle(1, "reject");
    expect(result.status).toBe("failed");
    expect(hook.result.current.value).toBe("b");
  });

  it("lets an older write that fails after a newer one saved change nothing", async () => {
    const { hook, write, settle } = setup();
    write("b");
    write("c");
    await settle(1, "resolve");
    const result = await settle(0, "reject");
    expect(result.status).toBe("superseded");
    expect(hook.result.current.value).toBe("c");
  });

  it("lets an older write that fails while a newer one is pending change nothing", async () => {
    const { hook, write, settle } = setup();
    write("b");
    write("c");
    expect((await settle(0, "reject")).status).toBe("superseded");
    expect(hook.result.current.value).toBe("c");
    await settle(1, "resolve");
    expect(hook.result.current.value).toBe("c");
  });

  it("follows an older write that lands after the newest one failed", async () => {
    const { hook, write, settle } = setup();
    write("b");
    write("c");
    await settle(1, "reject");
    expect(hook.result.current.value).toBe("a");
    await settle(0, "resolve");
    expect(hook.result.current.value).toBe("b");
  });

  it("never lets an older success overtake a newer one", async () => {
    const { hook, write, settle } = setup();
    write("b");
    write("c");
    await settle(1, "resolve");
    await settle(0, "resolve");
    expect(hook.result.current.value).toBe("c");
    // The newer success is the confirmed value a later failure falls back to.
    write("d");
    await settle(2, "reject");
    expect(hook.result.current.value).toBe("c");
  });

  it("rolls back to a hydrated value, keeping hydrate stable across renders", async () => {
    const { hook, write, settle } = setup();
    const { hydrate } = hook.result.current;
    act(() => hydrate("loaded"));
    expect(hook.result.current.value).toBe("loaded");
    expect(hook.result.current.hydrate).toBe(hydrate);

    write("b");
    await settle(0, "reject");
    expect(hook.result.current.value).toBe("loaded");
  });
});
