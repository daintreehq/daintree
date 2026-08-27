import { describe, expect, it } from "vitest";
import { capabilityAction, titleFor } from "../PluginCapabilityConfirmDialog";
import { CAPABILITY_META } from "../capabilityMeta";
import { BUILT_IN_PLUGIN_CAPABILITIES, type BuiltInPluginCapability } from "@shared/types/plugin";

const GATED: BuiltInPluginCapability[] = [
  "shell:exec",
  "fs:project-write",
  "fs:user-data-write",
  "git:write",
];

describe("PluginCapabilityConfirmDialog microcopy", () => {
  it("gives each gated capability a distinct, non-empty action phrase", () => {
    const phrases = GATED.map(capabilityAction);
    for (const phrase of phrases) {
      expect(phrase.length).toBeGreaterThan(0);
      // Sentence-fragment verb phrase — no trailing period (UI microcopy rules).
      expect(phrase.endsWith(".")).toBe(false);
    }
    expect(new Set(phrases).size).toBe(GATED.length);
  });

  it("gives each gated capability a distinct, non-empty description", () => {
    // CAPABILITY_META is what the dialog renders through CapabilityRow, so the
    // invariant lives against the copy that actually reaches the user.
    const descriptions = GATED.map((c) => CAPABILITY_META[c].description);
    for (const d of descriptions) expect(d.length).toBeGreaterThan(0);
    expect(new Set(descriptions).size).toBe(GATED.length);
  });

  it("builds a sentence-case title that names the plugin and ends with a question mark", () => {
    const title = titleFor("Acme Tools", "shell:exec");
    expect(title).toContain("Acme Tools");
    expect(title.endsWith("?")).toBe(true);
  });

  it("falls back to a generic phrase for any non-gated capability without throwing", () => {
    for (const cap of BUILT_IN_PLUGIN_CAPABILITIES) {
      expect(capabilityAction(cap).length).toBeGreaterThan(0);
      expect(CAPABILITY_META[cap].description.length).toBeGreaterThan(0);
    }
  });
});
