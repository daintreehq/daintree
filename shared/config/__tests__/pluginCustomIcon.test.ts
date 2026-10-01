import { describe, expect, it } from "vitest";
import {
  PLUGIN_CUSTOM_ICON_MAX_REF_LENGTH,
  isPluginCustomIconKey,
  isPluginCustomIconKeyOwnedBy,
  isPluginCustomIconRef,
  makePluginCustomIconKey,
  validatePluginCustomIconRef,
} from "../pluginCustomIcon.js";
import { isPluginIconId } from "../pluginIconIds.js";

describe("pluginCustomIcon", () => {
  it("recognizes only ./-prefixed values as custom references", () => {
    expect(isPluginCustomIconRef("./icons/flutter.svg")).toBe(true);
    expect(isPluginCustomIconRef("./whatever")).toBe(true);
    expect(isPluginCustomIconRef("puzzle")).toBe(false);
    expect(isPluginCustomIconRef("icons/flutter.svg")).toBe(false);
    expect(isPluginCustomIconRef(undefined)).toBe(false);
  });

  it("accepts a plain relative svg path", () => {
    expect(validatePluginCustomIconRef("./icons/flutter.svg")).toBeNull();
    expect(validatePluginCustomIconRef("./flutter.svg")).toBeNull();
    expect(validatePluginCustomIconRef("./a-b_c.d/e.svg")).toBeNull();
  });

  it.each([
    ["no ./ prefix", "icons/x.svg"],
    ["non-svg extension", "./icons/x.png"],
    ["uppercase extension", "./icons/x.SVG"],
    ["parent segment", "./../x.svg"],
    ["nested parent segment", "./icons/../../x.svg"],
    ["dot segment", "./icons/./x.svg"],
    ["empty segment", "./icons//x.svg"],
    ["backslash", "./icons\\x.svg"],
    ["query string", "./x.svg?v=1"],
    ["fragment", "./x.svg#a"],
    ["percent encoding", "./%2e%2e/x.svg"],
    ["colon", "./c:x.svg"],
    ["control character", "./x\u0000.svg"],
  ])("rejects %s", (_label, ref) => {
    expect(validatePluginCustomIconRef(ref)).not.toBeNull();
  });

  it("caps a reference at the processTools iconId limit so it parses on every schema", () => {
    const fits = `./${"a".repeat(PLUGIN_CUSTOM_ICON_MAX_REF_LENGTH - 6)}.svg`;
    expect(fits).toHaveLength(PLUGIN_CUSTOM_ICON_MAX_REF_LENGTH);
    expect(validatePluginCustomIconRef(fits)).toBeNull();
    expect(validatePluginCustomIconRef(`./a${fits.slice(2)}`)).not.toBeNull();
  });

  it("mints lower-cased keys that never collide with a generic id", () => {
    const key = makePluginCustomIconKey("Acme.Tools", "./Icons/Flutter.svg");
    expect(key).toBe("plugin-icon:acme.tools:./icons/flutter.svg");
    expect(isPluginCustomIconKey(key)).toBe(true);
    expect(isPluginIconId(key)).toBe(false);
    expect(isPluginCustomIconKey("./icons/flutter.svg")).toBe(false);
  });

  it("scopes key ownership to the minting plugin", () => {
    const key = makePluginCustomIconKey("acme.tools", "./x.svg");
    expect(isPluginCustomIconKeyOwnedBy(key, "acme.tools")).toBe(true);
    expect(isPluginCustomIconKeyOwnedBy(key, "Acme.Tools")).toBe(true);
    expect(isPluginCustomIconKeyOwnedBy(key, "acme")).toBe(false);
    expect(isPluginCustomIconKeyOwnedBy(key, "other.plugin")).toBe(false);
  });
});
