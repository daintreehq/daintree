// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PluginActionsSettingsTab } from "../PluginActionsSettingsTab";

describe("PluginActionsSettingsTab", () => {
  it("recovers a failed settings read in place rather than asking for a reopen", async () => {
    const getAuditConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error("IPC fail"))
      .mockResolvedValueOnce({ enabled: true, maxRecords: 500 });
    Reflect.set(window, "electron", {
      plugin: {
        getAuditConfig,
        getAuditRecords: vi.fn().mockResolvedValue([]),
        setAuditEnabled: vi.fn(),
        exportAuditLog: vi.fn(),
        clearAuditLog: vi.fn(),
      },
    });

    render(<PluginActionsSettingsTab />);
    const toggle = screen.getByRole("switch", { name: /record plugin actions/i });
    await screen.findByText(/couldn't be read/);
    expect(toggle.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText(/couldn't be read/)).toBeNull();
  });
});
