/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const dispatch = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatch(...args) },
}));

import { useForgeBadgeTooltip } from "../useForgeBadgeTooltip";

function setup(overrides: Partial<Parameters<typeof useForgeBadgeTooltip>[0]> = {}) {
  const onOpen = vi.fn();
  const fetchTooltip = vi.fn(async () => {});
  const reset = vi.fn();
  const { result } = renderHook(() =>
    useForgeBadgeTooltip({
      fetchTooltip,
      reset,
      missingCredential: false,
      providerId: "daintree.github.github",
      onOpen,
      ...overrides,
    })
  );
  return { result, onOpen, fetchTooltip, reset };
}

beforeEach(() => {
  dispatch.mockClear();
});

describe("useForgeBadgeTooltip click (#15864)", () => {
  it("opens the reference on its first click, with no notion of which card is active", () => {
    const { result, onOpen } = setup();
    act(() => result.current.handleClick());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("routes to the provider's settings instead when no token is configured", () => {
    const { result, onOpen } = setup({ missingCredential: true });
    act(() => result.current.handleClick());
    expect(onOpen).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "code-forge", subtab: "daintree.github.github" },
      { source: "user" }
    );
  });
});

describe("useForgeBadgeTooltip hover card", () => {
  it("fetches on open and resets on close", () => {
    const { result, fetchTooltip, reset } = setup();
    act(() => result.current.handleOpenChange(true));
    expect(result.current.isOpen).toBe(true);
    expect(fetchTooltip).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    act(() => result.current.handleOpenChange(false));
    expect(result.current.isOpen).toBe(false);
    expect(fetchTooltip).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
