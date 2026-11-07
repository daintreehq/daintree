// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCanopyStore } from "@/store/canopyStore";

const dispatchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
vi.mock("@/hooks/useHostPlatform", () => ({ useHostPlatform: () => ({ hostName: null }) }));

import { CanopyPaneOffer } from "../CanopyPaneOffer";

afterEach(() => {
  cleanup();
  dispatchMock.mockClear();
  useCanopyStore.setState({ isOpen: false });
});

describe("CanopyPaneOffer", () => {
  it("opens Canopy through the toggle, so a window opened since comes forward", () => {
    render(
      <TooltipProvider>
        <CanopyPaneOffer panelId="p1" state="turned-on" agentName="Claude" reason="question" />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Canopy" }));

    expect(dispatchMock).toHaveBeenCalledWith("canopy.toggle", undefined, { source: "user" });
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });
});
