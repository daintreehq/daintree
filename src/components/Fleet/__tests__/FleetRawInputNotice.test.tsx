// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { FleetRawInputNotice, describeRawInputSkippedTargets } from "../FleetRawInputNotice";
import {
  _resetCrossHostFleetForTesting,
  armCrossHostTarget,
  crossHostTargetKey,
  disarmCrossHostTarget,
  type CrossHostFleetTarget,
} from "../crossHostFleet";

function target(hostId: string, terminalId: string, hostName = hostId): CrossHostFleetTarget {
  return {
    key: crossHostTargetKey(hostId, terminalId),
    hostId,
    hostName,
    terminalId,
    title: terminalId,
  };
}

describe("describeRawInputSkippedTargets", () => {
  it("says nothing while the fleet has no agents on other hosts", () => {
    expect(describeRawInputSkippedTargets([])).toBeNull();
  });

  it("names the host when every skipped agent is on one", () => {
    expect(describeRawInputSkippedTargets([target("h1", "a", "mini")])).toBe(
      "Typing here skips 1 agent on mini"
    );
    expect(
      describeRawInputSkippedTargets([target("h1", "a", "mini"), target("h1", "b", "mini")])
    ).toBe("Typing here skips 2 agents on mini");
  });

  it("counts the hosts when the skipped agents span several", () => {
    expect(
      describeRawInputSkippedTargets([
        target("h1", "a", "mini"),
        target("h2", "b", "studio"),
        target("h2", "c", "studio"),
      ])
    ).toBe("Typing here skips 3 agents on 2 hosts");
  });

  it("keeps two hosts that share a name apart", () => {
    expect(
      describeRawInputSkippedTargets([target("h1", "a", "mac"), target("h2", "b", "mac")])
    ).toBe("Typing here skips 2 agents on 2 hosts");
  });
});

describe("FleetRawInputNotice", () => {
  beforeEach(() => {
    _resetCrossHostFleetForTesting();
  });

  it("renders nothing while no agent on another host is armed", () => {
    const { container } = render(<FleetRawInputNotice composerReachesFleet={true} />);
    expect(container.firstChild).toBeNull();
  });

  it("follows the fleet as agents on other hosts are armed and disarmed", () => {
    render(<FleetRawInputNotice composerReachesFleet={false} />);
    expect(screen.queryByRole("note")).toBeNull();

    act(() => {
      armCrossHostTarget({ hostId: "h1", hostName: "mini", terminalId: "a", title: "Claude" });
    });
    expect(screen.getByRole("note").textContent).toBe("Typing here skips 1 agent on mini");

    act(() => {
      disarmCrossHostTarget(crossHostTargetKey("h1", "a"));
    });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("points at the composer only when the pane has one that can send", () => {
    act(() => {
      armCrossHostTarget({ hostId: "h1", hostName: "mini", terminalId: "a", title: "Claude" });
    });
    const { rerender } = render(<FleetRawInputNotice composerReachesFleet={false} />);
    expect(screen.getByRole("note").textContent).not.toContain("composer");

    rerender(<FleetRawInputNotice composerReachesFleet={true} />);
    const text = screen.getByRole("note").textContent ?? "";
    expect(text.startsWith("Typing here skips 1 agent on mini")).toBe(true);
    expect(text).toContain("composer");
  });
});
