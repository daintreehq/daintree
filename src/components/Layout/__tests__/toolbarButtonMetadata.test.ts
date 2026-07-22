// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { TOOLBAR_BUTTON_METADATA, isToolbarButtonVisible } from "../toolbarButtonMetadata";
import type { AnyToolbarButtonId } from "@shared/types/toolbar";

// IDs that intentionally have no entry in TOOLBAR_BUTTON_METADATA. The fixed
// titlebar buttons (sidebar-toggle, assistant-toggle, portal-toggle) are
// rendered directly, never appear in the Settings list, and never enter the
// overflow dropdown — so omitting metadata for them is deliberate.
const FIXED_TITLEBAR_IDS = new Set<AnyToolbarButtonId>([
  "sidebar-toggle",
  "assistant-toggle",
  "portal-toggle",
]);

const CUSTOMIZABLE_BUTTON_IDS: AnyToolbarButtonId[] = [
  "agent-tray",
  "plugin-tray",
  ...(BUILT_IN_AGENT_IDS as readonly string[] as AnyToolbarButtonId[]),
  "terminal",
  "browser",
  "dev-server",
  "voice-recording",
  "forge-stats",
  "notification-center",
  "copy-tree",
  "command-palette",
  "settings",
  "problems",
];

describe("TOOLBAR_BUTTON_METADATA — registry coverage", () => {
  it("has an entry for every customizable built-in button", () => {
    for (const id of CUSTOMIZABLE_BUTTON_IDS) {
      expect(TOOLBAR_BUTTON_METADATA[id], `missing metadata for "${id}"`).toBeDefined();
    }
  });

  it("does not register entries for fixed titlebar buttons", () => {
    // Including them would leak titlebar controls into the Settings drag list.
    for (const id of FIXED_TITLEBAR_IDS) {
      expect(TOOLBAR_BUTTON_METADATA[id], `unexpected metadata for fixed "${id}"`).toBeUndefined();
    }
  });

  it("populates label, icon, and description for every entry", () => {
    for (const [id, meta] of Object.entries(TOOLBAR_BUTTON_METADATA)) {
      expect(meta?.label, `empty label for "${id}"`).toBeTruthy();
      expect(meta?.icon, `missing icon for "${id}"`).toBeDefined();
      expect(meta?.description, `empty description for "${id}"`).toBeTruthy();
    }
  });

  it("uses the canonical agent display name for built-in agent labels", () => {
    // Drift guard for the original issue (#7668): the agent-tray icon and
    // labels must come from the same source the AgentButton renders so the
    // Settings list and the overflow dropdown stay in sync. Sentence-cased
    // per #9825 (lowercase "agent" suffix).
    for (const id of BUILT_IN_AGENT_IDS) {
      const meta = TOOLBAR_BUTTON_METADATA[id as AnyToolbarButtonId];
      expect(meta?.label, `agent "${id}" missing label`).toMatch(/agent$/);
    }
  });
});

describe("isToolbarButtonVisible", () => {
  it("hides a non-agent button when pinnedButtons[id] is false", () => {
    expect(isToolbarButtonVisible("terminal", { terminal: false }, null, undefined)).toBe(false);
  });

  it("shows a non-agent button when pinnedButtons[id] is undefined", () => {
    expect(isToolbarButtonVisible("terminal", {}, null, undefined)).toBe(true);
  });

  it("shows a non-agent button when pinnedButtons[id] is explicitly true", () => {
    expect(isToolbarButtonVisible("terminal", { terminal: true }, null, undefined)).toBe(true);
  });

  it("routes agent IDs to isAgentToolbarVisible (pinned:true wins regardless of pinnedButtons)", () => {
    // Even though pinnedButtons.claude is false (which would hide a non-agent
    // button), agent visibility comes from agentSettingsStore. claude:pinned
    // wins.
    const visible = isToolbarButtonVisible(
      "claude" as AnyToolbarButtonId,
      { claude: false } as Record<AnyToolbarButtonId, boolean>,
      { agents: { claude: { pinned: true } } } as never,
      undefined
    );
    expect(visible).toBe(true);
  });

  it("routes agent IDs to isAgentToolbarVisible (pinned:false hides regardless of pinnedButtons)", () => {
    const visible = isToolbarButtonVisible(
      "claude" as AnyToolbarButtonId,
      { claude: true } as Record<AnyToolbarButtonId, boolean>,
      { agents: { claude: { pinned: false } } } as never,
      undefined
    );
    expect(visible).toBe(false);
  });

  describe("registered plugin contributions — tray-default (#11304)", () => {
    const pluginId = "test.example" as AnyToolbarButtonId;

    it("keeps a contribution out of the toolbar until it is explicitly promoted", () => {
      // Contrast with the built-in default above: a missing entry means
      // "visible" for a built-in but "tray only" for a plugin contribution.
      expect(isToolbarButtonVisible(pluginId, {}, null, undefined, true)).toBe(false);
      expect(isToolbarButtonVisible(pluginId, { [pluginId]: true }, null, undefined, true)).toBe(
        true
      );
    });

    it("treats a legacy hide entry the same as no entry", () => {
      // Pre-#11304 profiles recorded hides as `false`; both now read as
      // tray-only, so an upgrading user sees no ghost slot.
      expect(isToolbarButtonVisible(pluginId, { [pluginId]: false }, null, undefined, true)).toBe(
        false
      );
    });

    it("uses registry membership, not the dotted id, to pick the default", () => {
      // The same id resolves opposite ways depending on whether the caller
      // says it is a live contribution — so a built-in that ever gains a dot
      // can't be silently demoted into the tray.
      expect(isToolbarButtonVisible(pluginId, {}, null, undefined, false)).toBe(true);
      expect(isToolbarButtonVisible(pluginId, {}, null, undefined, true)).toBe(false);
    });
  });

  it("never shows an assistant-only agent as a toolbar button, even when installed or pinned (#10634)", () => {
    const id = "daintree-assistant" as AnyToolbarButtonId;
    // Installed (would normally make an agent button appear when pinned:undefined).
    expect(isToolbarButtonVisible(id, {}, null, { "daintree-assistant": "ready" } as never)).toBe(
      false
    );
    // Even an explicit pin must not surface it.
    expect(
      isToolbarButtonVisible(
        id,
        {},
        { agents: { "daintree-assistant": { pinned: true } } } as never,
        { "daintree-assistant": "ready" } as never
      )
    ).toBe(false);
  });
});
