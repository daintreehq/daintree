// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../HostAgentSignInDialog", () => ({
  HostAgentSignInDialog: (props: {
    hostId: string;
    hostName: string;
    agentId: string;
    agentName: string;
    offered: { consumer: string };
  }) => (
    <div
      data-testid="sign-in-dialog"
      data-title={`Sign in to ${props.agentName} on ${props.hostName}`}
      data-consumer={props.offered.consumer}
    />
  ),
}));

import HostSignInOfferDialog from "../HostSignInOfferDialog";
import { holdSignInDialog } from "../signInDialogHold";

const OFFER = {
  hostId: "studio",
  hostName: "Studio",
  agentId: "claude",
  consumer: "offer-1",
  terminal: { terminalId: "daintree-sign-in-1", spawnedAt: 1 },
  expiresAt: Date.now() + 30_000,
};

describe("HostSignInOfferDialog (#18197)", () => {
  it("opens the CLI's row dialog on the offered sign-in, named as the registry names it", () => {
    const settled = vi.fn();
    render(<HostSignInOfferDialog offer={OFFER} onSettled={settled} onClose={() => {}} />);
    const dialog = screen.getByTestId("sign-in-dialog");
    expect(dialog.getAttribute("data-title")).toBe("Sign in to Claude on Studio");
    expect(dialog.getAttribute("data-consumer")).toBe("offer-1");
    expect(settled).not.toHaveBeenCalled();
  });

  it("gives way to a sign-in the person opened while it loaded", () => {
    const settled = vi.fn();
    const letGo = holdSignInDialog();
    try {
      render(<HostSignInOfferDialog offer={OFFER} onSettled={settled} onClose={() => {}} />);
      expect(screen.queryByTestId("sign-in-dialog")).toBeNull();
      expect(settled).toHaveBeenCalledWith("gone");
    } finally {
      letGo();
    }
  });
});
