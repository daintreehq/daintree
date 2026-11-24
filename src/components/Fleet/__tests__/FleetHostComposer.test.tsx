// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, act } from "@testing-library/react";

const sendDraftToFleet = vi.hoisted(() => vi.fn(async (_text: string) => true));

vi.mock("../fleetEnterBroadcast", () => ({ sendDraftToFleet }));
vi.mock("../crossHostFleet", () => ({
  useArmedCrossHostTargets: () => [{ hostName: "box", title: "Agent" }],
}));

import { FleetHostComposer } from "../FleetHostComposer";

describe("FleetHostComposer", () => {
  beforeEach(() => {
    sendDraftToFleet.mockClear();
  });

  const type = (value: string) =>
    fireEvent.change(screen.getByTestId("fleet-host-composer"), { target: { value } });
  const enter = async () => {
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("fleet-host-composer"), { key: "Enter" });
    });
  };

  it("sends the draft exactly as typed, indentation and trailing newline included", async () => {
    render(<FleetHostComposer />);
    type("    indented()\n");
    await enter();
    expect(sendDraftToFleet).toHaveBeenCalledWith("    indented()\n");
  });

  it("does not send whitespace-only input", async () => {
    render(<FleetHostComposer />);
    type(" \n\t ");
    await enter();
    expect(sendDraftToFleet).not.toHaveBeenCalled();
  });
});
