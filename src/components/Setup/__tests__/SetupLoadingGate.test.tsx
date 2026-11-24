// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { StatusIcon } from "../SystemToolsStep";

vi.mock("@/clients", () => ({ systemClient: { openExternal: vi.fn() } }));
vi.mock("@/lib/agentInstall", () => ({ detectOS: () => "macos" }));
vi.mock("../InstallBlock", () => ({ InstallBlock: () => null }));

describe("StatusIcon Doherty gate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders no spinner on frame 0 and shows it after 400ms", () => {
    const { container } = render(<StatusIcon check={null} loading />);
    expect(container.querySelector(".animate-spin")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(container.querySelector(".animate-spin")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("never shows the spinner when the check settles inside the gate", () => {
    const { container, rerender } = render(<StatusIcon check={null} loading />);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender(
      <StatusIcon check={{ available: true, meetsMinVersion: true } as never} loading={false} />
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector(".animate-spin")).toBeNull();
  });
});
