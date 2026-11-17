// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { FleetHostComposer } from "../FleetHostComposer";
import { crossHostTargetKey } from "../crossHostFleet";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const submitFleet = vi.fn();
let hadElectron = false;
let previousHostMetrics: unknown;

function armRemote(terminalId: string) {
  useFleetArmingStore.getState().armCrossHostTarget({
    key: crossHostTargetKey("studio", terminalId),
    hostId: "studio",
    hostName: "Studio",
    terminalId,
    title: terminalId,
  });
}

function field(): HTMLTextAreaElement {
  return screen.getByTestId("fleet-host-composer") as HTMLTextAreaElement;
}

function typeDraft(text: string) {
  const el = field();
  el.focus();
  fireEvent.change(el, { target: { value: text } });
}

const IME_SIGNALS = [
  { signal: "isComposing", init: { isComposing: true } },
  { signal: "keyCode 229", init: { keyCode: 229 } },
];

describe("FleetHostComposer — an IME's Enter and Escape (#17450)", () => {
  beforeEach(() => {
    useFleetArmingStore.setState({
      armedIds: new Set<string>(),
      armOrder: [],
      armOrderById: {},
      lastArmedId: null,
      previewArmedIds: new Set<string>(),
      crossHostTargets: [],
    });
    submitFleet.mockReset().mockResolvedValue(undefined);
    const electron = (window as unknown as { electron?: Record<string, unknown> }).electron;
    hadElectron = electron !== undefined;
    previousHostMetrics = electron?.hostMetrics;
    if (electron) {
      electron.hostMetrics = { submitFleet };
    } else {
      (window as unknown as { electron: unknown }).electron = { hostMetrics: { submitFleet } };
    }
    armRemote("t1");
  });

  afterEach(() => {
    const electron = (window as unknown as { electron?: Record<string, unknown> }).electron;
    if (hadElectron && electron) electron.hostMetrics = previousHostMetrics;
    else delete (window as unknown as { electron?: unknown }).electron;
  });

  it.each(IME_SIGNALS)(
    "keeps the draft and sends nothing when an IME's Enter confirms a candidate ($signal)",
    async ({ init }) => {
      render(<FleetHostComposer />);
      typeDraft("ni hao");

      let notPrevented = false;
      await act(async () => {
        notPrevented = fireEvent.keyDown(field(), { key: "Enter", ...init });
      });

      // The IME still gets the key to commit its candidate.
      expect(notPrevented).toBe(true);
      expect(submitFleet).not.toHaveBeenCalled();
      expect(field().value).toBe("ni hao");
      expect(document.activeElement).toBe(field());
    }
  );

  it.each(IME_SIGNALS)(
    "keeps the draft, and the fleet, when an IME's Escape dismisses its candidates ($signal)",
    ({ init }) => {
      const above = vi.fn();
      render(
        <div onKeyDown={above}>
          <FleetHostComposer />
        </div>
      );
      typeDraft("ni hao");

      const notPrevented = fireEvent.keyDown(field(), { key: "Escape", ...init });

      expect(notPrevented).toBe(true);
      expect(field().value).toBe("ni hao");
      expect(document.activeElement).toBe(field());
      // The ribbon around the field exits the fleet on a bare Escape.
      expect(above).not.toHaveBeenCalled();
    }
  );

  it("keeps an IME's Escape from the ribbon even when nothing is typed yet", () => {
    const above = vi.fn();
    render(
      <div onKeyDown={above}>
        <FleetHostComposer />
      </div>
    );
    field().focus();

    fireEvent.keyDown(field(), { key: "Escape", isComposing: true });

    expect(above).not.toHaveBeenCalled();
  });

  it("still sends on a plain Enter", async () => {
    render(<FleetHostComposer />);
    typeDraft("ls");

    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(submitFleet).toHaveBeenCalledWith(expect.objectContaining({ text: "ls" }));
  });

  it("still clears a typed draft on a plain Escape, before the ribbon sees it", () => {
    const above = vi.fn();
    render(
      <div onKeyDown={above}>
        <FleetHostComposer />
      </div>
    );
    typeDraft("ls");

    const notPrevented = fireEvent.keyDown(field(), { key: "Escape" });

    expect(notPrevented).toBe(false);
    expect(field().value).toBe("");
    expect(above).not.toHaveBeenCalled();
  });
});
