// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import { RelayUpdateBanner } from "../RelayUpdateBanner";

describe("RelayUpdateBanner", () => {
  afterEach(() => {
    cleanup();
    dispatch.mockReset();
  });

  it("opens Decisions settings at Connection, where the relay is checked again", () => {
    const onDismiss = vi.fn();
    render(
      <TooltipProvider>
        <RelayUpdateBanner onDismiss={onDismiss} />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Decisions settings" }));

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      "app.settings.openTab",
      { tab: "decisions", sectionId: "decisions-connection" },
      { source: "user" }
    );
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("can be put away", () => {
    const onDismiss = vi.fn();
    render(
      <TooltipProvider>
        <RelayUpdateBanner onDismiss={onDismiss} />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
