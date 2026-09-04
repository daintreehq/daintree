import { describe, it, expect } from "vitest";
import {
  LAUNCHER_PANEL_BUTTON_IDS,
  LAUNCHER_PANEL_KIND_TO_BUTTON_ID,
  getLauncherPanelButtonIdForKind,
  isPanelButtonOnToolbar,
  isLauncherPanelButtonId,
  decodeLauncherItemToolbarButtonId,
  isLauncherItemOnToolbar,
  isLauncherItemToolbarButtonId,
  launcherItemToolbarButtonId,
} from "@shared/types/toolbar";
import { isAgentButtonOnToolbar } from "../../../../shared/utils/agentPinned";

// The launcher's rendered Panels section is covered in
// `DockLaunchButton.test.tsx`, which owns the merged component's mock surface.
// What is left here is the pair of resolvers the launcher, Settings → Toolbar,
// and the store's hydration repair all read — the place those three surfaces can
// silently disagree.

describe("isPanelButtonOnToolbar", () => {
  it("requires a position as well as an unhidden pin", () => {
    // Two factors since v13: `browser` has no default position, so an absent pin
    // entry alone does not put it on the toolbar.
    expect(isPanelButtonOnToolbar("browser", {}, ["terminal"], ["settings"])).toBe(false);
    expect(isPanelButtonOnToolbar("browser", {}, ["terminal", "browser"], ["settings"])).toBe(true);
  });

  it("reads an explicit hide as off the toolbar even when positioned", () => {
    expect(isPanelButtonOnToolbar("browser", { browser: false }, ["terminal", "browser"], [])).toBe(
      false
    );
  });

  it("reads an explicit promotion as on before its position is rebuilt", () => {
    // The cross-view window: orderings reconcile last-writer-wins, so a stale
    // sibling's write drops the position and `restorePromotedPanelButtons`
    // rebuilds it on the next hydration. Until then the `true` is the record.
    expect(isPanelButtonOnToolbar("browser", { browser: true }, [], [])).toBe(true);
  });

  it("counts a position on either side", () => {
    expect(isPanelButtonOnToolbar("dev-server", {}, [], ["dev-server"])).toBe(true);
  });

  it("reads the ids that ship with a default slot as on with no pin entry", () => {
    // `terminal` and `file-browser` joined the list in #11680 while staying in
    // `DEFAULT_LEFT_BUTTONS`. Array fall-through is what keeps their shipped
    // behavior unchanged — nothing seeds a pin for them.
    expect(isPanelButtonOnToolbar("terminal", {}, ["launcher", "terminal"], [])).toBe(true);
    expect(isPanelButtonOnToolbar("file-browser", {}, ["launcher", "file-browser"], [])).toBe(true);
  });

  it("recognises every id in the shared list, and nothing outside it", () => {
    for (const id of LAUNCHER_PANEL_BUTTON_IDS) {
      expect(isLauncherPanelButtonId(id)).toBe(true);
    }
    expect(isLauncherPanelButtonId("launcher")).toBe(false);
    expect(isLauncherPanelButtonId("claude")).toBe(false);
  });
});

describe("getLauncherPanelButtonIdForKind", () => {
  it("resolves the dev preview kind to the button id it does not share a name with", () => {
    // The one pair where the panel-kind vocabulary and the toolbar vocabulary
    // disagree. A surface testing `isLauncherPanelButtonId(kindId)` instead
    // drops this row and reports nothing.
    expect(getLauncherPanelButtonIdForKind("dev-preview")).toBe("dev-server");
    expect(getLauncherPanelButtonIdForKind("dev-server")).toBeUndefined();
  });

  it("resolves every mapped kind to an id the toolbar list recognises", () => {
    // The map is the only thing standing between a launcher row and a write to
    // a button id nothing renders.
    for (const kindId of Object.keys(LAUNCHER_PANEL_KIND_TO_BUTTON_ID)) {
      const buttonId = getLauncherPanelButtonIdForKind(kindId);
      expect(buttonId).toBeDefined();
      expect(isLauncherPanelButtonId(buttonId!)).toBe(true);
    }
  });

  it("covers every pinnable button id, so no panel row is left unpinnable", () => {
    const mapped = new Set(Object.values(LAUNCHER_PANEL_KIND_TO_BUTTON_ID));
    expect([...LAUNCHER_PANEL_BUTTON_IDS].filter((id) => !mapped.has(id))).toEqual([]);
  });

  it("returns undefined for kinds outside the fixed four", () => {
    // Since #12217 these are pinnable through a launcher-item id instead; what
    // this resolver still has to say is that they own none of the four fixed
    // button ids, rather than throwing or guessing one.
    expect(getLauncherPanelButtonIdForKind("review")).toBeUndefined();
    expect(getLauncherPanelButtonIdForKind("diff")).toBeUndefined();
    expect(getLauncherPanelButtonIdForKind("file")).toBeUndefined();
    expect(getLauncherPanelButtonIdForKind("some-plugin-kind")).toBeUndefined();
  });

  it("does not resolve inherited Object properties as button ids", () => {
    // A plugin kind is an arbitrary string reaching a plain-object lookup.
    expect(getLauncherPanelButtonIdForKind("constructor")).toBeUndefined();
    expect(getLauncherPanelButtonIdForKind("toString")).toBeUndefined();
    expect(getLauncherPanelButtonIdForKind("__proto__")).toBeUndefined();
  });
});

