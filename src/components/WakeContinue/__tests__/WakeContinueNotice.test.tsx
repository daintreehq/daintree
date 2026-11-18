// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendWakeContinueNotes = vi.hoisted(() => vi.fn(async () => {}));
const dismissWakeContinue = vi.hoisted(() => vi.fn());
vi.mock("@/services/wakeContinue/wakeContinue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/wakeContinue/wakeContinue")>()),
  sendWakeContinueNotes,
  dismissWakeContinue,
}));

import type { PanelInstance } from "@shared/types/panel";
import { DEFAULT_CONTINUE_NOTE } from "@/services/wakeContinue/wakeContinue";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useWakeContinueStore, type WakeContinueOffer } from "@/store/wakeContinueStore";
import { WakeContinueDialog } from "../WakeContinueDialog";
import { WakeContinueNotice } from "../WakeContinueNotice";

const RESTORED_AT = 100;
type Outcome = "resumed" | "fresh" | "held";
type Project = ReturnType<typeof useProjectStore.getState>["currentProject"];

function entry(terminalId: string, outcome: Outcome): WakeContinueOffer["entries"][number] {
  return {
    terminalId,
    title: `Agent ${terminalId}`,
    agentId: "claude",
    worktreeId: null,
    outcome,
    ...(outcome === "held" && { holdReason: "resume-deferred", heldSessionId: `s-${terminalId}` }),
    restoredAt: RESTORED_AT,
  };
}

/** Panels as the restore left them: their provenance is what the offer reads live. */
function placePanels(panels: Record<string, Outcome>): void {
  usePanelStore.setState({
    panelsById: Object.fromEntries(
      Object.entries(panels).map(([id, outcome]) => [
        id,
        {
          id,
          kind: "terminal",
          location: "grid",
          restoreProvenance: {
            at: RESTORED_AT,
            disposition: outcome === "resumed" ? "resume" : outcome,
          },
          ...(outcome === "held" && { restoreRecovery: { reason: "resume-deferred" } }),
        } as unknown as PanelInstance,
      ])
    ),
  });
}

function offer(overrides: Partial<WakeContinueOffer> = {}): WakeContinueOffer {
  return {
    id: "wake-1",
    projectId: "p1",
    entries: [entry("a", "resumed"), entry("b", "resumed"), entry("c", "fresh")],
    phase: "offered",
    ...overrides,
  };
}

function renderOffer() {
  return render(
    <>
      <WakeContinueNotice />
      <WakeContinueDialog />
    </>
  );
}

const row = (id: string) =>
  document.querySelector(`[data-testid="wake-continue-entries"] [data-terminal-id="${id}"]`)
    ?.textContent;

beforeEach(() => {
  useProjectStore.setState({ currentProject: { id: "p1" } as Project });
  placePanels({ a: "resumed", b: "resumed", c: "fresh" });
});

afterEach(() => {
  cleanup();
  sendWakeContinueNotes.mockClear();
  dismissWakeContinue.mockClear();
  useWakeContinueStore.setState({ offer: null, dialogOpen: false });
  usePanelStore.setState({ panelsById: {} });
  useProjectStore.setState({ currentProject: null });
});

describe("WakeContinueNotice", () => {
  it("shows nothing for another project's offer, even with its dialog open", () => {
    useWakeContinueStore.setState({ offer: offer({ projectId: "other" }), dialogOpen: true });
    renderOffer();
    expect(screen.queryByTestId("wake-continue-notice")).toBeNull();
    expect(screen.queryByTestId("wake-continue-dialog")).toBeNull();
  });

  it("offers the note for the resumed agents, and × withdraws it", () => {
    useWakeContinueStore.setState({ offer: offer() });
    renderOffer();
    expect(screen.getByTestId("wake-continue-notice").textContent).toContain("2 agents resumed");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissWakeContinue).toHaveBeenCalledTimes(1);
    expect(sendWakeContinueNotes).not.toHaveBeenCalled();
  });

  it("counts a pane restarted since the wake out", () => {
    usePanelStore.setState((state) => ({
      panelsById: {
        ...state.panelsById,
        b: { ...state.panelsById.b!, restoreProvenance: undefined } as PanelInstance,
      },
    }));
    useWakeContinueStore.setState({ offer: offer() });
    renderOffer();
    expect(screen.getByTestId("wake-continue-notice").textContent).toContain("1 agent resumed");
  });

  it("asks a fleet held for the user to start them first", () => {
    placePanels({ a: "held" });
    useWakeContinueStore.setState({ offer: offer({ entries: [entry("a", "held")] }) });
    renderOffer();
    expect(screen.getByTestId("wake-continue-notice").textContent).toContain(
      "1 agent waiting to resume"
    );
  });

  it("sends the edited note from the review dialog, listing who gets none", async () => {
    useWakeContinueStore.setState({ offer: offer() });
    renderOffer();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Review note" }));
    });

    await screen.findByTestId("wake-continue-entries");
    expect(row("c")).toContain("Started a new session — no note");
    expect(row("a")).toContain("Included");

    const note = screen.getByTestId("wake-continue-note") as HTMLTextAreaElement;
    expect(note.value).toBe(DEFAULT_CONTINUE_NOTE);
    expect(note.value.trim()).not.toBe("");
    fireEvent.change(note, { target: { value: "Finish the migration, then stop." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send to 2 agents" }));
    });
    expect(sendWakeContinueNotes).toHaveBeenCalledWith("Finish the migration, then stop.");
    expect(useWakeContinueStore.getState().dialogOpen).toBe(false);
  });

  it("won't send a blank note", async () => {
    useWakeContinueStore.setState({ offer: offer(), dialogOpen: true });
    renderOffer();
    const note = (await screen.findByTestId("wake-continue-note")) as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: " \n\t " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send to 2 agents" }));
    });
    expect(sendWakeContinueNotes).not.toHaveBeenCalled();
  });

  it("reports progress once sending, and × stops it", () => {
    useWakeContinueStore.setState({
      offer: offer({
        phase: "sending",
        entries: [
          { ...entry("a", "resumed"), delivery: { status: "sent" } },
          { ...entry("b", "resumed"), delivery: { status: "failed", message: "Closed" } },
          {
            ...entry("d", "resumed"),
            delivery: { status: "failed", message: "Cut off", partial: true },
          },
          entry("c", "fresh"),
        ],
      }),
    });
    renderOffer();
    const text = screen.getByTestId("wake-continue-notice").textContent;
    expect(text).toContain("1 of 3 agents sent");
    expect(text).toContain("1 unconfirmed");
    expect(text).toContain("1 not sent");
    fireEvent.click(screen.getByRole("button", { name: "Stop sending" }));
    expect(dismissWakeContinue).toHaveBeenCalledTimes(1);
  });
});
