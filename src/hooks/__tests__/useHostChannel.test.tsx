// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHostChannel } from "../useHostChannel";

const invokeMock = vi.fn();

beforeEach(() => {
  invokeMock.mockReset();
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { plugin: { invoke: invokeMock } },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useHostChannel", () => {
  it("populates data from a successful envelope", async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { greeting: "hi" } });
    const { result } = renderHook(() =>
      useHostChannel<{ name: string }, { greeting: string }>("acme.plugin", "greet")
    );

    await act(async () => {
      result.current.invoke({ name: "ada" });
    });

    await waitFor(() => expect(result.current.data).toEqual({ greeting: "hi" }));
    expect(result.current.error).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("acme.plugin", "greet", { name: "ada" });
  });

  it("populates error from a VALIDATION_FAILED envelope", async () => {
    invokeMock.mockResolvedValue({
      ok: false,
      code: "VALIDATION_FAILED",
      issues: [{ code: "invalid_type", message: "Expected string", path: ["name"] }],
    });
    const { result } = renderHook(() => useHostChannel("acme.plugin", "greet"));

    await act(async () => {
      result.current.invoke({ name: 123 });
    });

    await waitFor(() => expect(result.current.error?.code).toBe("VALIDATION_FAILED"));
    expect(result.current.data).toBeNull();
  });

  it("populates error from a PERMISSION_REQUIRED envelope", async () => {
    invokeMock.mockResolvedValue({
      ok: false,
      code: "PERMISSION_REQUIRED",
      missing: ["shell:exec"],
    });
    const { result } = renderHook(() => useHostChannel("acme.plugin", "run"));

    await act(async () => {
      result.current.invoke({});
    });

    await waitFor(() => expect(result.current.error?.code).toBe("PERMISSION_REQUIRED"));
  });

  it("synthesizes HANDLER_NOT_FOUND when the invoke rejects", async () => {
    invokeMock.mockRejectedValue(new Error("No plugin handler registered for acme.plugin:missing"));
    const { result } = renderHook(() => useHostChannel("acme.plugin", "missing"));

    await act(async () => {
      result.current.invoke({});
    });

    await waitFor(() => expect(result.current.error?.code).toBe("HANDLER_NOT_FOUND"));
    expect(result.current.error).toEqual({
      ok: false,
      code: "HANDLER_NOT_FOUND",
      channel: "missing",
    });
  });

  it("clears a prior error on a subsequent successful call", async () => {
    invokeMock.mockResolvedValueOnce({
      ok: false,
      code: "PERMISSION_REQUIRED",
      missing: ["git:write"],
    });
    const { result } = renderHook(() => useHostChannel("acme.plugin", "run"));

    await act(async () => {
      result.current.invoke({});
    });
    await waitFor(() => expect(result.current.error?.code).toBe("PERMISSION_REQUIRED"));

    invokeMock.mockResolvedValueOnce({ ok: true, data: "done" });
    await act(async () => {
      result.current.invoke({});
    });

    await waitFor(() => expect(result.current.data).toBe("done"));
    expect(result.current.error).toBeNull();
  });

  it("clears stale data when a later call fails", async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, data: "secret" });
    const { result } = renderHook(() => useHostChannel("acme.plugin", "run"));

    await act(async () => {
      result.current.invoke({});
    });
    await waitFor(() => expect(result.current.data).toBe("secret"));

    invokeMock.mockResolvedValueOnce({
      ok: false,
      code: "PERMISSION_REQUIRED",
      missing: ["git:write"],
    });
    await act(async () => {
      result.current.invoke({});
    });

    await waitFor(() => expect(result.current.error?.code).toBe("PERMISSION_REQUIRED"));
    // Old payload must not linger next to the fresh denial.
    expect(result.current.data).toBeNull();
  });

  it("ignores a slower earlier invoke that resolves after a newer one (last-write-wins)", async () => {
    const deferreds: Array<(v: unknown) => void> = [];
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferreds.push(resolve);
        })
    );
    const { result } = renderHook(() => useHostChannel<unknown, string>("acme.plugin", "run"));

    act(() => {
      result.current.invoke("A");
    });
    act(() => {
      result.current.invoke("B");
    });

    // Resolve the newer call (B) first, then the older call (A).
    await act(async () => {
      deferreds[1]?.({ ok: true, data: "B" });
    });
    await act(async () => {
      deferreds[0]?.({ ok: true, data: "A" });
    });

    // A is stale — it must not clobber B's result.
    expect(result.current.data).toBe("B");
  });

  it("treats a raw (non-envelope) resolution as success data for legacy channels", async () => {
    invokeMock.mockResolvedValue("legacy-value");
    const { result } = renderHook(() => useHostChannel("acme.plugin", "legacy"));

    await act(async () => {
      result.current.invoke({});
    });

    await waitFor(() => expect(result.current.data).toBe("legacy-value"));
  });

  it("does not set state after unmount", async () => {
    let resolveInvoke: (v: unknown) => void = () => {};
    invokeMock.mockReturnValue(
      new Promise((resolve) => {
        resolveInvoke = resolve;
      })
    );
    const { result, unmount } = renderHook(() => useHostChannel("acme.plugin", "greet"));

    act(() => {
      result.current.invoke({});
    });
    unmount();

    await act(async () => {
      resolveInvoke({ ok: true, data: "late" });
    });
    // No setState-on-unmounted warning is the implicit pass; state stayed null.
    expect(result.current.data).toBeNull();
  });
});
