// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantPanelView } from "../AssistantPanelView";
import { PROSE_SPECIMEN } from "../__preview__/proseSpecimen";
import { installPreviewShims } from "../__preview__/previewShims";
import type { AssistantSessionState } from "@/store/assistantStore";

vi.mock("@/components/Terminal/HybridInputBar", () => ({
  HybridInputBar: ({ disabled }: { disabled: boolean }) => (
    <textarea aria-label="Assistant input" disabled={disabled} />
  ),
}));
vi.mock("../AssistantBootSplash", () => ({
  AssistantBootSplash: () => <div aria-label="Boot animation" />,
}));
installPreviewShims();
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  }
);
afterEach(cleanup);

function panel(state: AssistantSessionState, extra = {}) {
  return (
    <AssistantPanelView
      state={state}
      onSubmit={() => true}
      onInterrupt={() => {}}
      onDecideApproval={() => {}}
      {...extra}
    />
  );
}

describe("assistant interaction", () => {
  it("makes readiness independent of the boot animation", () => {
    const state = { ...PROSE_SPECIMEN, turns: [], connection: "starting" as const };
    const { getByRole, getByLabelText, rerender } = render(panel(state));
    expect(getByRole("textbox", { name: "Assistant input" }).hasAttribute("disabled")).toBe(true);
    expect(getByLabelText("Boot animation")).toBeTruthy();
    rerender(panel({ ...state, connection: "ready" }));
    expect(getByRole("textbox", { name: "Assistant input" }).hasAttribute("disabled")).toBe(false);
    expect(getByLabelText("Boot animation")).toBeTruthy();
  });

  it("opens operations from the composer and requests both current readings", () => {
    const onRequestOperations = vi.fn();
    const onRequestTimers = vi.fn();
    const onOperationsOpenChange = vi.fn();
    const { getByRole, rerender } = render(
      panel(PROSE_SPECIMEN, { onRequestOperations, onRequestTimers, onOperationsOpenChange })
    );
    fireEvent.click(getByRole("button", { name: "Operations" }));
    expect(onOperationsOpenChange).toHaveBeenCalledWith(true);
    rerender(
      panel(PROSE_SPECIMEN, {
        operationsOpen: true,
        onRequestOperations,
        onRequestTimers,
        onOperationsOpenChange,
      })
    );
    expect(onRequestOperations).toHaveBeenCalledOnce();
    expect(onRequestTimers).toHaveBeenCalledOnce();
  });

  it("makes a waiting approval reachable while operations are open", () => {
    const onRequestOperations = vi.fn();
    const state: AssistantSessionState = {
      ...PROSE_SPECIMEN,
      approvals: [
        {
          approvalId: "waiting",
          toolId: "terminal.sendCommand",
          grantKey: "terminal.sendCommand",
          summary: "Run command",
          needsTypedConfirm: false,
          rememberable: false,
          requestedAt: 0,
        },
      ],
    };
    const { getByRole } = render(panel(state, { onRequestOperations }));
    fireEvent.click(getByRole("button", { name: "Operations" }));
    fireEvent.click(getByRole("button", { name: "Review approval (1)" }));
    expect(getByRole("button", { name: "Decline" })).toBeTruthy();
  });

  it("returns focus to Operations when closing the deck", () => {
    const { getByRole } = render(panel(PROSE_SPECIMEN, { onRequestOperations: vi.fn() }));
    const trigger = getByRole("button", { name: "Operations" });
    fireEvent.click(trigger);
    fireEvent.click(getByRole("button", { name: "Back to conversation" }));
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the reader's position until they request the latest output", () => {
    const { container, getByRole } = render(panel(PROSE_SPECIMEN));
    const scroller = container.querySelector<HTMLElement>(".assistant-transcript");
    if (!scroller) throw new Error("Transcript scroller is missing");
    Object.defineProperties(scroller, {
      scrollHeight: { value: 2000 },
      clientHeight: { value: 500 },
    });
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(100);
    fireEvent.click(getByRole("button", { name: "Jump to latest" }));
    expect(scroller.scrollTop).toBe(2000);
  });
});
