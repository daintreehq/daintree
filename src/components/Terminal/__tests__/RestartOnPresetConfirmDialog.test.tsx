// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

import { RestartOnPresetConfirmDialog, type RestartOnPresetRequest } from "../RestartOnPreset";
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
    agentPresetId: "personal",
  };
  usePanelStore.setState({ panelsById: { t1: pane }, panelIds: ["t1"] });
}

const request: RestartOnPresetRequest = {
  terminalId: "t1",
  terminalTitle: "Agent",
  agentWorking: false,
  preset: { id: "company", name: "Company" },
};

function renderDialog(): void {
  render(
    <RestartOnPresetConfirmDialog
      request={request}
      onClose={() => {}}
      sourceRef={{ current: "user" }}
    />
  );
}

afterEach(() => {
  cleanup();
  dispatchMock.mockClear();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("RestartOnPresetConfirmDialog — keeping the conversation (#16045)", () => {
  it("starts unchecked, and asks for the conversation once checked", () => {
    seedPane("codex");
    renderDialog();

    const keep = screen.getByRole("checkbox", { name: "Keep this conversation" });
    expect(keep.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/starts a new conversation/)).toBeTruthy();

    act(() => {
      fireEvent.click(keep);
    });
    expect(screen.getByText(/reopens this conversation/)).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart on preset" }));
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.restartOnPreset",
      { terminalId: "t1", presetId: "company", confirmed: true, keepConversation: true },
      { source: "user" }
    );
  });

  it("starts every opening unchecked, and an unchecked confirm asks for no conversation", () => {
    seedPane("codex");
    const props = { onClose: () => {}, sourceRef: { current: "user" as const } };
    const view = render(<RestartOnPresetConfirmDialog request={request} {...props} />);
    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Keep this conversation" }));
    });

    view.rerender(<RestartOnPresetConfirmDialog request={null} {...props} />);
    view.rerender(<RestartOnPresetConfirmDialog request={request} {...props} />);

    const keep = screen.getByRole("checkbox", { name: "Keep this conversation" });
    expect(keep.getAttribute("aria-checked")).toBe("false");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart on preset" }));
    });
    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.restartOnPreset",
      { terminalId: "t1", presetId: "company", confirmed: true },
      { source: "user" }
    );
  });

  it("offers nothing for an agent whose refusal isn't recognised", () => {
    seedPane("gemini");
    renderDialog();

    expect(screen.queryByRole("checkbox", { name: "Keep this conversation" })).toBeNull();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart on preset" }));
    });
    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.restartOnPreset",
      { terminalId: "t1", presetId: "company", confirmed: true },
      { source: "user" }
    );
  });
});
