// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const clock = vi.hoisted(() => ({ now: 0 }));
vi.mock("@/hooks/useGlobalMinuteTicker", () => ({
  useGlobalMinuteClock: () => clock.now,
}));

import { TerminalRateLimitBadge } from "../TerminalRateLimitBadge";
import {
  RATE_LIMIT_OBSERVATION_TTL_MS,
  useRateLimitObservationStore,
} from "@/store/rateLimitObservationStore";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderBadge(terminalId: string) {
  return render(
    <TooltipProvider>
      <TerminalRateLimitBadge terminalId={terminalId} />
    </TooltipProvider>
  );
}

afterEach(() => {
  cleanup();
  useRateLimitObservationStore.setState({ observedAtByTerminalId: {} });
});

describe("TerminalRateLimitBadge (#12797)", () => {
  it("renders nothing for a pane with no observation", () => {
    renderBadge("t1");
    expect(screen.queryByTestId("terminal-rate-limit-badge")).toBeNull();
  });

  it("shows the observation only on the pane it was seen in", () => {
    const observedAt = 1_700_000_000_000;
    clock.now = observedAt + 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });

    renderBadge("t1");
    renderBadge("t2");

    const badges = screen.queryAllByTestId("terminal-rate-limit-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe("Rate limit seen");
  });

  it("disappears once the retention window has passed", () => {
    const observedAt = 1_700_000_000_000;
    clock.now = observedAt + RATE_LIMIT_OBSERVATION_TTL_MS - 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });

    const view = renderBadge("t1");
    expect(screen.queryByTestId("terminal-rate-limit-badge")).not.toBeNull();

    clock.now = observedAt + RATE_LIMIT_OBSERVATION_TTL_MS;
    view.rerender(
      <TooltipProvider>
        <TerminalRateLimitBadge terminalId="t1" />
      </TooltipProvider>
    );
    expect(screen.queryByTestId("terminal-rate-limit-badge")).toBeNull();
  });
});
