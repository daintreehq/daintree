// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { TriageCard as TriageCardData, TriageCategory } from "@shared/types/ipc/triage";
import { buildPilotGroups } from "@/components/Pilot/pilotRows";
import { buildTriageInbox, type TriageItem } from "../triageModel";
import { TriageCard, type TriageCardHandlers } from "../TriageCard";
import { useTriageStore } from "@/store/triageStore";

const { submit, sendKey, composerProps, terminalProps } = vi.hoisted(() => ({
  submit: vi.fn(async (..._args: unknown[]) => {}),
  sendKey: vi.fn(async (..._args: unknown[]) => {}),
  composerProps: { current: null as null | Record<string, unknown> },
  terminalProps: { current: null as null | Record<string, unknown> },
}));

// The live terminal needs a canvas and a PTY host; here only what it is handed matters.
vi.mock("../TriageTerminal", () => ({
  TriageTerminal: (props: Record<string, unknown>) => {
    terminalProps.current = props;
    return <div data-triage-terminal="" />;
  },
}));

vi.mock("@/components/Terminal/HybridInputBar", () => ({
  HybridInputBar: (props: Record<string, unknown>) => {
    composerProps.current = props;
    return <div data-testid="composer" />;
  },
}));

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { triage: { terminalSubmit: submit, terminalSendKey: sendKey } },
  });
  // Answers outlive a card by design, so they must not leak between tests.
  useTriageStore.setState({ acks: {}, reads: {} });
  submit.mockClear();
  sendKey.mockClear();
  composerProps.current = null;
  terminalProps.current = null;
});

/** The app root provides tooltips; the pane's buttons need one. */
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: TooltipProvider });
}

const PROPS = { domId: "card", scanning: false };
const NOW = 1_700_000_000_000;

function itemFor(kind: TriageCategory, card: Partial<TriageCardData> = {}): TriageItem {
  const run: FleetRunRow = {
    runId: "run-1",
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/Users/dev/app",
    agentId: "claude",
    agentState: "waiting",
    title: "Fix flaky panel tests",
    since: NOW - 60_000,
  };
  const groups = buildPilotGroups([run], {
    workspaces: new Map([["p1", { kind: "project", name: "app" }]]),
    currentWorkspaceId: null,
    nowMs: NOW,
  });
  const data: TriageCardData = {
    runId: "run-1",
    spawnedAt: NOW - 3_600_000,
    revision: 1,
    category: kind,
    confidence: 0.95,
    attentionProbability: 0.9,
    attentionScore: null,
    priority: 90,
    stage: "described",
    describing: false,
    headline: "Run the panel store tests?",
    summary: "Claude wants to run npm test.",
    question: null,
    options: [],
    secretPrompt: false,
    activity: null,
    observedAt: NOW,
    ...card,
  };
  return buildTriageInbox(groups, new Map([["run-1", data]]))[0]!;
}

function handlers() {
  return {
    onOpen: vi.fn<TriageCardHandlers["onOpen"]>(),
    onChoose: vi.fn<TriageCardHandlers["onChoose"]>(async () => {}),
    onTrash: vi.fn<TriageCardHandlers["onTrash"]>(),
    onSent: vi.fn<TriageCardHandlers["onSent"]>(),
    onSendFailed: vi.fn<TriageCardHandlers["onSendFailed"]>(),
  };
}

function renderCard(item: TriageItem, h = handlers()) {
  const view = render(<TriageCard item={item} {...PROPS} {...h} />);
  return { ...view, h, pane: view.container.querySelector<HTMLElement>("[data-triage-detail]")! };
}

function buttonNamed(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.includes(text) || b.getAttribute("aria-label") === text
  );
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

/** The live view reports its stream; here, as main would once it opened. */
async function streamOpens(state: { watchId: number | null; secretPrompt?: boolean }) {
  const report = terminalProps.current!.onStreamChange as (s: unknown) => void;
  await act(async () => report({ ended: false, secretPrompt: false, ...state }));
}

