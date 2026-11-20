// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  DecisionsInvolvementPreference,
  DecisionsInvolvementRead,
  DecisionsInvolvementSaveResult,
  SetDecisionsInvolvementPayload,
} from "@shared/types/decisionsInvolvement";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsInvolvementSection } from "../DecisionsInvolvementSection";
import { INVOLVEMENT_READ_MS } from "../useInvolvementPreference";
import { localDateTime } from "../decisionsInvolvementModel";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function show(props: { active?: boolean; opening?: number; statusRevision?: number | null } = {}) {
  const element = (p: typeof props) => (
    <TooltipProvider>
      <DecisionsInvolvementSection
        active={p.active ?? true}
        opening={p.opening ?? 1}
        statusRevision={p.statusRevision ?? 1}
      />
    </TooltipProvider>
  );
  const view = render(element(props), {
    wrapper: ({ children }) => (
      <div role="dialog" tabIndex={-1}>
        {children}
      </div>
    ),
  });
  return { rerender: (next: typeof props) => view.rerender(element(next)) };
}

/** Lets the reads and saves in flight settle. */
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

describe("DecisionsInvolvementSection", () => {
  it("rests on one line naming the mode, and shows how many agents it consults, where it was set and when this computer confirmed it only while it's changed", async () => {
    show();
    await settle();

    expect(text("decisions-involvement-mode")).toBe("Bring a recommendation");
    expect(screen.queryByTestId("decisions-involvement-detail")).toBeNull();
    expect(screen.queryByTestId("decisions-involvement-facts")).toBeNull();

    fireEvent.click(byId("decisions-involvement-change"));
    expect(text("decisions-involvement-detail")).toContain("consult 2 other agents first");
    const facts = byId("decisions-involvement-facts");
    expect(facts.textContent).toContain("Set on a phone or tablet");
    expect(facts.textContent).toContain("Confirmed by this computer");
    // Each fact carries its own time: when it was set, then when this computer confirmed it.
    expect(
      Array.from(facts.querySelectorAll("time")).map((time) => time.getAttribute("datetime"))
    ).toEqual(["2026-11-18T09:00:00.000Z", "2026-11-18T09:59:00.000Z"]);
    expect(screen.queryByTestId("decisions-involvement-stale")).toBeNull();
  });

  it("shows asking while exploring, set on this computer, and says agents keep their usual behaviour while it may be out of date", async () => {
    getInvolvement.mockResolvedValue(
      reads(
        available({
          normalMode: "involve-early",
          mode: "involve-early",
          setOn: "computer",
          stale: true,
        })
      )
    );
    show();
    await settle();

    // Something keeps it from applying, so why, and where it came from, show unasked.
    expect(text("decisions-involvement-mode")).toBe("Ask while exploring");
    expect(text("decisions-involvement-stale")).toContain("agents use their usual behaviour");
    expect(text("decisions-involvement-facts")).toContain("Set on this computer");
    expect(screen.queryByTestId("decisions-involvement-detail")).toBeNull();

    fireEvent.click(byId("decisions-involvement-change"));
    expect(text("decisions-involvement-detail")).toContain("while they explore");
  });

  it("shows a temporary mode with its end, what follows it only while it's changed, and flips at its end without waiting on a read", async () => {
    // Ends before the next regular read, so only its own end can flip it.
    const until = new Date(NOW + 2_000).toISOString();
    getInvolvement.mockResolvedValueOnce(
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
    expect(mode.textContent).not.toContain("then");
    expect(mode.querySelector("time")?.getAttribute("datetime")).toBe(until);
    expect(mode.querySelector("time")?.textContent).toMatch(/\d/);
    fireEvent.click(byId("decisions-involvement-change"));
    expect(text("decisions-involvement-mode")).toContain(
      "then bring a recommendation, consulting 4 other agents"
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(getInvolvement).toHaveBeenCalledTimes(1);

    // The read the end starts never lands: the display flips on the time alone.
    getInvolvement.mockReturnValue(new Promise(() => {}));
    await settle(2_000);
    expect(text("decisions-involvement-mode")).toBe("Bring a recommendation");
    expect(getInvolvement).toHaveBeenCalledTimes(2);
    fireEvent.click(byId("decisions-involvement-change"));
    expect(text("decisions-involvement-detail")).toContain("consult 4 other agents first");
  });

  it("reads again while open, picking up a phone's change with no status push, and stops once closed", async () => {
    const view = show();
    await settle();
    expect(getInvolvement).toHaveBeenCalledTimes(1);

    getInvolvement.mockResolvedValue(
      reads(available({ normalMode: "involve-early", mode: "involve-early", revision: 4 }))
    );
    await settle(INVOLVEMENT_READ_MS);
    expect(text("decisions-involvement-mode")).toBe("Ask while exploring");
    expect(getInvolvement).toHaveBeenCalledTimes(2);

    view.rerender({ active: false });
    await settle(INVOLVEMENT_READ_MS * 3);
    expect(getInvolvement).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("decisions-involvement-mode")).toBeNull();
  });

  it("reads again when Decisions' status moves", async () => {
    const view = show({ statusRevision: 1 });
    await settle();
    view.rerender({ statusRevision: 2 });
    await settle();
    expect(getInvolvement).toHaveBeenCalledTimes(2);
  });

  it("saves a change with the revision the person reviewed, shows what was saved, and hands the keyboard back to Change", async () => {
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.click(byId("decisions-involvement-normal-mode-involve-early"));
    fireEvent.change(byId("decisions-involvement-consult-count"), { target: { value: "4" } });
    getInvolvement.mockResolvedValue(
      reads(
        available({
          normalMode: "involve-early",
          mode: "involve-early",
          consultCount: 4,
          revision: 4,
          setOn: "computer",
        })
      )
    );
    act(() => byId("decisions-involvement-save").focus());
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();

    expect(setInvolvement).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 3,
      normalMode: "involve-early",
      consultCount: 4,
      override: null,
    });
    expect(screen.queryByTestId("decisions-involvement-editor")).toBeNull();
    expect(screen.queryByTestId("decisions-involvement-notice")).toBeNull();
    expect(text("decisions-involvement-mode")).toBe("Ask while exploring");
    expect(screen.queryByTestId("decisions-involvement-facts")).toBeNull();
    expect(document.activeElement).toBe(byId("decisions-involvement-change"));
  });

  it("keeps the revision the person started from, though a newer one is read while they edit", async () => {
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    getInvolvement.mockResolvedValue(reads(available({ consultCount: 3, revision: 5 })));
    await settle(INVOLVEMENT_READ_MS);
    expect(text("decisions-involvement-detail")).toContain("3 other agents");
    setInvolvement.mockResolvedValue({ result: "conflict", latestRevision: 5 });
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();

    expect(setInvolvement).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expectedRevision: 3, consultCount: 2 })
    );
  });

  it("changes a temporary mode to the other mode and a new end", async () => {
    const until = new Date(NOW + 2 * HOUR).toISOString();
    getInvolvement.mockResolvedValue(
      reads(
        available({
          override: { mode: "involve-early", until },
          mode: "involve-early",
          overrideActive: true,
        })
      )
    );
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.click(byId("decisions-involvement-temporary-mode-recommend"));
    const end = localDateTime(NOW + 3 * HOUR);
    fireEvent.change(byId("decisions-involvement-until"), { target: { value: end } });
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();

    expect(setInvolvement).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 3,
      normalMode: "recommend",
      consultCount: 2,
      override: { mode: "recommend", until: new Date(NOW + 3 * HOUR).toISOString() },
    });
  });

  it("keeps an untouched temporary mode's exact end when only the count changes", async () => {
    const until = "2026-11-18T12:34:56.789Z";
    getInvolvement.mockResolvedValue(
      reads(
        available({
          override: { mode: "involve-early", until },
          mode: "involve-early",
          overrideActive: true,
        })
      )
    );
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.change(byId("decisions-involvement-consult-count"), { target: { value: "5" } });
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();

    expect(setInvolvement).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ consultCount: 5, override: { mode: "involve-early", until } })
    );
  });

  it("says a typed end has passed the moment it passes, and sends nothing", async () => {
    show();
    await settle();
    // No read lands after this one, so only the draft's own end can show it.
    getInvolvement.mockReturnValue(new Promise(() => {}));

    // Typed a few seconds after the last read: the wake counts from the end, not from that read.
    await settle(3_000);
    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.click(byId("decisions-involvement-temporary"));
    fireEvent.change(byId("decisions-involvement-until"), {
      target: { value: localDateTime(NOW + 60_000) },
    });
    expect(screen.queryByTestId("decisions-involvement-issue")).toBeNull();

    await settle(56_000);
    expect(screen.queryByTestId("decisions-involvement-issue")).toBeNull();
    await settle(1_000);
    expect(text("decisions-involvement-issue")).toContain("future");
    expect(byId("decisions-involvement-until").getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();
    expect(setInvolvement).not.toHaveBeenCalled();
  });

  it("sends one change for two presses while it is in flight", async () => {
    show();
    await settle();
    const pending = deferred<DecisionsInvolvementSaveResult>();
    setInvolvement.mockReturnValue(pending.promise);

    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.submit(byId("decisions-involvement-editor"));
    fireEvent.submit(byId("decisions-involvement-editor"));
    await settle();
    expect(setInvolvement).toHaveBeenCalledTimes(1);

    pending.resolve({ result: "saved", revision: 4 });
    await settle();
    expect(setInvolvement).toHaveBeenCalledTimes(1);
  });

  it("locks the form while a change is in flight, keeping the keyboard on Save, and offers no second change until it settles", async () => {
    show();
    await settle();
    const pending = deferred<DecisionsInvolvementSaveResult>();
    setInvolvement.mockReturnValueOnce(pending.promise);

    fireEvent.click(byId("decisions-involvement-change"));
    act(() => byId("decisions-involvement-consult-count").focus());
    fireEvent.submit(byId("decisions-involvement-editor"));
    await settle();
    // What was sent is what the form shows until it settles, and the keyboard waits on Save.
    expect(byId("decisions-involvement-consult-count").closest("fieldset")?.disabled).toBe(true);
    expect(document.activeElement).toBe(byId("decisions-involvement-save"));
    fireEvent.submit(byId("decisions-involvement-editor"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // A change from the revision the pending one replaces would only be refused: none is offered.
    expect(screen.queryByTestId("decisions-involvement-change")).toBeNull();
    await settle();
    // Nothing here can take it while the change is in flight, so the dialog's surface holds it.
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    expect(setInvolvement).toHaveBeenCalledTimes(1);

    pending.resolve({ result: "conflict", latestRevision: null });
    await settle();
    expect(text("decisions-involvement-notice")).toContain("wasn't saved");
    expect(document.activeElement).toBe(byId("decisions-involvement-change"));
    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.change(byId("decisions-involvement-consult-count"), { target: { value: "6" } });
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();
    expect(setInvolvement).toHaveBeenLastCalledWith(expect.objectContaining({ consultCount: 6 }));
    expect(setInvolvement).toHaveBeenCalledTimes(2);
  });

  it("puts the keyboard back on Change when the form is put away", async () => {
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    act(() => screen.getByRole("button", { name: "Cancel" }).focus());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();

    expect(screen.queryByTestId("decisions-involvement-editor")).toBeNull();
    expect(document.activeElement).toBe(byId("decisions-involvement-change"));
  });

  it("ends the wait after a conflict on time even when reads stall", async () => {
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    setInvolvement.mockResolvedValue({ result: "conflict", latestRevision: 9 });
    getInvolvement.mockReturnValue(new Promise(() => {}));
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();
    expect(screen.queryByTestId("decisions-involvement-change")).toBeNull();

    await settle(14_000);
    expect(screen.queryByTestId("decisions-involvement-change")).toBeNull();
    await settle(1_000);
    expect(byId("decisions-involvement-change")).not.toBeNull();
  });

  it("lets a change start again from what this computer holds when it can't read the revision that won", async () => {
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    setInvolvement.mockResolvedValue({ result: "conflict", latestRevision: 9 });
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();
    expect(screen.queryByTestId("decisions-involvement-change")).toBeNull();

    // Every read still holds revision 3: the wait ends rather than stranding the person.
    await settle(INVOLVEMENT_READ_MS * 4);
    expect(byId("decisions-involvement-change")).not.toBeNull();
  });

  it("refuses a save on top of a newer change, says so, and lets a change start only from the latest", async () => {
    show();
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.click(byId("decisions-involvement-normal-mode-involve-early"));
    setInvolvement.mockResolvedValue({ result: "conflict", latestRevision: 5 });
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();

    expect(text("decisions-involvement-notice")).toContain("wasn't saved");
    expect(byId("decisions-involvement-notice").parentElement?.getAttribute("role")).toBe("status");
    expect(screen.queryByTestId("decisions-involvement-editor")).toBeNull();
    // This computer still holds revision 3: nothing can be changed until it reads the one that won.
    expect(screen.queryByTestId("decisions-involvement-change")).toBeNull();
    expect(text("decisions-involvement-read-only")).toContain("newer preference");

    // What the phone saved, once read.
    getInvolvement.mockResolvedValue(
      reads(available({ consultCount: 3, revision: 5, setOn: "phone" }))
    );
    await settle(INVOLVEMENT_READ_MS);
    expect(screen.queryByTestId("decisions-involvement-read-only")).toBeNull();
    fireEvent.click(byId("decisions-involvement-change"));
    expect(screen.queryByTestId("decisions-involvement-notice")).toBeNull();
    expect(text("decisions-involvement-detail")).toContain("3 other agents");
    setInvolvement.mockResolvedValue({ result: "saved", revision: 6 });
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();
    expect(setInvolvement).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedRevision: 5, consultCount: 3 })
    );
  });

  it("never says a change whose fate is unknown was lost", async () => {
    show();
    await settle();
    setInvolvement.mockRejectedValue(new Error("the window went away"));

    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();

    const notice = text("decisions-involvement-notice");
    expect(notice).toContain("couldn't confirm whether your change was saved");
    expect(notice).not.toContain("wasn't");
  });

  it("is read only, and says so, when the relay doesn't support involvement preferences", async () => {
    getInvolvement.mockResolvedValue(
      reads(
        {
          status: "unavailable",
          reason: "unsupported",
          revision: 0,
          lastSyncedAt: "2026-11-18T09:59:00.000Z",
          stale: false,
        },
        { settable: false }
      )
    );
    show();
    await settle();

    expect(text("decisions-involvement-summary")).toContain(
      "This relay doesn't support involvement preferences"
    );
    expect(text("decisions-involvement-read-only")).toContain("Update the relay");
    expect(screen.queryByTestId("decisions-involvement-change")).toBeNull();
  });

  it.each<[string, DecisionsInvolvementSaveResult]>([
    ["refuses it as forbidden", { result: "refused", reason: "relay", code: "forbidden" }],
    ["doesn't take preferences", { result: "unsupported" }],
  ])("turns read only once the relay %s, until the next opening", async (_label, refusal) => {
    const view = show({ opening: 1 });
    await settle();

    fireEvent.click(byId("decisions-involvement-change"));
    setInvolvement.mockResolvedValue(refusal);
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();

    expect(text("decisions-involvement-read-only")).toContain("0.8.0");
    expect(text("decisions-involvement-notice")).toContain("wasn't saved");
    expect(screen.queryByTestId("decisions-involvement-change")).toBeNull();
    // Nothing to press is left, so the keyboard waits on the dialog, inside its focus trap.
    expect(document.activeElement).toBe(screen.getByRole("dialog"));

    view.rerender({ opening: 2 });
    await settle();
    expect(screen.queryByTestId("decisions-involvement-read-only")).toBeNull();
    expect(screen.queryByTestId("decisions-involvement-notice")).toBeNull();
    expect(byId("decisions-involvement-change")).not.toBeNull();
  });

  it("only shows the preference on a Remote Host, naming the owner computer as where it was set", async () => {
    getInvolvement.mockResolvedValue(
      reads(available({ setOn: "computer" }), { role: "host", settable: false })
    );
    show();
    await settle();

    expect(text("decisions-involvement-mode")).toBe("Bring a recommendation");
    expect(text("decisions-involvement-facts")).toContain("Set on the owner computer");
    expect(text("decisions-involvement-facts")).not.toContain("Set on this computer");
    expect(text("decisions-involvement-read-only")).toContain("Remote Host");
    expect(screen.queryByTestId("decisions-involvement-change")).toBeNull();
  });

  it("offers to set a first preference when none is set", async () => {
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

    expect(text("decisions-involvement-summary")).toBe("Not set");
    expect(screen.queryByTestId("decisions-involvement-facts")).toBeNull();
    expect(text("decisions-involvement-change")).toBe("Set preference");
    fireEvent.click(byId("decisions-involvement-change"));
    expect(text("decisions-involvement-summary")).toContain("No involvement preference is set");
    expect(text("decisions-involvement-facts")).toContain("Confirmed by this computer");
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();
    expect(setInvolvement).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expectedRevision: 0, consultCount: 1, override: null })
    );
  });

  it("says this computer has never confirmed one before its first read", async () => {
    getInvolvement.mockResolvedValue(
      reads({
        status: "unavailable",
        reason: "not-synced",
        revision: 0,
        lastSyncedAt: null,
        stale: true,
      })
    );
    show();
    await settle();

    expect(text("decisions-involvement-summary")).toContain("hasn't read a preference");
    expect(text("decisions-involvement-facts")).toBe("Never confirmed by this computer");
  });

  it("says agents use their usual behaviour while this computer isn't connected", async () => {
    getInvolvement.mockResolvedValue({ result: "not-running" });
    show();
    await settle();

    expect(text("decisions-involvement-summary")).toContain("isn't connected to the relay");
    expect(text("decisions-involvement-summary")).toContain("usual behaviour");
    expect(screen.queryByTestId("decisions-involvement-change")).toBeNull();
  });

  it("names a preference set by a removed device in a few words, and offers to set another", async () => {
    getInvolvement.mockResolvedValue(
      reads({
        status: "unavailable",
        reason: "signer-revoked",
        revision: 4,
        lastSyncedAt: "2026-11-18T09:59:00.000Z",
        stale: false,
      })
    );
    show();
    await settle();

    expect(text("decisions-involvement-summary")).toBe("Set by a device that was removed");
    expect(screen.queryByTestId("decisions-involvement-facts")).toBeNull();
    expect(text("decisions-involvement-change")).toBe("Set preference");
  });

  it("says why it can't be changed until this computer reconnects, with where it came from", async () => {
    getInvolvement.mockResolvedValue(reads(available(), { settable: false }));
    show();
    await settle();

    expect(text("decisions-involvement-mode")).toBe("Bring a recommendation");
    expect(text("decisions-involvement-read-only")).toContain("reconnects");
    expect(text("decisions-involvement-facts")).toContain("Set on a phone or tablet");
    expect(screen.queryByTestId("decisions-involvement-change")).toBeNull();
  });

  it("offers Retry when the first read fails, and shows the preference once one lands", async () => {
    getInvolvement.mockRejectedValueOnce(new Error("no bridge"));
    show();
    await settle();

    expect(byId("decisions-involvement-failed")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(text("decisions-involvement-mode")).toBe("Bring a recommendation");
    expect(screen.queryByTestId("decisions-involvement-failed")).toBeNull();
  });

  it("moves the keyboard from Change to the form's first field as it opens", async () => {
    show();
    await settle();

    act(() => byId("decisions-involvement-change").focus());
    fireEvent.click(byId("decisions-involvement-change"));
    await settle();
    // The selected mode is the group's one stop.
    expect(document.activeElement).toBe(byId("decisions-involvement-normal-mode-recommend"));
  });

  it("leaves the keyboard where the person moved it when a change settles", async () => {
    show();
    await settle();
    const pending = deferred<DecisionsInvolvementSaveResult>();
    setInvolvement.mockReturnValueOnce(pending.promise);

    fireEvent.click(byId("decisions-involvement-change"));
    fireEvent.click(byId("decisions-involvement-save"));
    await settle();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    act(() => elsewhere.focus());
    pending.resolve({ result: "saved", revision: 4 });
    await settle();

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("reads nothing while inactive", async () => {
    show({ active: false });
    await settle(INVOLVEMENT_READ_MS * 2);
    expect(getInvolvement).not.toHaveBeenCalled();
  });
});
