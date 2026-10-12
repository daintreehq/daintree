// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Fleet/crossHostFleet", () => ({
  armCrossHostTarget: vi.fn(),
  crossHostTargetKey: (hostId: string, terminalId: string) => `${hostId}:${terminalId}`,
  disarmCrossHostTarget: vi.fn(),
  useArmedCrossHostTargets: () => [],
}));

import { HostFleetTargets } from "../HostFleetTargets";

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
});