/** The lazy composer resolves on a later tick. */
async function composer() {
  await vi.waitFor(() => expect(composerProps.current).not.toBeNull());
  return composerProps.current as {
    terminalId: string;
    isolated: boolean;
    disabled: boolean;
    onSend: (payload: { text: string; imagePaths?: string[] }) => void;
    onSendKey: (key: string) => void;
  };
}

describe("TriageCard", () => {
  it("shows the run's own terminal, live, for its incarnation", () => {
    renderCard(itemFor("question"));
    expect(terminalProps.current).toMatchObject({ runId: "run-1", spawnedAt: NOW - 3_600_000 });
  });

  it("gives the real composer, isolated, and sends what is typed to that run", async () => {
    const { h } = renderCard(itemFor("question"));
    expect((await composer()).disabled).toBe(true);
    await streamOpens({ watchId: 7 });
    const bar = await composer();
    // Never a fleet broadcast, and never the pane's own input controller.
    expect(bar.isolated).toBe(true);
    expect(bar.terminalId).toBe("run-1");
    expect(bar.disabled).toBe(false);
    await act(async () => bar.onSend({ text: "Keep it read-only" }));
    // Through the open stream, so main sends to the incarnation on screen.
    expect(submit).toHaveBeenCalledWith(7, "Keep it read-only", undefined);
    expect(h.onSent).toHaveBeenCalledTimes(1);
  });

  it("sends nothing before the stream is open", async () => {
    renderCard(itemFor("question"));
    await act(async () => (await composer()).onSend({ text: "too early" }));
    expect(submit).not.toHaveBeenCalled();
  });

  it("reports a send main refused", async () => {
    submit.mockRejectedValueOnce(new Error("gone"));
    const { h } = renderCard(itemFor("question"));
    await streamOpens({ watchId: 7 });
    await act(async () => (await composer()).onSend({ text: "hello" }));
    expect(h.onSendFailed).toHaveBeenCalledTimes(1);
    expect(h.onSent).not.toHaveBeenCalled();
  });

  it("passes the composer's keys straight to the terminal", async () => {
    renderCard(itemFor("approval", { options: ["Yes", "No"] }));
    await streamOpens({ watchId: 7 });
    await act(async () => (await composer()).onSendKey("escape"));
    expect(sendKey).toHaveBeenCalledWith(7, "escape");
  });

  it("keeps a secret out of the composer, which records history", async () => {
    const { container } = renderCard(
      itemFor("question", { question: "Password:", secretPrompt: true })
    );
    await act(async () => {});
    expect(composerProps.current).toBeNull();
    expect(container.textContent).toContain("type it straight into the terminal");
  });

  it("hides the composer when the live screen asks for a secret the readers haven't seen", async () => {
    const { container } = renderCard({ ...itemFor("question"), card: null, pending: true });
    await composer();
    await streamOpens({ watchId: 7, secretPrompt: true });
    expect(container.querySelector('[data-testid="composer"]')).toBeNull();
    expect(container.textContent).toContain("type it straight into the terminal");
  });

  it("answers an approval by the option the user picks", () => {
    const { container, h } = renderCard(
      itemFor("approval", { question: "Do you want to proceed?", options: ["Yes", "No"] })
    );
    fireEvent.click(buttonNamed(container, "No"));
    expect(h.onChoose).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }), "No");
    expect(h.onOpen).not.toHaveBeenCalled();
  });

  it("picks an option from the keyboard by its number", () => {
    const { pane, h } = renderCard(itemFor("approval", { options: ["Yes", "No"] }));
    fireEvent.keyDown(pane, { key: "2" });
    expect(h.onChoose).toHaveBeenCalledWith(expect.anything(), "No");
  });

  it("leaves keys typed into the live terminal to the agent", () => {
    const { container, h } = renderCard(itemFor("approval", { options: ["Yes", "No"] }));
    fireEvent.keyDown(container.querySelector("[data-triage-terminal]")!, { key: "2" });
    expect(h.onChoose).not.toHaveBeenCalled();
  });

  it("keeps Escape inside the terminal from closing the dialog around it", () => {
    const onDialogKey = vi.fn();
    const h = handlers();
    const { container } = render(
      <div onKeyDown={(event) => onDialogKey(event.key)}>
        <TriageCard item={itemFor("question")} {...PROPS} {...h} />
      </div>
    );
    fireEvent.keyDown(container.querySelector("[data-triage-terminal]")!, { key: "Escape" });
    expect(onDialogKey).not.toHaveBeenCalled();
  });

  it("answers once per prompt, however the key is pressed or held", () => {
    const { pane, container, h } = renderCard(itemFor("approval", { options: ["Yes", "No"] }));
    fireEvent.keyDown(pane, { key: "1", repeat: true });
    expect(h.onChoose).not.toHaveBeenCalled();
    fireEvent.keyDown(pane, { key: "1" });
    fireEvent.keyDown(pane, { key: "2" });
    fireEvent.click(buttonNamed(container, "No"));
    expect(h.onChoose).toHaveBeenCalledTimes(1);
    expect(buttonNamed(container, "No").disabled).toBe(true);
  });

  it("says which answer main took, in place of the menu", async () => {
    const { container } = renderCard(itemFor("approval", { options: ["Yes", "No"] }));
    fireEvent.click(buttonNamed(container, "No"));
    await vi.waitFor(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toContain("No")
    );
    expect(container.querySelector('[role="group"]')).toBeNull();
  });

  it("offers no quick answers on an approval gone stale", () => {
    const item = { ...itemFor("approval", { options: ["Yes", "No"] }), stale: true };
    const { container } = renderCard(item);
    expect(container.querySelector('[role="group"]')).toBeNull();
  });

  it("re-arms the answer buttons only for a new prompt revision", async () => {
    const h = handlers();
    const first = itemFor("approval", { options: ["Yes", "No"], revision: 3 });
    const { container, rerender } = render(<TriageCard item={first} {...PROPS} {...h} />);
    fireEvent.click(buttonNamed(container, "Yes"));
    // A re-read of the same prompt (new observedAt, same revision) stays answered.
    rerender(
      <TriageCard
        item={itemFor("approval", { options: ["Yes", "No"], revision: 3, observedAt: NOW + 5_000 })}
        {...PROPS}
        {...h}
      />
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Answered"));
    rerender(
      <TriageCard
        item={itemFor("approval", { options: ["Yes", "No"], revision: 4 })}
        {...PROPS}
        {...h}
      />
    );
    expect(buttonNamed(container, "Yes").disabled).toBe(false);
  });

  it("goes to the terminal, and trashes finished work", () => {
    const { container, h } = renderCard(itemFor("finished"));
    fireEvent.click(buttonNamed(container, "Go to terminal"));
    fireEvent.click(buttonNamed(container, "Trash"));
    expect(h.onOpen).toHaveBeenCalledTimes(1);
    expect(h.onTrash).toHaveBeenCalledTimes(1);
  });

  it("won't trash a working run, by button or keyboard", () => {
    const { container, pane, h } = renderCard(itemFor("working"));
    expect(() => buttonNamed(container, "Trash")).toThrow();
    fireEvent.keyDown(pane, { key: "Backspace", metaKey: true });
    expect(h.onTrash).not.toHaveBeenCalled();
  });

  it("only claims to be reading a screen while a read is in flight", () => {
    const item = { ...itemFor("working"), card: null, pending: true };
    const idle = renderCard(item);
    expect(idle.container.textContent).toContain("Refresh to read it");
    idle.unmount();
    const scanning = render(<TriageCard item={item} domId="card" scanning {...handlers()} />);
    expect(scanning.container.textContent).toContain("Reading the screen");
  });
});