describe("isAgentButtonOnToolbar (#11680)", () => {
  it("requires a position as well as an installed binary when the pin is unset", () => {
    // The whole point of dropping the `LAUNCHABLE_AGENT_IDS` spread: installing a
    // CLI no longer implies a toolbar slot. `isAgentToolbarVisible` still answers
    // the old question and would report this one as on.
    expect(isAgentButtonOnToolbar(undefined, "ready", false)).toBe(false);
    expect(isAgentButtonOnToolbar(undefined, "ready", true)).toBe(true);
  });

  it("reads a grandfathered profile's positioned-but-uninstalled agent as off", () => {
    expect(isAgentButtonOnToolbar(undefined, "missing", true)).toBe(false);
  });

  it("lets an explicit pin win over having no position", () => {
    // A fresh profile pins from the launcher before any array write lands, and
    // `buildInitialAgentPinUpdates` stamps `true` for the first few installed
    // agents with no position at all.
    expect(isAgentButtonOnToolbar({ pinned: true }, "missing", false)).toBe(true);
  });

  it("lets an explicit hide win over a position", () => {
    expect(isAgentButtonOnToolbar({ pinned: false }, "ready", true)).toBe(false);
  });
});

describe("launcher item button ids (#12217)", () => {
  it("round-trips a source id that contains the characters the id space is built from", () => {
    // A plugin-contributed recipe's id is `publisher.name`, and nothing stops a
    // recipe or plugin kind id carrying a colon either. The encoding splits on
    // the first two colons and takes the rest verbatim, so neither escapes.
    for (const sourceId of [
      "acme.deploy",
      "with:colons:inside",
      "0f8c1d2e-3a4b-5c6d-7e8f-901234567890",
      "inrepo-ship-it",
      "Ünïcøde ✨",
    ]) {
      const id = launcherItemToolbarButtonId("recipe", sourceId);
      expect(decodeLauncherItemToolbarButtonId(id)).toEqual({ category: "recipe", sourceId });
    }
  });

  it("keeps the three categories apart for one source id", () => {
    // An agent, a panel kind and a recipe may all be called `review`. Three
    // rows sharing one key would make pinning any of them pin all three.
    const ids = (["agent", "panel", "recipe"] as const).map((category) =>
      launcherItemToolbarButtonId(category, "review")
    );
    expect(new Set(ids).size).toBe(3);
  });

  it("never mints an id a built-in or plugin button could also own", () => {
    // The prefix is what keeps `sweepStalePluginPinnedButtons` from reading a
    // dotted launcher id as a plugin button it no longer recognises.
    expect(isLauncherItemToolbarButtonId(launcherItemToolbarButtonId("agent", "acme.helper"))).toBe(
      true
    );
    expect(isLauncherItemToolbarButtonId("claude")).toBe(false);
    expect(isLauncherItemToolbarButtonId("dev-server")).toBe(false);
    expect(isLauncherItemToolbarButtonId("acme.deploy")).toBe(false);
    expect(isLauncherItemToolbarButtonId("plugin-tray")).toBe(false);
  });

  it("rejects a malformed id rather than guessing at its parts", () => {
    expect(decodeLauncherItemToolbarButtonId("launcher:")).toBeNull();
    expect(decodeLauncherItemToolbarButtonId("launcher:recipe")).toBeNull();
    // An empty source id would mint a key no catalog entry can ever match.
    expect(decodeLauncherItemToolbarButtonId("launcher:recipe:")).toBeNull();
    expect(decodeLauncherItemToolbarButtonId("launcher::abc")).toBeNull();
    // A category outside the three the launcher has.
    expect(decodeLauncherItemToolbarButtonId("launcher:cue:create-recipe")).toBeNull();
    expect(decodeLauncherItemToolbarButtonId("not-a-launcher:recipe:abc")).toBeNull();
  });

  it("does not resolve inherited Object properties as categories", () => {
    // The category segment is compared, never used to index a lookup table —
    // this is the regression test that keeps it that way.
    expect(decodeLauncherItemToolbarButtonId("launcher:constructor:x")).toBeNull();
    expect(decodeLauncherItemToolbarButtonId("launcher:toString:x")).toBeNull();
    expect(decodeLauncherItemToolbarButtonId("launcher:__proto__:x")).toBeNull();
  });

  it("reads only an explicit promotion as on the toolbar", () => {
    // Unlike the fixed panel buttons, a launcher item has no default slot to
    // fall through to, so absence and `false` are the same answer and nothing
    // may seed either (#11667).
    const id = launcherItemToolbarButtonId("recipe", "r1");
    expect(isLauncherItemOnToolbar(id, {})).toBe(false);
    expect(isLauncherItemOnToolbar(id, { [id]: false })).toBe(false);
    expect(isLauncherItemOnToolbar(id, { [id]: true })).toBe(true);
  });

  it("does not read an inherited Object property as a pin", () => {
    // `pinnedButtons` is a plain object carrying arbitrary string keys.
    const id = launcherItemToolbarButtonId("recipe", "constructor");
    expect(isLauncherItemOnToolbar(id, {})).toBe(false);
  });
});
