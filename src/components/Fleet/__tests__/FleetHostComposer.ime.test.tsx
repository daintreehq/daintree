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

function resetArming() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
    previewArmedIds: new Set<string>(),
    crossHostTargets: [],
  });
}

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

/**
 * Renders the field under a spy standing in for the ribbon around it. The
 * field keeps its text past a remount, so each case starts by emptying it.
 */
function renderComposer() {
  const above = vi.fn();
  render(
    <div onKeyDown={above}>
      <FleetHostComposer />
    </div>
  );
  typeDraft("");
  expect(field().value).toBe("");
  return above;
}

const IME_SIGNALS = [
  { signal: "isComposing", init: { isComposing: true } },
  { signal: "keyCode 229", init: { keyCode: 229 } },
];

describe("FleetHostComposer — an IME's Enter and Escape (#17450)", () => {
  let electronBefore: PropertyDescriptor | undefined;

  beforeEach(() => {
    resetArming();
    submitFleet.mockReset().mockResolvedValue(undefined);
    electronBefore = Object.getOwnPropertyDescriptor(window, "electron");
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { hostMetrics: { submitFleet } },
    });
    armRemote("t1");
  });

  afterEach(() => {
    if (electronBefore) Object.defineProperty(window, "electron", electronBefore);
    else Reflect.deleteProperty(window, "electron");
    resetArming();
  });

  it.each(IME_SIGNALS)(
    "keeps the draft and sends nothing when an IME's Enter confirms a candidate ($signal)",
    async ({ init }) => {
      renderComposer();
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
      const above = renderComposer();
      typeDraft("ni hao");

      const notPrevented = fireEvent.keyDown(field(), { key: "Escape", ...init });

      expect(notPrevented).toBe(true);
      expect(field().value).toBe("ni hao");
      expect(document.activeElement).toBe(field());
      // The ribbon around the field exits the fleet on a bare Escape.
      expect(above).not.toHaveBeenCalled();
    }
  );

  it.each(IME_SIGNALS)(
    "keeps an IME's Escape from the ribbon even when nothing is typed yet ($signal)",
    ({ init }) => {
      const above = renderComposer();
      field().focus();

      const notPrevented = fireEvent.keyDown(field(), { key: "Escape", ...init });

      expect(notPrevented).toBe(true);
      expect(field().value).toBe("");
      expect(document.activeElement).toBe(field());
      expect(above).not.toHaveBeenCalled();
    }
  );

  it("still sends on a plain Enter", async () => {
    renderComposer();
    typeDraft("ls");

    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter", keyCode: 13 });
    });

    expect(submitFleet).toHaveBeenCalledWith(expect.objectContaining({ text: "ls" }));
  });

  it("still clears a typed draft on a plain Escape, before the ribbon sees it", () => {
    const above = renderComposer();
    typeDraft("ls");

    const notPrevented = fireEvent.keyDown(field(), { key: "Escape", keyCode: 27 });

    expect(notPrevented).toBe(false);
    expect(field().value).toBe("");
    expect(above).not.toHaveBeenCalled();
  });

  it("lets a plain Escape on an empty field reach the ribbon, which exits the fleet", () => {
    const above = renderComposer();
    field().focus();

    fireEvent.keyDown(field(), { key: "Escape", keyCode: 27 });

    expect(above).toHaveBeenCalledTimes(1);
  });
});
