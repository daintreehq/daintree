/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { AgentHandoffContent } from "@/services/agentHandoff/agentDraft";

const openSendToAgentMock =
  vi.fn<(content: AgentHandoffContent, sourceTerminalId?: string) => boolean>();

vi.mock("@/hooks/useSendToAgentPalette", () => ({
  openSendToAgentPaletteWithText: (content: AgentHandoffContent, sourceTerminalId?: string) =>
    openSendToAgentMock(content, sourceTerminalId),
}));

import { ConflictAgentHandoff } from "../ConflictAgentHandoff";

const HINT = "Open an agent terminal, then try sending again.";

function renderHandoff() {
  return render(
    <ConflictAgentHandoff
      worktreePath="/tmp/wt"
      operation="REBASING"
      sides={{ ours: "destination branch", theirs: "incoming commit" }}
      rebase={null}
      files={[{ path: "src/a.ts", kind: "both modified", hunkCount: 1, firstMarkerLine: 3 }]}
    />
  );
}

describe("ConflictAgentHandoff", () => {
  beforeEach(() => {
    openSendToAgentMock.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it("hands the palette the composed text under the operation's name, with no source terminal", () => {
    renderHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Send conflicts to agent" }));

    expect(openSendToAgentMock).toHaveBeenCalledTimes(1);
    const [content, sourceTerminalId] = openSendToAgentMock.mock.calls[0]!;
    expect(sourceTerminalId).toBeUndefined();
    expect(content.title).toBe("Conflicted files");
    expect(content.sourceLabel).toBe("Rebase");
    expect(content.text).toContain('"path": "src/a.ts"');
    expect(screen.queryByTestId("conflict-send-to-agent-hint")).toBeNull();
  });

  it("announces the no-target hint through a region that was already mounted, and describes the button with it", () => {
    openSendToAgentMock.mockReturnValueOnce(false);
    renderHandoff();

    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    const button = screen.getByRole("button", { name: "Send conflicts to agent" });
    expect(button.getAttribute("aria-describedby")).toBeNull();

    fireEvent.click(button);

    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe(HINT);
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toBe(HINT);
  });

  it("clears the hint once the palette opens", () => {
    openSendToAgentMock.mockReturnValueOnce(false);
    renderHandoff();
    const button = screen.getByRole("button", { name: "Send conflicts to agent" });
    fireEvent.click(button);
    expect(screen.getByTestId("conflict-send-to-agent-hint")).toBeDefined();

    fireEvent.click(button);

    expect(screen.queryByTestId("conflict-send-to-agent-hint")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });
});
