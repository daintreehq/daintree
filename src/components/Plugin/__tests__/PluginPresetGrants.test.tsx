// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginPresetGrantEntry } from "@shared/types/pluginCapabilityConsent";
import { PluginPresetGrants } from "../PluginPresetGrants";

function grant(presetId: string, presetName: string): PluginPresetGrantEntry {
  return {
    agentId: "claude",
    presetId,
    presetName,
    source: "custom",
    scopeKey: "global",
    approvedAt: 1,
  };
}

function install(list: () => Promise<PluginPresetGrantEntry[]>, revoke = vi.fn(async () => {})) {
  const listPresetGrants = vi.fn(list);
  Reflect.set(window, "electron", {
    pluginCapability: { listPresetGrants, revokePresetGrant: revoke },
  });
  return { listPresetGrants, revoke };
}

afterEach(() => {
  cleanup();
  Reflect.set(window, "electron", undefined);
});

describe("PluginPresetGrants (#16324)", () => {
  it("lists each preset grant and revokes the one asked for", async () => {
    let grants = [grant("zai", "Z.ai"), grant("alt", "Alt")];
    const { revoke } = install(async () => grants);
    render(<PluginPresetGrants pluginId="beads" />);

    const revokeZai = await screen.findByRole("button", { name: /Revoke .* preset Z\.ai/ });
    expect(screen.getByText(/Alt/)).toBeTruthy();
    grants = [grant("alt", "Alt")];
    await act(async () => {
      fireEvent.click(revokeZai);
    });

    expect(revoke).toHaveBeenCalledExactlyOnceWith({
      pluginId: "beads",
      agentId: "claude",
      presetId: "zai",
      source: "custom",
      scopeKey: "global",
    });
    await vi.waitFor(() => expect(screen.queryByText(/Z\.ai/)).toBeNull());
    expect(screen.getByText(/Alt/)).toBeTruthy();
  });

  it("keeps a row whose revoke failed, says so, and a retry revokes it", async () => {
    let grants = [grant("zai", "Z.ai")];
    const revoke = vi
      .fn(async () => {
        grants = [];
      })
      .mockRejectedValueOnce(new Error("disk full"));
    install(async () => grants, revoke);
    render(<PluginPresetGrants pluginId="beads" />);
    const button = await screen.findByRole("button", { name: /Revoke .* preset Z\.ai/ });
    await act(async () => {
      fireEvent.click(button);
    });
    await vi.waitFor(() => expect(screen.getByText(/Couldn.t revoke this/)).toBeTruthy());
    const retry = screen.getByRole("button", { name: /Revoke .* preset Z\.ai/ });
    expect(retry.textContent).toBe("Retry");

    await act(async () => {
      fireEvent.click(retry);
    });
    expect(revoke).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(screen.queryByText(/Z\.ai/)).toBeNull());
  });

  it("says each preset asks first when there are no grants yet", async () => {
    install(async () => []);
    render(<PluginPresetGrants pluginId="beads" />);
    await vi.waitFor(() =>
      expect(
        screen.getByText(/asks the first time the plugin launches an agent on it/)
      ).toBeTruthy()
    );
  });
});
