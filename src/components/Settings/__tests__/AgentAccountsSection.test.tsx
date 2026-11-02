// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const dispatch = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import { AgentAccountsSection } from "../AgentAccountsSection";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import type { AgentSettingsEntry } from "@shared/types";

const COMPANY = { id: "company", name: "Company", configDir: "/Users/me/.codex-company" };

function renderSection(
  entry: AgentSettingsEntry,
  options: {
    agentId?: string;
    onClose?: (afterClose?: (closed: boolean) => void) => Promise<boolean>;
  } = {}
) {
  return render(
    <AgentAccountsSection
      agentId={options.agentId ?? "codex"}
      agentName="Codex"
      entry={entry}
      onClose={options.onClose}
    />
  );
}

beforeEach(() => {
  dispatch.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AgentAccountsSection (#16040)", () => {
  it("renders nothing for an agent whose CLI can't hold an account per launch", () => {
    const { container } = renderSection({}, { agentId: "cursor" });
    expect(container.innerHTML).toBe("");
  });

  it("offers the add action in the empty list, and no default to choose yet", () => {
    renderSection({});
    expect(screen.getByText(/Add an account to run Codex on another login/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add account" })).toHaveLength(1);
    expect(screen.queryByText("Default account")).toBeNull();
  });

  it("closes Settings before it opens the sign-in terminal on the account", async () => {
    let afterClose: ((closed: boolean) => void) | undefined;
    const onClose = vi.fn(async (callback?: (closed: boolean) => void) => {
      afterClose = callback;
      return true;
    });
    renderSection({ accounts: [COMPANY] }, { onClose });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await act(async () => {});
    expect(dispatch).not.toHaveBeenCalled();

    afterClose?.(true);
    expect(dispatch).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "codex", accountId: "company", presetId: null },
      { source: "user" }
    );
  });

  it("doesn't open the terminal when the close is held", async () => {
    const onClose = vi.fn(async (callback?: (closed: boolean) => void) => {
      callback?.(false);
      return false;
    });
    renderSection({ accounts: [COMPANY] }, { onClose });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await act(async () => {});
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("asks before forgetting an account, then removes it", async () => {
    const removeAccount = vi.fn().mockResolvedValue(undefined);
    useAgentSettingsStore.setState({ removeAccount });
    renderSection({ accounts: [COMPANY] });

    fireEvent.click(screen.getByRole("button", { name: "Remove Company" }));
    expect(removeAccount).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Remove account" }));
    await act(async () => {});

    expect(removeAccount).toHaveBeenCalledWith("codex", "company");
  });
});
