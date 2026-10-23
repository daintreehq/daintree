import { beforeEach, describe, expect, it } from "vitest";
import {
  PLUGIN_EXTERNAL_LINK_BURST,
  PLUGIN_EXTERNAL_LINK_REFILL_MS,
  admitPluginExternalLink,
  resetPluginExternalLinkBudget,
} from "../pluginExternalLinks.js";

describe("admitPluginExternalLink", () => {
  beforeEach(() => resetPluginExternalLinkBudget());

  it("admits a burst, then refuses until a token refills", () => {
    for (let i = 0; i < PLUGIN_EXTERNAL_LINK_BURST; i++) {
      expect(admitPluginExternalLink("acme.x", 0)).toBe(true);
    }
    expect(admitPluginExternalLink("acme.x", 0)).toBe(false);
    expect(admitPluginExternalLink("acme.x", PLUGIN_EXTERNAL_LINK_REFILL_MS - 1)).toBe(false);
    expect(admitPluginExternalLink("acme.x", PLUGIN_EXTERNAL_LINK_REFILL_MS)).toBe(true);
    expect(admitPluginExternalLink("acme.x", PLUGIN_EXTERNAL_LINK_REFILL_MS)).toBe(false);
  });

  it("keeps each plugin's budget separate", () => {
    for (let i = 0; i < PLUGIN_EXTERNAL_LINK_BURST; i++) admitPluginExternalLink("acme.x", 0);
    expect(admitPluginExternalLink("acme.x", 0)).toBe(false);
    expect(admitPluginExternalLink("acme.y", 0)).toBe(true);
  });

  it("does not mint a burst from a clock that steps backwards", () => {
    for (let i = 0; i < PLUGIN_EXTERNAL_LINK_BURST; i++) admitPluginExternalLink("acme.x", 100_000);
    expect(admitPluginExternalLink("acme.x", 0)).toBe(false);
    expect(admitPluginExternalLink("acme.x", 100_000)).toBe(false);
  });
});
