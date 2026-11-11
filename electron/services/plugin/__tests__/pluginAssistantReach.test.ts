import { afterEach, describe, expect, it } from "vitest";
import {
  isPluginAssistantReachAction,
  pluginAssistantReachActionIds,
  setPluginAssistantReachSource,
} from "../pluginAssistantReach.js";

describe("pluginAssistantReach (#16751)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  const source = (ids: string[]) => ({ has: (id: string) => ids.includes(id), ids: () => ids });

  it("reaches nothing until a source is installed", () => {
    expect(isPluginAssistantReachAction("acme.x.resume")).toBe(false);
    expect(pluginAssistantReachActionIds()).toEqual([]);
  });

  it("answers from the installed source, and nothing once it is uninstalled", () => {
    const uninstall = setPluginAssistantReachSource(source(["acme.x.resume"]));
    cleanups.push(uninstall);
    expect(isPluginAssistantReachAction("acme.x.resume")).toBe(true);
    expect(isPluginAssistantReachAction("acme.x.other")).toBe(false);
    expect(pluginAssistantReachActionIds()).toEqual(["acme.x.resume"]);

    uninstall();
    expect(isPluginAssistantReachAction("acme.x.resume")).toBe(false);
  });

  it("leaves a newer source in place when an older one uninstalls", () => {
    const uninstallOld = setPluginAssistantReachSource(source(["acme.old.a"]));
    const uninstallNew = setPluginAssistantReachSource(source(["acme.new.b"]));
    cleanups.push(uninstallNew);

    uninstallOld();
    expect(pluginAssistantReachActionIds()).toEqual(["acme.new.b"]);
  });
});
