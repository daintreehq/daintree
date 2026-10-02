// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { TriageCard as TriageCardData, TriageCategory } from "@shared/types/ipc/triage";
import { buildPilotGroups } from "@/components/Pilot/pilotRows";
import { buildTriageSections, type TriageItem } from "../triageModel";
import { TriageCard, type TriageCardHandlers } from "../TriageCard";

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
  return buildTriageSections(groups, new Map([["run-1", data]]))[0]!.items[0]!;
}

function handlers() {
  return {
    onOpen: vi.fn<TriageCardHandlers["onOpen"]>(),
    onChoose: vi.fn<TriageCardHandlers["onChoose"]>(async () => {}),
    onReply: vi.fn<TriageCardHandlers["onReply"]>(async () => {}),
    onTrash: vi.fn<TriageCardHandlers["onTrash"]>(),
  };
}

function renderCard(item: TriageItem, h = handlers()) {
  const view = render(
    <TriageCard item={item} domId="card" isFocused onFocusCard={() => {}} {...h} />
  );
  return { ...view, h, card: view.container.querySelector<HTMLElement>("[data-triage-card]")! };
}

function buttonNamed(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text)
  );
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

describe("TriageCard", () => {
  it("answers an approval by the option the user picks", () => {
    const { container, h } = renderCard(
      itemFor("approval", { question: "Do you want to proceed?", options: ["Yes", "No"] })
    );
    expect(container.textContent).toContain("Do you want to proceed?");
    fireEvent.click(buttonNamed(container, "No"));
    expect(h.onChoose).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }), "No");
    expect(h.onOpen).not.toHaveBeenCalled();
  });

  it("picks an option from the keyboard by its number", () => {
    const { card, h } = renderCard(itemFor("approval", { options: ["Yes", "No"] }));
    fireEvent.keyDown(card, { key: "2" });
    expect(h.onChoose).toHaveBeenCalledWith(expect.anything(), "No");
  });

  it("never offers a text reply on an approval menu", () => {
    const { container } = renderCard(itemFor("approval", { options: ["Yes", "No"] }));
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("sends a reply to a question on Enter", () => {
    const { container, h } = renderCard(
      itemFor("question", { question: "Drop the table or keep it?" })
    );
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Keep it read-only" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(h.onReply).toHaveBeenCalledWith(expect.anything(), "Keep it read-only");
  });

  it("keeps Shift+Enter as a newline rather than a send", () => {
    const { container, h } = renderCard(itemFor("question"));
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "line one" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(h.onReply).not.toHaveBeenCalled();
  });

  it("sends the user to the terminal for a secret instead of taking it inline", () => {
    const { container } = renderCard(
      itemFor("question", { question: "Password:", secretPrompt: true })
    );
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("answer it in the terminal");
  });

  it("offers a follow-up and trash on finished work", () => {
    const { container, h } = renderCard(itemFor("finished"));
    expect(container.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      "Send a follow-up…"
    );
    fireEvent.click(buttonNamed(container, "Trash terminal"));
    expect(h.onTrash).toHaveBeenCalledTimes(1);
  });

  it("goes to the terminal on Enter or a click on the card itself", () => {
    const { card, h } = renderCard(itemFor("error"));
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.click(card);
    expect(h.onOpen).toHaveBeenCalledTimes(2);
  });

  it("draws a working run as one line with its newest screen line", () => {
    const { container } = renderCard(
      itemFor("working", { activity: "Update(src/store/panelStore.ts)" })
    );
    expect(container.textContent).toContain("Update(src/store/panelStore.ts)");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Run the panel store tests?");
  });

  it("answers once per prompt, however the key is pressed or held", () => {
    const { card, container, h } = renderCard(itemFor("approval", { options: ["Yes", "No"] }));
    fireEvent.keyDown(card, { key: "1", repeat: true });
    expect(h.onChoose).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "1" });
    fireEvent.keyDown(card, { key: "2" });
    fireEvent.click(buttonNamed(container, "No"));
    expect(h.onChoose).toHaveBeenCalledTimes(1);
    expect(buttonNamed(container, "Yes").disabled).toBe(true);
  });

  it("lets Escape from an empty composer reach the dialog", () => {
    const onDialogKey = vi.fn();
    const item = itemFor("question");
    const h = handlers();
    const { container } = render(
      <div onKeyDown={(event) => onDialogKey(event.key)}>
        <TriageCard item={item} domId="card" isFocused onFocusCard={() => {}} {...h} />
      </div>
    );
    const textarea = container.querySelector("textarea")!;
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onDialogKey).toHaveBeenCalledWith("Escape");

    onDialogKey.mockClear();
    fireEvent.change(textarea, { target: { value: "draft" } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onDialogKey).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
  });

  it("offers no inline reply before the screen has been read", () => {
    const item = { ...itemFor("question"), card: null, pending: true };
    const { container } = renderCard(item);
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("keeps a reply's draft when sending fails", async () => {
    const h = handlers();
    h.onReply.mockRejectedValue(new Error("gone"));
    const { container } = renderCard(itemFor("question"), h);
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "keep it" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await vi.waitFor(() => expect(textarea.disabled).toBe(false));
    expect(textarea.value).toBe("keep it");
  });

  it("won't trash a working run from the keyboard", () => {
    const { card, h } = renderCard(itemFor("working"));
    fireEvent.keyDown(card, { key: "Backspace", metaKey: true });
    expect(h.onTrash).not.toHaveBeenCalled();
  });

  it("offers no reply on a card gone stale, however recently it asked", () => {
    const item = { ...itemFor("question", { question: "Keep it?" }), stale: true };
    const { container } = renderCard(item);
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("re-arms the answer buttons only for a new prompt revision", () => {
    const h = handlers();
    const first = itemFor("approval", { options: ["Yes", "No"], revision: 3 });
    const { container, rerender } = renderCard(first, h);
    fireEvent.click(buttonNamed(container, "Yes"));
    // A re-read of the same prompt (new observedAt, same revision) stays answered.
    rerender(
      <TriageCard
        item={itemFor("approval", { options: ["Yes", "No"], revision: 3, observedAt: NOW + 5_000 })}
        domId="card"
        isFocused
        onFocusCard={() => {}}
        {...h}
      />
    );
    expect(buttonNamed(container, "Yes").disabled).toBe(true);
    rerender(
      <TriageCard
        item={itemFor("approval", { options: ["Yes", "No"], revision: 4 })}
        domId="card"
        isFocused
        onFocusCard={() => {}}
        {...h}
      />
    );
    expect(buttonNamed(container, "Yes").disabled).toBe(false);
  });
});
