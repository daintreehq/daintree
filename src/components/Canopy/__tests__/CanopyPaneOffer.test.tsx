// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCanopyStore } from "@/store/canopyStore";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";

const dispatchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
const host = vi.hoisted(() => ({ name: null as string | null }));
vi.mock("@/hooks/useHostPlatform", () => ({ useHostPlatform: () => ({ hostName: host.name }) }));

import { CanopyPaneOffer } from "../CanopyPaneOffer";

afterEach(() => {
  cleanup();
  dispatchMock.mockClear();
  useCanopyStore.setState({ isOpen: false, snapshot: null });
  host.name = null;
});

const MODEL_ID = "daintreehq/canopy-reader-17m";

function withModel(model: CanopySnapshot["model"]): void {
  useCanopyStore.setState({
    snapshot: {
      mode: "on",
      activated: true,
      model,
      dispositions: [],
      seen: [],
      reads: [],
      scope: null,
      active: false,
      busy: false,
      refreshedAt: null,
      cards: [],
      glances: [],
      lastError: null,
      failedRuns: [],
    },
  });
}

function turnedOn(): HTMLElement {
  const { container } = render(
    <TooltipProvider>
      <CanopyPaneOffer panelId="p1" state="turned-on" agentName="Claude" reason="question" />
    </TooltipProvider>
  );
  return container;
}

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

  it("says Canopy is reading once its model is ready, and not before", () => {
    withModel({ id: MODEL_ID, status: "ready" });
    let container = turnedOn();
    expect(container.textContent).toContain("It's reading your agents' screens.");
    expect(container.textContent).not.toMatch(/download/i);
    cleanup();

    // Still being checked: on, but nothing is read yet.
    withModel(undefined);
    container = turnedOn();
    expect(container.textContent).toContain("Canopy is on");
    expect(container.textContent).toContain("once its model is ready");
    expect(container.textContent).not.toContain("It's reading");
  });

  it("says a model that isn't available, offering no download to retry", () => {
    withModel({ id: MODEL_ID, status: "failed", error: "missing" });
    const container = turnedOn();
    expect(container.textContent).toContain("Canopy's model isn't available");
    expect(container.textContent).toContain("Reinstalling Daintree puts it back");
    expect(container.textContent).not.toMatch(/download|connection/i);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("never tells another host's user its download failed, nor to retry one", () => {
    // That host may be on a Daintree from before the model shipped with it.
    host.name = "studio-01";
    withModel({ id: MODEL_ID, status: "failed", error: "HTTP 503" });
    const container = turnedOn();
    expect(container.textContent).toContain("isn't available");
    expect(container.textContent).toContain("Updating or reinstalling Daintree there");
    expect(container.textContent).not.toMatch(/download|HTTP|missing or damaged/i);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("waits for an older host's model without its progress", () => {
    withModel({ id: MODEL_ID, status: "downloading", received: 1, total: 2 });
    const container = turnedOn();
    expect(container.textContent).toContain("once its model is ready");
    expect(container.textContent).not.toMatch(/download/i);
  });
});
