// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import { RelayDeployBanner } from "../RelayDeployBanner";

describe("RelayDeployBanner", () => {
  afterEach(() => {
    cleanup();
    dispatch.mockReset();
  });

  it("opens Decisions settings on the relay URL field", () => {
    const onDismiss = vi.fn();
    render(
      <TooltipProvider>
        <RelayDeployBanner onDismiss={onDismiss} />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect relay…" }));

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      "app.settings.openTab",
      { tab: "decisions", sectionId: "decisions-relay-url" },
      { source: "user" }
    );
    // The way back leaves the pane, and its banner, as they are.
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("can be put away", () => {
    const onDismiss = vi.fn();
    render(
      <TooltipProvider>
        <RelayDeployBanner onDismiss={onDismiss} />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
