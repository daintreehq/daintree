// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConfigImportReport } from "@shared/types/configBundle";
import type { SettingsCopyPreview } from "@shared/types/ipc/settingsCopy";
import { HostsCopySettingsSection } from "../Hosts/HostsCopySettingsSection";

const preview = (ticket: string): SettingsCopyPreview => ({
  ticket,
  hostPlatform: "linux",
  sections: [
    {
      section: "agentSettings",
      add: 0,
      update: 1,
      unchanged: 0,
      changes: [{ key: "claude", label: "Claude", kind: "update" }],
    },
  ],
  unknownSections: [],
  withheld: [],
});

const REPORT: ConfigImportReport = {
  outcome: "applied",
  rolledBack: false,
  errors: [],
  sections: [
    {
      section: "agentSettings",
      present: true,
      applied: 1,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      leaves: [{ key: "claude", status: "applied" }],
      errors: [],
    },
  ],
};

const settingsCopy = { preview: vi.fn(), apply: vi.fn() };

const HOSTS = [
  { id: "a", name: "alpha", connected: true },
  { id: "b", name: "bravo", connected: true },
  { id: "c", name: "charlie", connected: false },
];

function renderSection() {
  const onOpenHost = vi.fn();
  render(<HostsCopySettingsSection hosts={HOSTS} onOpenHost={onOpenHost} />);
  fireEvent.click(screen.getByTestId("hosts-copy-several"));
  for (const host of HOSTS) fireEvent.click(screen.getByLabelText(new RegExp(host.name)));
  return onOpenHost;
}

beforeEach(() => {
  settingsCopy.preview
    .mockReset()
    .mockImplementation(async ({ hostId }: { hostId: string }) => preview(`ticket-${hostId}`));
  settingsCopy.apply.mockReset().mockResolvedValue(REPORT);
  Object.defineProperty(window, "electron", { value: { settingsCopy }, configurable: true });
});

afterEach(cleanup);

describe("HostsCopySettingsSection", () => {
  it("applies to the hosts that are up and reports the offline one", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /Preview on 3 hosts/ }));
    await waitFor(() => screen.getByRole("button", { name: /Copy to 2 hosts/ }));
    expect(settingsCopy.preview).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText(/charlie is offline|Offline/).length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: /Copy to 2 hosts/ }));
    await waitFor(() => screen.getByText("Results"));
    expect(settingsCopy.apply).toHaveBeenCalledTimes(2);
    expect(settingsCopy.apply).toHaveBeenCalledWith({ hostId: "a", ticket: "ticket-a" });
    expect(settingsCopy.apply).toHaveBeenCalledWith({ hostId: "b", ticket: "ticket-b" });
  });

  it("refuses a host that changed since its preview without stopping the rest", async () => {
    settingsCopy.apply.mockImplementation(async ({ hostId }: { hostId: string }) => {
      if (hostId === "a")
        throw Object.assign(new Error("stale"), {
          name: "AppError",
          code: "SETTINGS_PREVIEW_STALE",
          userMessage: "stale",
        });
      return REPORT;
    });
    const onOpenHost = renderSection();
    fireEvent.click(screen.getByRole("button", { name: /Preview on 3 hosts/ }));
    await waitFor(() => screen.getByRole("button", { name: /Copy to 2 hosts/ }));
    fireEvent.click(screen.getByRole("button", { name: /Copy to 2 hosts/ }));
    await waitFor(() => screen.getByText("Results"));
    expect(screen.getAllByText(/Changed since preview/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Applied/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Open bravo" }));
    expect(onOpenHost).toHaveBeenCalledWith("b");
  });
});
