import { describe, it, expect } from "vitest";
import { PLUGIN_VIEW_GENERATION_PREFIX, stripPluginViewGeneration } from "../pluginViewUrl.js";

describe("stripPluginViewGeneration", () => {
  it("passes an ordinary asset path through untouched", () => {
    expect(stripPluginViewGeneration("dist/view.js")).toEqual({
      path: "dist/view.js",
      generation: null,
    });
  });

  it("strips the generation namespace and reports which one it was", () => {
    expect(stripPluginViewGeneration(`${PLUGIN_VIEW_GENERATION_PREFIX}7/dist/view.js`)).toEqual({
      path: "dist/view.js",
      generation: 7,
    });
  });

  it("leaves a nested path that merely contains the prefix alone", () => {
    expect(stripPluginViewGeneration(`dist/${PLUGIN_VIEW_GENERATION_PREFIX}3/view.js`)).toEqual({
      path: `dist/${PLUGIN_VIEW_GENERATION_PREFIX}3/view.js`,
      generation: null,
    });
  });

  it.each([
    [`${PLUGIN_VIEW_GENERATION_PREFIX}/view.js`, "empty generation"],
    [`${PLUGIN_VIEW_GENERATION_PREFIX}x/view.js`, "non-numeric generation"],
    [`${PLUGIN_VIEW_GENERATION_PREFIX}1.2/view.js`, "fractional generation"],
    [`${PLUGIN_VIEW_GENERATION_PREFIX}-1/view.js`, "negative generation"],
    [`${PLUGIN_VIEW_GENERATION_PREFIX}7`, "namespace with no asset"],
    [`${PLUGIN_VIEW_GENERATION_PREFIX}7/`, "namespace with empty asset"],
    [PLUGIN_VIEW_GENERATION_PREFIX, "bare prefix"],
  ])("rejects %s (%s) rather than resolving it against disk", (input) => {
    expect(stripPluginViewGeneration(input)).toBeNull();
  });

  it("rejects a generation too large to round-trip as an integer", () => {
    expect(
      stripPluginViewGeneration(`${PLUGIN_VIEW_GENERATION_PREFIX}99999999999999999999/view.js`)
    ).toBeNull();
  });
});
