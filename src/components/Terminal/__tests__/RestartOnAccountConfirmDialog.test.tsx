// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

import { RestartOnAccountConfirmDialog, type RestartOnAccountRequest } from "../RestartOnAccount";
import { usePanelStore } from "@/store/panelStore";
import type { PtyPanelData } from "@shared/types/panel";

function seedPane(launchAgentId: string): void {
  const pane: PtyPanelData = {
    id: "t1",
    kind: "terminal",
    title: "Agent",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "grid",
    launchAgentId,
    agentAccountId: "personal",
  };
  usePanelStore.setState({ panelsById: { t1: pane }, panelIds: ["t1"] });
}

const request: RestartOnAccountRequest = {
  terminalId: "t1",
  terminalTitle: "Agent",
  agentWorking: false,
  account: { id: "company", name: "Company" },
};

const props = { onClose: () => {}, sourceRef: { current: "user" as const } };

afterEach(() => {
  cleanup();
  dispatchMock.mockClear();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("RestartOnAccountConfirmDialog — keeping the conversation (#16135)", () => {
  it("starts unchecked, and asks for the conversation once checked", () => {
    seedPane("claude");
    render(<RestartOnAccountConfirmDialog request={request} {...props} />);

    const keep = screen.getByRole("checkbox", { name: "Keep this conversation" });
    expect(keep.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/starts a new conversation on that account/)).toBeTruthy();

    act(() => {
      fireEvent.click(keep);
    });
    expect(screen.getByText(/reopens this conversation on that account/)).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart on account" }));
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.restartOnAccount",
      { terminalId: "t1", accountId: "company", confirmed: true, keepConversation: true },
      { source: "user" }
    );
  });

  it("starts every opening unchecked, and an unchecked confirm asks for no conversation", () => {
    seedPane("codex");
    const view = render(<RestartOnAccountConfirmDialog request={request} {...props} />);
    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Keep this conversation" }));
    });

    view.rerender(<RestartOnAccountConfirmDialog request={null} {...props} />);
    view.rerender(<RestartOnAccountConfirmDialog request={request} {...props} />);

    const keep = screen.getByRole("checkbox", { name: "Keep this conversation" });
    expect(keep.getAttribute("aria-checked")).toBe("false");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart on account" }));
    });
    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.restartOnAccount",
      { terminalId: "t1", accountId: "company", confirmed: true },
      { source: "user" }
    );
  });

  it("moves to the default login with the conversation when asked", () => {
    seedPane("codex");
    render(
      <RestartOnAccountConfirmDialog
        request={{ ...request, account: { id: null, name: "Default login" } }}
        {...props}
      />
    );

    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Keep this conversation" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart on account" }));
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.restartOnAccount",
      { terminalId: "t1", accountId: null, confirmed: true, keepConversation: true },
      { source: "user" }
    );
  });

  it("offers nothing for an agent whose refusal isn't recognised", () => {
    seedPane("kimi");
    render(<RestartOnAccountConfirmDialog request={request} {...props} />);

    expect(screen.queryByRole("checkbox", { name: "Keep this conversation" })).toBeNull();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart on account" }));
    });
    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.restartOnAccount",
      { terminalId: "t1", accountId: "company", confirmed: true },
      { source: "user" }
    );
  });
});
