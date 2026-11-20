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
import {
  SettingsDeepLinkProvider,
  createSettingsDeepLinkHolds,
} from "@/components/Settings/settingsDeepLink";
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

function show(props: { active?: boolean; locked?: boolean } = {}) {
  const element = (p: typeof props) => (
    <TooltipProvider>
      <DecisionsInvolvementSettingsSection
        active={p.active ?? true}
        statusRevision={1}
        locked={p.locked ?? false}
      />
    </TooltipProvider>
  );
  const view = render(element(props));
  return { rerender: (next: typeof props) => view.rerender(element(next)) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
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
  const button = byId("decisions-involvement-save");
  if (!(button instanceof HTMLButtonElement)) throw new Error("Save isn't a button");
  return button;
}

function field(testId: string): HTMLInputElement {
  const input = byId(testId);
  if (!(input instanceof HTMLInputElement)) throw new Error(`${testId} isn't an input`);
  return input;
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
    fireEvent.click(screen.getByRole("checkbox", { name: /For a while/ }));
    expect(save().disabled).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /For a while/ }));
    expect(save().disabled).toBe(true);
  });

  it("sets a temporary mode and its end", async () => {
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    expect(field("decisions-involvement-until").disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /For a while/ }));
    expect(field("decisions-involvement-until").disabled).toBe(false);
    // Not the mode it starts out as, so the pick is what's sent.
    fireEvent.click(option("Mode for a while", "Bring a recommendation"));
    const end = localDateTime(NOW + 3 * HOUR);
    fireEvent.change(byId("decisions-involvement-until"), { target: { value: end } });
    fireEvent.click(save());
    await settle();

    expect(setInvolvement).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 3,
      normalMode: "recommend",
      consultCount: 2,
      override: { mode: "recommend", until: new Date(NOW + 3 * HOUR).toISOString() },
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
    expect(setInvolvement).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 0,
      normalMode: "recommend",
      consultCount: 1,
      override: null,
    });
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
    expect(screen.queryByText("The preference couldn't be read")).toBeNull();
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
    expect(field("decisions-involvement-consult-count").value).toBe("5");
  });
  it("shows a temporary mode that ended while the tab was hidden as over, though the read on return stalls", async () => {
    const until = new Date(NOW + HOUR).toISOString();
    getInvolvement.mockResolvedValue(
      reads(
        available({
          override: { mode: "involve-early", until },
          mode: "involve-early",
          overrideActive: true,
        })
      )
    );
    const view = show();
    await settle();
    expect(text("decisions-involvement-mode")).toContain("Ask while exploring until");

    view.rerender({ active: false });
    await settle(2 * HOUR);
    getInvolvement.mockReturnValue(new Promise(() => {}));
    view.rerender({ active: true });
    await settle();
    expect(text("decisions-involvement-mode")).toBe("Bring a recommendation");
  });

  it("moves the keyboard from Change to the form's first field as it opens", async () => {
    show();
    await settle();

    act(() => byId("decisions-involvement-change").focus());
    fireEvent.click(byId("decisions-involvement-change"));
    await settle();
    expect(document.activeElement).toBe(option("Usually", "Bring a recommendation"));
  });

  it("leaves the keyboard on the page the person moved to when a change settles", async () => {
    const pending = deferred<DecisionsInvolvementSaveResult>();
    setInvolvement.mockReturnValueOnce(pending.promise);
    render(
      <TooltipProvider>
        {/* As Settings focuses a tab's panel, which holds the section. */}
        <div tabIndex={-1} data-testid="panel">
          <DecisionsInvolvementSettingsSection active statusRevision={1} locked={false} />
        </div>
      </TooltipProvider>
    );
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.click(option("Usually", "Ask while exploring"));
    fireEvent.click(save());
    await settle();
    act(() => byId("panel").focus());
    pending.resolve({ result: "saved", revision: 4 });
    await settle();

    expect(document.activeElement).toBe(byId("panel"));
  });

  it("starts and sends nothing while the Decisions switch is changing", async () => {
    const view = show({ locked: true });
    await settle();
    expect(screen.queryByTestId("decisions-involvement-change")).toBeNull();

    view.rerender({ locked: false });
    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.click(option("Usually", "Ask while exploring"));
    view.rerender({ locked: true });
    expect(save().disabled).toBe(true);
    fireEvent.submit(byId("decisions-involvement-editor"));
    await settle();
    expect(setInvolvement).not.toHaveBeenCalled();
  });

  it("holds a search result for this section until the preference is read, so Change is there to take the keyboard", async () => {
    let answer!: (read: DecisionsInvolvementRead) => void;
    getInvolvement.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const holds = createSettingsDeepLinkHolds();
    render(
      <SettingsDeepLinkProvider
        value={{ sectionId: "decisions-involvement", query: null, request: {}, holds }}
      >
        <TooltipProvider>
          <DecisionsInvolvementSettingsSection active statusRevision={1} locked={false} />
        </TooltipProvider>
      </SettingsDeepLinkProvider>
    );
    await settle();
    expect(holds.isHeld()).toBe(true);

    await act(async () => answer(reads(available())));
    expect(holds.isHeld()).toBe(false);
    expect(byId("decisions-involvement-change")).not.toBeNull();
  });
});
