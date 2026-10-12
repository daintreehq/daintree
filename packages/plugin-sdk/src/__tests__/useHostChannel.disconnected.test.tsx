// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHostChannel } from "../react/useHostChannel";
import { HostDisconnectedError, OutcomeUnknownError } from "../react/hostErrors";

let invokeMock: ReturnType<typeof vi.fn>;

function codedError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  invokeMock = vi.fn();
  vi.stubGlobal("electron", { plugin: { invoke: invokeMock, on: vi.fn(), onPanel: vi.fn() } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useHostChannel when the view's host goes away", () => {
  it("starts connected", () => {
    const { result } = renderHook(() => useHostChannel("acme.p", "query"));
    expect(result.current.disconnected).toBe(false);
  });

  it("reports a call that never reached the host as HostDisconnectedError and disconnected", async () => {
    const cause = codedError("HOST_DISCONNECTED", "The host this window runs on isn't connected");
    invokeMock.mockRejectedValue(cause);
    const { result } = renderHook(() => useHostChannel("acme.p", "query"));
    await act(async () => {
      await result.current.invoke({});
    });
    expect(result.current.error).toBeInstanceOf(HostDisconnectedError);
    expect(result.current.error?.message).toBe(cause.message);
    expect((result.current.error as HostDisconnectedError).cause).toBe(cause);
    expect(result.current.disconnected).toBe(true);
  });

  it("reports a lost answer as OutcomeUnknownError, and clears once a call gets through", async () => {
    invokeMock.mockRejectedValueOnce(codedError("OUTCOME_UNKNOWN"));
    const { result } = renderHook(() => useHostChannel("acme.p", "query"));
    await act(async () => {
      await result.current.invoke({});
    });
    expect(result.current.error).toBeInstanceOf(OutcomeUnknownError);
    expect((result.current.error as OutcomeUnknownError).code).toBe("OUTCOME_UNKNOWN");
    expect(result.current.disconnected).toBe(true);

    invokeMock.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      await result.current.invoke({});
    });
    expect(result.current.disconnected).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("leaves every other failure as it was, and connected", async () => {
    invokeMock.mockRejectedValue(new Error("SCHEMA_ERROR: bad args"));
    const { result } = renderHook(() => useHostChannel("acme.p", "query"));
    await act(async () => {
      await result.current.invoke({});
    });
    expect(result.current.error).not.toBeInstanceOf(HostDisconnectedError);
    expect(result.current.error?.message).toMatch(/SCHEMA_ERROR/);
    expect(result.current.disconnected).toBe(false);
  });

  it("is exported from the package's react entry", async () => {
    const mod = await import("../react");
    expect(mod.HostDisconnectedError).toBe(HostDisconnectedError);
    expect(mod.OutcomeUnknownError).toBe(OutcomeUnknownError);
  });
});
