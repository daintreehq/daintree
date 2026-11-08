/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { AgentHandoffContent } from "@/services/agentHandoff/agentDraft";

// Typed rather than bare `vi.fn()`, so the call site needs no cast.
const openSendToAgentMock =
  vi.fn<(content: AgentHandoffContent, sourceTerminalId?: string) => boolean>();

vi.mock("@/hooks/useSendToAgentPalette", () => ({
  openSendToAgentPaletteWithText: (content: AgentHandoffContent, sourceTerminalId?: string) =>
    openSendToAgentMock(content, sourceTerminalId),
}));

import { ReviewThreadsHandoff } from "../ReviewThreadsHandoff";

const HINT = "Open an agent terminal, then try sending again.";

function renderHandoff() {
  return render(
    <ReviewThreadsHandoff
      worktreePath="/tmp/wt"
      prNumber={42}
      prUrl="https://github.com/o/r/pull/42"
      files={[{ path: "src/a.ts", count: "3", label: "3 unresolved review comments" }]}
    />
  );
}

describe("ReviewThreadsHandoff", () => {
  beforeEach(() => {
    openSendToAgentMock.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it("announces the no-target hint through a region that was already mounted, and describes the button with it", () => {
    openSendToAgentMock.mockReturnValueOnce(false);
    renderHandoff();

    // Captured before the click: a region that mounts already holding its
    // message is the announcement that doesn't land.
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    const button = screen.getByRole("button", { name: "Send review threads to agent" });
    expect(button.getAttribute("aria-describedby")).toBeNull();

    fireEvent.click(button);

    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe(HINT);
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toBe(HINT);
  });

  it("clears the hint and its description once the palette opens", () => {
    openSendToAgentMock.mockReturnValueOnce(false);
    renderHandoff();
    const button = screen.getByRole("button", { name: "Send review threads to agent" });
    fireEvent.click(button);
    expect(screen.getByTestId("review-threads-send-hint")).toBeDefined();

    fireEvent.click(button);

    expect(openSendToAgentMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("review-threads-send-hint")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });

  it("hands the palette the composed text under the PR's name, with no source terminal", () => {
    renderHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Send review threads to agent" }));

    expect(openSendToAgentMock).toHaveBeenCalledTimes(1);
    const [content, sourceTerminalId] = openSendToAgentMock.mock.calls[0]!;
    expect(sourceTerminalId).toBeUndefined();
    expect(content.title).toBe("Unresolved review threads");
    expect(content.sourceLabel).toBe("PR #42");
    expect(content.text).toContain('"path": "src/a.ts"');
    expect(screen.queryByTestId("review-threads-send-hint")).toBeNull();
  });
});
