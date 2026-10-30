import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHandoffContent } from "@/services/agentHandoff/agentDraft";

const { buffers, captureBufferText, draftAssistantContext, openPalette, helpState } = vi.hoisted(
  () => {
    const buffers = new Map<string, string>();
    return {
      buffers,
      captureBufferText: vi.fn((id: string, maxChars: number) =>
        (buffers.get(id) ?? "").slice(-maxChars)
      ),
      draftAssistantContext: vi.fn<(content: AgentHandoffContent) => unknown>(),
      openPalette: vi.fn<(content: AgentHandoffContent, sourceTerminalId?: string) => boolean>(),
      helpState: { terminalId: "help" as string | null },
    };
  }
);

vi.mock("@/services/terminal/terminalInstanceServiceAccessor", () => ({
  peek: () => ({ captureBufferText }),
}));
vi.mock("@/services/agentHandoff/assistantDraft", () => ({ draftAssistantContext }));
vi.mock("@/hooks/useSendToAgentPalette", () => ({ openSendToAgentPaletteWithText: openPalette }));
// The heading's source half is the pane's display title, which this stub
// derives from the id so a heading taken from the wrong pane shows up.
vi.mock("@/services/agentHandoff/agentDraft", () => ({
  paneHandoffHeading: (terminalId: string, title: string) => ({
    title,
    sourceLabel: `pane ${terminalId}`,
  }),
}));
vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: { getState: () => helpState },
  selectActiveSlot: (state: typeof helpState) => state,
}));

const { sendCompletionToAgent, sendCompletionToAssistant } = await import("../completionHandoff");

beforeEach(() => {
  vi.clearAllMocks();
  buffers.clear();
  helpState.terminalId = "help";
});

describe("sendCompletionToAssistant", () => {
  it("drafts the finished pane's own output, headed with that pane", () => {
    buffers.set("done", "All 12 tests passed");
    buffers.set("other", "unrelated");
    sendCompletionToAssistant("done");

    expect(draftAssistantContext).toHaveBeenCalledTimes(1);
    expect(draftAssistantContext.mock.calls[0]![0]).toMatchObject({
      text: "All 12 tests passed",
      sourceLabel: "pane done",
    });
  });

  it("takes the tail of a long buffer, where the finish is", () => {
    buffers.set("done", `${"a".repeat(30000)}THE END`);
    sendCompletionToAssistant("done");

    const { text } = draftAssistantContext.mock.calls[0]![0];
    expect(text.endsWith("THE END")).toBe(true);
    expect(text.length).toBeLessThan(30000);
  });

  it("hands nothing over when the capture is blank", () => {
    buffers.set("done", "  \n\t\n");
    sendCompletionToAssistant("done");

    expect(draftAssistantContext).not.toHaveBeenCalled();
  });

  it("never drafts the Assistant's own output back into it", () => {
    buffers.set("help", "assistant output");
    sendCompletionToAssistant("help");

    expect(draftAssistantContext).not.toHaveBeenCalled();
  });
});

describe("sendCompletionToAgent", () => {
  it("opens the palette with the pane's output, excluding the pane itself", () => {
    buffers.set("done", "Migration written");
    sendCompletionToAgent("done");

    expect(openPalette).toHaveBeenCalledTimes(1);
    const [content, sourceTerminalId] = openPalette.mock.calls[0]!;
    expect(content).toMatchObject({ text: "Migration written", sourceLabel: "pane done" });
    expect(sourceTerminalId).toBe("done");
  });

  it("opens nothing when the capture is blank", () => {
    buffers.set("done", "\n\n");
    sendCompletionToAgent("done");

    expect(openPalette).not.toHaveBeenCalled();
  });
});
