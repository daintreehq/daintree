// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  DecisionsInvolvementPreference,
  DecisionsInvolvementRead,
  DecisionsInvolvementSaveResult,
  SetDecisionsInvolvementPayload,
} from "@shared/types/decisionsInvolvement";
import { TooltipProvider } from "@/components/ui/tooltip";
import { localDateTime } from "@/components/Decisions/decisionsInvolvementModel";
import { INVOLVEMENT_READ_MS } from "@/components/Decisions/useInvolvementPreference";
import { DecisionsInvolvementSettingsSection } from "../DecisionsInvolvementSettingsSection";

const NOW = Date.parse("2026-11-18T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const getInvolvement = vi.fn<() => Promise<DecisionsInvolvementRead>>();
const setInvolvement =
  vi.fn<(payload: SetDecisionsInvolvementPayload) => Promise<DecisionsInvolvementSaveResult>>();

function available(
  over: Partial<Extract<DecisionsInvolvementPreference, { status: "available" }>> = {}
): DecisionsInvolvementPreference {
  return {
    status: "available",
    normalMode: "recommend",
    consultCount: 2,
    override: null,
    mode: "recommend",
    overrideActive: false,
    revision: 3,
    setOn: "phone",
    setAt: "2026-11-18T09:00:00.000Z",
    lastSyncedAt: "2026-11-18T09:59:00.000Z",
    stale: false,
    ...over,
  };
}

function reads(
  preference: DecisionsInvolvementPreference,
  over: Partial<Extract<DecisionsInvolvementRead, { result: "read" }>> = {}
): DecisionsInvolvementRead {
  return { result: "read", preference, role: "owner", settable: true, ...over };
}

function show(props: { active?: boolean } = {}) {
  const element = (p: typeof props) => (
    <TooltipProvider>
      <DecisionsInvolvementSettingsSection active={p.active ?? true} statusRevision={1} />
    </TooltipProvider>
  );
  const view = render(element(props));
  return { rerender: (next: typeof props) => view.rerender(element(next)) };
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function text(testId: string): string {
  return screen.getByTestId(testId).textContent ?? "";
}

function byId(testId: string): HTMLElement {
  return screen.getByTestId(testId);
}

function option(group: string, name: string): HTMLElement {
  return within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });
}

function save(): HTMLButtonElement {
  return byId("decisions-involvement-save") as HTMLButtonElement;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(NOW);
  getInvolvement.mockReset().mockResolvedValue(reads(available()));
  setInvolvement.mockReset().mockResolvedValue({ result: "saved", revision: 4 });
  Reflect.set(window, "electron", { decisions: { getInvolvement, setInvolvement } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "electron");
});

