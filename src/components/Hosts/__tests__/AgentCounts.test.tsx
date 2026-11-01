// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { AgentCounts } from "../AgentCounts";
import { makeSummary } from "../Overview/__tests__/fixtures";

afterEach(cleanup);

function spoken(summary: HostMetricsSummary, quietZero = false): string {
  const { container } = render(<AgentCounts summary={summary} quietZero={quietZero} />);
  return container.querySelector(".sr-only")?.textContent ?? "";
}

describe("AgentCounts", () => {
  it("never says a host's runs at their prompts are waiting (#16058)", () => {
    const summary = makeSummary({
      agentsObserved: { working: 1, waiting: 3, idle: 0 },
      agentAttention: { waiting: 0, blocked: 0, idle: 3 },
    });
    expect(spoken(summary)).toBe("Agents: 1 working (observed)");
  });

  it("says the asks a reading found, and the blocked runs, ahead of the working ones", () => {
    const summary = makeSummary({
      agentsObserved: { working: 2, waiting: 3, idle: 0 },
      agentAttention: { waiting: 1, blocked: 1, idle: 1 },
    });
    expect(spoken(summary)).toBe("Agents: 1 blocked, 1 waiting, 2 working (observed)");
  });

  it("says nothing about waiting for a host too old to band its runs", () => {
    const summary = makeSummary({
      agentsObserved: { working: 0, waiting: 2, idle: 0 },
      agentAttention: undefined,
    });
    expect(spoken(summary, true)).toBe("No agents waiting or working (observed)");
  });
});
