// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRetainedDialog } from "../useRetainedDialog";

describe("useRetainedDialog", () => {
  it("mounts nothing until the dialog is first opened", () => {
    const { result } = renderHook(() => useRetainedDialog());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.isMounted).toBe(false);
  });

  it("stays mounted through the exit and unmounts once it completes", () => {
    const { result } = renderHook(() => useRetainedDialog());
    act(() => result.current.open());
    expect(result.current.isMounted).toBe(true);

    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.isMounted).toBe(true);

    act(() => result.current.onCloseComplete());
    expect(result.current.isMounted).toBe(false);
  });

  it("reopens during its exit and retains again through the next close", () => {
    const { result } = renderHook(() => useRetainedDialog());
    act(() => result.current.open());
    act(() => result.current.close());
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);

    act(() => result.current.close());
    expect(result.current.isMounted).toBe(true);
    act(() => result.current.onCloseComplete());
    expect(result.current.isMounted).toBe(false);
  });

  it("reset closes and unmounts in one step", () => {
    const { result } = renderHook(() => useRetainedDialog());
    act(() => result.current.open());
    act(() => result.current.reset());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.isMounted).toBe(false);
  });
});
