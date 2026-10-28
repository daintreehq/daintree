import { describe, it, expect } from "vitest";
import { presentPluginToolbarButton } from "../pluginToolbarButtonState";
import {
  DEFAULT_PLUGIN_BUTTON_ICON,
  resolvePluginIcon,
} from "@/components/icons/pluginIconRegistry";

const config = { iconId: "star", label: "Sync" };

describe("presentPluginToolbarButton (#13785)", () => {
  it("draws the manifest button when no state is set", () => {
    const p = presentPluginToolbarButton(config, null);
    expect(p.tooltip).toBe("Sync");
    expect(p.pressed).toBeUndefined();
    expect(p.blocked).toBe(false);
    expect(p.Icon).toBe(resolvePluginIcon("star", DEFAULT_PLUGIN_BUTTON_ICON));
  });

  it("keeps an explicit false pressed, so the button still reads as a toggle", () => {
    expect(presentPluginToolbarButton(config, { pressed: false }).pressed).toBe(false);
    expect(presentPluginToolbarButton(config, { pressed: true }).pressed).toBe(true);
  });

  it("puts the disabled reason ahead of the plugin's tooltip, and blocks activation", () => {
    const p = presentPluginToolbarButton(config, {
      tooltip: "Syncs on save",
      disabled: true,
      disabledReason: "Sign in to sync",
    });
    expect(p.tooltip).toBe("Sign in to sync");
    expect(p.disabled).toBe(true);
    expect(p.blocked).toBe(true);
    expect(presentPluginToolbarButton(config, { tooltip: "Syncs on save" }).tooltip).toBe(
      "Syncs on save"
    );
  });

  it("blocks activation while busy without calling the button disabled", () => {
    const p = presentPluginToolbarButton(config, { busy: true });
    expect(p.busy).toBe(true);
    expect(p.disabled).toBe(false);
    expect(p.blocked).toBe(true);
  });

  it("swaps to a known icon and falls back to the manifest icon for an unknown one", () => {
    const manifest = resolvePluginIcon("star", DEFAULT_PLUGIN_BUTTON_ICON);
    const swapped = presentPluginToolbarButton(config, { iconId: "rocket" }).Icon;
    expect(swapped).toBe(resolvePluginIcon("rocket", manifest));
    expect(swapped).not.toBe(manifest);
    expect(presentPluginToolbarButton(config, { iconId: "no-such-icon-xyz" }).Icon).toBe(manifest);
  });
});
