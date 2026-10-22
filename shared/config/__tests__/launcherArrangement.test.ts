import { describe, expect, it } from "vitest";
import {
  MAX_LAUNCHER_GROUP_ORDER,
  STOCK_LAUNCHER_ARRANGEMENT,
  arrangeLauncherGroups,
  featuredRefForLaunchEntry,
  isFeaturedLaunchEntryRef,
  isOwnProjectPlugin,
  parseLauncherGroupOrder,
  resolveLauncherGroupOrder,
} from "../launcherArrangement.js";
import { makeProjectPluginInstanceKey } from "../../types/plugin.js";

const PROJECT = "a".repeat(64);
const OTHER = "b".repeat(64);
const OWN = makeProjectPluginInstanceKey(PROJECT, "acme.records");
const FOREIGN = makeProjectPluginInstanceKey(OTHER, "acme.records");
const INSTALLED = "zeta.tools";

describe("parseLauncherGroupOrder", () => {
  it("keeps well-formed ids once, in order, including ones not drawn right now", () => {
    expect(parseLauncherGroupOrder(["recipes", "plugin:gone.plugin", "recipes", "agents"])).toEqual(
      ["recipes", "plugin:gone.plugin", "agents"]
    );
  });

  it("drops malformed ids and bounds the list", () => {
    expect(parseLauncherGroupOrder(["", 3, "a\nb", "x".repeat(321), "panels"])).toEqual(["panels"]);
    expect(parseLauncherGroupOrder("agents")).toEqual([]);
    const many = Array.from({ length: MAX_LAUNCHER_GROUP_ORDER + 5 }, (_, i) => `g${i}`);
    expect(parseLauncherGroupOrder(many)).toHaveLength(MAX_LAUNCHER_GROUP_ORDER);
  });
});

describe("featured entry references", () => {
  it("accepts {publisher.name}.{entry id}, entry ids with dots included", () => {
    expect(isFeaturedLaunchEntryRef("acme.records.new-record")).toBe(true);
    expect(isFeaturedLaunchEntryRef("acme.records.new.record")).toBe(true);
    expect(isFeaturedLaunchEntryRef("acme.records")).toBe(false);
    expect(isFeaturedLaunchEntryRef("Acme.records.new")).toBe(false);
    expect(isFeaturedLaunchEntryRef(`project__${PROJECT}__acme.records.new`)).toBe(false);
    expect(isFeaturedLaunchEntryRef(42)).toBe(false);
  });

  it("names only a project plugin's entry, without the machine-local project id", () => {
    expect(featuredRefForLaunchEntry({ id: `${OWN}.new.record`, pluginId: OWN })).toBe(
      "acme.records.new.record"
    );
    expect(featuredRefForLaunchEntry({ id: `${OWN}.new`, pluginId: OWN }, PROJECT)).toBe(
      "acme.records.new"
    );
    // Another project's copy of the same plugin, and an installed plugin, never.
    expect(featuredRefForLaunchEntry({ id: `${FOREIGN}.new`, pluginId: FOREIGN }, PROJECT)).toBe(
      null
    );
    expect(featuredRefForLaunchEntry({ id: `${INSTALLED}.new`, pluginId: INSTALLED })).toBe(null);
  });

  it("knows which plugins the project loads itself", () => {
    expect(isOwnProjectPlugin(OWN, PROJECT)).toBe(true);
    expect(isOwnProjectPlugin(FOREIGN, PROJECT)).toBe(false);
    expect(isOwnProjectPlugin(INSTALLED, PROJECT)).toBe(false);
    expect(isOwnProjectPlugin(OWN, null)).toBe(false);
  });
});

describe("resolveLauncherGroupOrder", () => {
  const stock = ["agents", "panels", "plugin:a", "plugin:b", "recipes"];

  it("is stock until the profile arranges the launcher", () => {
    expect(
      resolveLauncherGroupOrder({ stock, leading: ["plugin:b"], arranged: false, userOrder: [] })
    ).toEqual(stock);
    expect(
      resolveLauncherGroupOrder({ stock, leading: ["plugin:b"], arranged: true, userOrder: [] })
    ).toEqual(["plugin:b", "agents", "panels", "plugin:a", "recipes"]);
  });

  it("lets the user's order win, with groups it does not name following the profile", () => {
    expect(
      resolveLauncherGroupOrder({
        stock,
        leading: ["plugin:b"],
        arranged: true,
        userOrder: ["recipes", "plugin:gone", "agents"],
      })
    ).toEqual(["recipes", "agents", "plugin:b", "panels", "plugin:a"]);
  });
});

describe("arrangeLauncherGroups", () => {
  const groups = [{ pluginId: INSTALLED }, { pluginId: OWN }];

  it("leaves a project nobody arranged in stock order with nothing demoted", () => {
    expect(
      arrangeLauncherGroups(groups, { ...STOCK_LAUNCHER_ARRANGEMENT, projectId: PROJECT })
    ).toEqual({
      shown: ["agents", "panels", `plugin:${INSTALLED}`, `plugin:${OWN}`, "recipes"],
      demoted: [],
      fixedOrder: false,
    });
  });

  it("leads with the project's own plugin and folds demoted groups into More", () => {
    expect(
      arrangeLauncherGroups(groups, {
        projectId: PROJECT,
        demoted: { agents: true, panels: true },
        groupOrder: [],
        featuredEntry: null,
      })
    ).toEqual({
      shown: [`plugin:${OWN}`, `plugin:${INSTALLED}`, "recipes"],
      demoted: ["agents", "panels"],
      fixedOrder: true,
    });
  });

  it("arranges for a featured entry alone, and never lets an installed plugin lead", () => {
    const layout = arrangeLauncherGroups([{ pluginId: INSTALLED }], {
      projectId: PROJECT,
      demoted: { agents: false, panels: false },
      groupOrder: [],
      featuredEntry: "acme.records.new",
    });
    expect(layout.shown[0]).toBe("agents");
    expect(layout.fixedOrder).toBe(true);
  });

  it("keeps the user's order inside More and skips demoted groups with nothing in them", () => {
    const layout = arrangeLauncherGroups(
      groups,
      {
        projectId: PROJECT,
        demoted: { agents: true, panels: true },
        groupOrder: ["panels", "agents"],
        featuredEntry: null,
      },
      (id) => id !== "agents"
    );
    expect(layout.demoted).toEqual(["panels"]);
  });
});
