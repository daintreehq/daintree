// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CodexQuotaProfile } from "@shared/types/ipc/agentQuota";

const readQuota = vi.hoisted(() => vi.fn<() => Promise<CodexQuotaProfile[]>>());
vi.mock("@/clients/codexClient", () => ({
  codexClient: { readQuota: () => readQuota(), refreshQuota: () => readQuota() },
}));

import { PresetAccountRow } from "../PresetAccountRow";
import { SettingsGroup } from "../../SettingsGroup";
import type { AgentPreset } from "@/config/agents";

const COMPANY = { id: "company", name: "Company", configDir: "/Users/me/.codex-company" };
const PERSONAL = { id: "personal", name: "Personal", configDir: "/Users/me/.codex-personal" };

function renderRow(preset: AgentPreset, accounts: unknown, agentId = "codex") {
  const onChange = vi.fn();
  const result = render(
    <SettingsGroup>
      <PresetAccountRow
        agentId={agentId}
        agentName="Codex"
        selectedPreset={preset}
        accounts={accounts}
        onChange={onChange}
      />
    </SettingsGroup>
  );
  return { onChange, ...result };
}

afterEach(() => {
  cleanup();
  readQuota.mockReset();
});

describe("PresetAccountRow (#16133)", () => {
  it("offers nothing for an agent whose CLI keeps one login, or with nothing to pin", () => {
    renderRow({ id: "work", name: "Work" }, [COMPANY], "cursor");
    expect(screen.queryByRole("combobox", { name: "Account" })).toBeNull();
    cleanup();

    renderRow({ id: "work", name: "Work" }, []);
    expect(screen.queryByRole("combobox", { name: "Account" })).toBeNull();
  });

  it("pins one of the agent's accounts", async () => {
    readQuota.mockResolvedValue([]);
    const { onChange } = renderRow({ id: "work", name: "Work" }, [COMPANY, PERSONAL]);
    const select = screen.getByRole("combobox", { name: "Account" });
    expect(select.textContent).toContain("Not pinned");

    fireEvent.keyDown(select, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Personal" }));
    expect(onChange).toHaveBeenCalledWith("personal");
  });

  it("takes a pin away when Not pinned is picked", async () => {
    readQuota.mockResolvedValue([]);
    const { onChange } = renderRow({ id: "work", name: "Work", accountId: "company" }, [
      COMPANY,
      PERSONAL,
    ]);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Account" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Not pinned" }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("shows a pin as changed and takes it away on reset", () => {
    const { onChange } = renderRow({ id: "work", name: "Work", accountId: "company" }, [COMPANY]);
    expect(screen.getByRole("combobox", { name: "Account" }).textContent).toContain("Company");

    fireEvent.click(screen.getByRole("button", { name: "Unpin the account" }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("keeps a pin whose account is gone visible, says launches are refused, and resets it", () => {
    const { onChange } = renderRow({ id: "work", name: "Work", accountId: "removed" }, []);
    expect(
      screen.getByText(/launches with this preset are refused until this is reset/)
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Unpin the account" }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("reads quota only once the list is opened, and shows each account's tightest window (#16407)", async () => {
    readQuota.mockResolvedValue([
      {
        key: "company",
        isDefault: false,
        presetNames: [],
        accountIds: ["company"],
        result: {
          status: "ok",
          planType: null,
          windows: [{ usedPercent: 82, windowDurationMins: 10080, resetsAt: null }],
          fetchedAt: Date.now(),
        },
      },
    ]);
    renderRow({ id: "work", name: "Work" }, [COMPANY, PERSONAL]);
    expect(readQuota).not.toHaveBeenCalled();

    const select = screen.getByRole("combobox", { name: "Account" });
    fireEvent.keyDown(select, { key: "ArrowDown" });
    expect(await screen.findByText("Weekly limit 82% used")).toBeTruthy();
    expect(readQuota).toHaveBeenCalled();
    // Names stay the options' names, and an account with no reading says nothing more.
    expect(screen.getByRole("option", { name: /Company/ })).toBeTruthy();
    expect(screen.getAllByText(/% used/)).toHaveLength(1);
  });
});
