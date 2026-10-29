// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrantCountdown } from "../GrantCountdown";

describe("GrantCountdown (#14998)", () => {
  let base: number;

  beforeEach(() => {
    vi.useFakeTimers();
    base = Date.now();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts to the sliding expiry while it ends the grant first", () => {
    const { getByRole } = render(
      <GrantCountdown expiresAt={base + 300_000} maxExpiresAt={base + 900_000} />
    );
    expect(getByRole("timer").textContent).toBe("5m left");
  });

  it("counts to the ceiling and names it once no use can extend the grant", () => {
    const { getByRole } = render(
      <GrantCountdown expiresAt={base + 900_000} maxExpiresAt={base + 300_000} />
    );
    expect(getByRole("timer").textContent).toBe("5m left · 30-minute limit");
    act(() => {
      vi.advanceTimersByTime(300_001);
    });
    expect(getByRole("timer").textContent).toBe("expiring");
  });

  it("moves with a re-read expiry instead of reading 'expiring' while the grant lives", () => {
    const { getByRole, rerender } = render(<GrantCountdown expiresAt={base + 5_000} />);
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(getByRole("timer").textContent).toBe("expiring");

    rerender(<GrantCountdown expiresAt={base + 606_000} />);
    expect(getByRole("timer").textContent).toBe("10m left");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(getByRole("timer").textContent).toBe("9m left");
  });
});
