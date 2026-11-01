// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Fleet/crossHostFleet", () => ({
  armCrossHostTarget: vi.fn(),
  crossHostTargetKey: (hostId: string, terminalId: string) => `${hostId}:${terminalId}`,
  disarmCrossHostTarget: vi.fn(),
  useArmedCrossHostTargets: () => [],
}));

import { HostFleetTargets } from "../HostFleetTargets";
import type { HostFleetTarget } from "@shared/types/ipc/hostMetrics";

afterEach(() => cleanup());

describe("HostFleetTargets", () => {
  it("names the host its button adds agents from, since every host card has one", () => {
    render(
      <>
        <HostFleetTargets hostId="studio-02" hostName="studio-02" />
        <HostFleetTargets hostId="studio-04" hostName="studio-04" />
      </>
    );
    expect(
      screen.getByRole("button", { name: "Add agents on studio-02 to the fleet" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add agents on studio-04 to the fleet" })
    ).toBeTruthy();
  });

  // The host's read carries no fleet band, and amber is the band's needs-you
  // alone, so an observed wait keeps its ring in the neutral ink (#16059).
  it("draws an observed wait without the waiting hue", async () => {
    const target = (terminalId: string, agentState: HostFleetTarget["agentState"]) => ({
      hostId: "studio-02",
      terminalId,
      title: terminalId,
      projectId: "p1",
      projectName: "app",
      agentId: "claude",
      agentState,
    });
    Object.defineProperty(window, "electron", {
      value: {
        hostMetrics: {
          listFleetTargets: vi.fn(async () => ({
            targets: [target("waits", "waiting"), target("works", "working")],
            complete: true,
          })),
        },
      },
      configurable: true,
      writable: true,
    });
    render(<HostFleetTargets hostId="studio-02" hostName="studio-02" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add agents on studio-02 to the fleet" }));
    });
    await act(async () => {});

    expect(document.querySelector('[class*="text-state-waiting"]')).toBeNull();
    expect(document.querySelector(".text-state-working")).not.toBeNull();
  });
});