describe("DecisionsInvolvementSettingsSection", () => {
  it("says what agents are told, what that asks of them, where it was set and when this computer confirmed it", async () => {
    show();
    await settle();

    expect(text("decisions-involvement-mode")).toBe("Bring a recommendation");
    expect(text("decisions-involvement-detail")).toContain("consult 2 other agents first");
    expect(text("decisions-involvement-facts")).toContain("Set on a phone or tablet");
    expect(text("decisions-involvement-facts")).toContain("Confirmed by this computer");
    expect(text("decisions-involvement-change")).toBe("Change");
    expect(screen.queryByTestId("decisions-involvement-editor")).toBeNull();
  });

  it("names a temporary mode's end and what follows it", async () => {
    const until = new Date(NOW + 2 * HOUR).toISOString();
    getInvolvement.mockResolvedValue(
      reads(
        available({
          consultCount: 4,
          override: { mode: "involve-early", until },
          mode: "involve-early",
          overrideActive: true,
        })
      )
    );
    show();
    await settle();

    const mode = byId("decisions-involvement-mode");
    expect(mode.textContent).toContain("Ask while exploring until");
    expect(mode.textContent).toContain("then bring a recommendation, consulting 4 other agents");
    expect(mode.querySelector("time")?.getAttribute("datetime")).toBe(until);
  });

  it("saves nothing until something changes, then saves the change over the revision reviewed and hands the keyboard back to Change", async () => {
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    expect(save().disabled).toBe(true);
    // Enter in a field submits the form whatever the button says.
    fireEvent.submit(byId("decisions-involvement-editor"));
    await settle();
    expect(setInvolvement).not.toHaveBeenCalled();

    fireEvent.click(option("Usually", "Ask while exploring"));
    fireEvent.change(byId("decisions-involvement-consult-count"), { target: { value: "4" } });
    expect(save().disabled).toBe(false);
    act(() => save().focus());
    fireEvent.click(save());
    await settle();

    expect(setInvolvement).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 3,
      normalMode: "involve-early",
      consultCount: 4,
      override: null,
    });
    expect(screen.queryByTestId("decisions-involvement-editor")).toBeNull();
    expect(document.activeElement).toBe(byId("decisions-involvement-change"));
  });

  it("counts a change put back as no change", async () => {
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.click(option("Usually", "Ask while exploring"));
    expect(save().disabled).toBe(false);
    fireEvent.click(option("Usually", "Bring a recommendation"));
    expect(save().disabled).toBe(true);
  });

  it("sets a temporary mode and its end", async () => {
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    expect((byId("decisions-involvement-until") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /For a while/ }));
    expect((byId("decisions-involvement-until") as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(option("Mode for a while", "Ask while exploring"));
    const end = localDateTime(NOW + 3 * HOUR);
    fireEvent.change(byId("decisions-involvement-until"), { target: { value: end } });
    fireEvent.click(save());
    await settle();

    expect(setInvolvement).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 3,
      normalMode: "recommend",
      consultCount: 2,
      override: { mode: "involve-early", until: new Date(NOW + 3 * HOUR).toISOString() },
    });
  });

  it("says what's wrong with a count it can't save, and sends nothing", async () => {
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.change(byId("decisions-involvement-consult-count"), { target: { value: "12" } });
    expect(screen.getByText("Enter a whole number from 1 to 8.")).toBeTruthy();
    fireEvent.click(save());
    await settle();
    expect(setInvolvement).not.toHaveBeenCalled();
  });

  it("keeps the revision the person started from, though a newer one is read while they edit", async () => {
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    getInvolvement.mockResolvedValue(reads(available({ consultCount: 3, revision: 5 })));
    await settle(INVOLVEMENT_READ_MS);
    expect(text("decisions-involvement-detail")).toContain("3 other agents");
    setInvolvement.mockResolvedValue({ result: "conflict", latestRevision: 5 });
    fireEvent.change(byId("decisions-involvement-consult-count"), { target: { value: "6" } });
    fireEvent.click(save());
    await settle();

    expect(setInvolvement).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expectedRevision: 3, consultCount: 6 })
    );
    expect(text("decisions-involvement-notice")).toContain("wasn't saved");
    expect(byId("decisions-involvement-notice").parentElement?.getAttribute("role")).toBe("status");
  });

  it("puts the form away without sending anything on Cancel, with the keyboard back on Change", async () => {
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.click(option("Usually", "Ask while exploring"));
    act(() => screen.getByRole("button", { name: "Cancel" }).focus());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();

    expect(screen.queryByTestId("decisions-involvement-editor")).toBeNull();
    expect(setInvolvement).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(byId("decisions-involvement-change"));
  });

  it("saves a first preference as suggested when none is set", async () => {
    getInvolvement.mockResolvedValue(
      reads({
        status: "unavailable",
        reason: "not-set",
        revision: 0,
        lastSyncedAt: "2026-11-18T09:59:00.000Z",
        stale: false,
      })
    );
    show();
    await settle();

    expect(text("decisions-involvement-summary")).toContain("No involvement preference is set");
    fireEvent.click(byId("decisions-involvement-change"));
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await settle();
    expect(setInvolvement).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expectedRevision: 0, consultCount: 1, override: null })
    );
  });

  it("only shows the preference on a Remote Host, saying where to change it", async () => {
    getInvolvement.mockResolvedValue(
      reads(available({ setOn: "computer" }), { role: "host", settable: false })
    );
    show();
    await settle();

    expect(text("decisions-involvement-mode")).toBe("Bring a recommendation");
    expect(text("decisions-involvement-read-only")).toContain("Remote Host");
    expect(text("decisions-involvement-facts")).toContain("Set on the owner computer");
    expect(screen.queryByTestId("decisions-involvement-change")).toBeNull();
  });

  it("says agents use their usual behaviour while this computer isn't connected", async () => {
    getInvolvement.mockResolvedValue({ result: "not-running" });
    show();
    await settle();

    expect(text("decisions-involvement-summary")).toContain("isn't connected to the relay");
    expect(screen.queryByTestId("decisions-involvement-change")).toBeNull();
  });

  it("offers Retry on the row when the preference can't be read", async () => {
    getInvolvement.mockRejectedValueOnce(new Error("no bridge"));
    show();
    await settle();

    expect(screen.getByText("The preference couldn't be read")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(text("decisions-involvement-mode")).toBe("Bring a recommendation");
  });

  it("reads only while the tab shows, keeping an unsaved change across a visit elsewhere", async () => {
    const view = show({ active: false });
    await settle(INVOLVEMENT_READ_MS * 2);
    expect(getInvolvement).not.toHaveBeenCalled();

    view.rerender({ active: true });
    await settle();
    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.change(byId("decisions-involvement-consult-count"), { target: { value: "5" } });

    view.rerender({ active: false });
    await settle(INVOLVEMENT_READ_MS * 3);
    expect(getInvolvement).toHaveBeenCalledTimes(1);

    view.rerender({ active: true });
    await settle();
    expect(getInvolvement).toHaveBeenCalledTimes(2);
    expect((byId("decisions-involvement-consult-count") as HTMLInputElement).value).toBe("5");
  });
});
