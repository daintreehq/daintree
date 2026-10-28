import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  clearPluginThemeRegistry,
  getPluginTheme,
  getPluginThemeSchemes,
  loadPluginThemes,
  registerPluginThemes,
  unregisterPluginThemes,
} from "../PluginThemeRegistry.js";
import { BUILT_IN_THEME_SOURCES } from "../../../../shared/theme/builtInThemes/index.js";

const DAINTREE = BUILT_IN_THEME_SOURCES.find((source) => source.id === "daintree")!;
const BONDI = BUILT_IN_THEME_SOURCES.find((source) => source.id === "bondi")!;

function themeFile(source: typeof DAINTREE): string {
  return JSON.stringify({
    palette: source.palette,
    ...(source.tokens ? { tokens: source.tokens } : {}),
    ...(source.extensions ? { extensions: source.extensions } : {}),
  });
}

describe("PluginThemeRegistry", () => {
  let dir: string;

  beforeEach(async () => {
    clearPluginThemeRegistry();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "theme-reg-"));
    await fs.mkdir(path.join(dir, "themes"), { recursive: true });
    await fs.writeFile(path.join(dir, "themes", "night.json"), themeFile(DAINTREE), "utf8");
    await fs.writeFile(path.join(dir, "themes", "day.json"), themeFile(BONDI), "utf8");
  });

  afterEach(async () => {
    clearPluginThemeRegistry();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("offers a theme that clears the gate, under its namespaced id", async () => {
    const result = await loadPluginThemes("acme.themes", "Acme Themes", dir, [
      { id: "night", name: "Night", type: "dark", path: "./themes/night.json" },
      { id: "day", name: "Day", type: "light", path: "themes/day.json" },
    ]);
    expect(result.refused).toEqual([]);
    registerPluginThemes("acme.themes", result.accepted);

    expect(getPluginThemeSchemes().map((scheme) => [scheme.id, scheme.type])).toEqual([
      ["plugin:acme.themes:night", "dark"],
      ["plugin:acme.themes:day", "light"],
    ]);
    expect(getPluginTheme("plugin:acme.themes:night")?.scheme.plugin).toEqual({
      id: "acme.themes",
      name: "Acme Themes",
    });
  });

  it("refuses a theme that fails a contrast check, with the failure named", async () => {
    const unreadable = {
      ...DAINTREE.palette,
      text: { ...DAINTREE.palette.text, primary: "#1a1a1a" },
    };
    await fs.writeFile(
      path.join(dir, "themes", "murky.json"),
      JSON.stringify({ palette: unreadable }),
      "utf8"
    );
    const result = await loadPluginThemes("acme.themes", "Acme Themes", dir, [
      { id: "murky", name: "Murky", type: "dark", path: "./themes/murky.json" },
    ]);
    expect(result.accepted).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]!.themeId).toBe("murky");
    expect(result.refused[0]!.reason).toMatch(/^failed \d+ contrast checks?: .*text-primary/);
  });

  it("refuses an unreadable, malformed or mismatched file and keeps the others", async () => {
    await fs.writeFile(path.join(dir, "themes", "broken.json"), "{ not json", "utf8");
    await fs.mkdir(path.join(dir, "themes", "folder.json"));
    const result = await loadPluginThemes("acme.themes", "Acme Themes", dir, [
      { id: "night", name: "Night", type: "dark", path: "./themes/night.json" },
      { id: "missing", name: "Missing", type: "dark", path: "./themes/missing.json" },
      { id: "broken", name: "Broken", type: "dark", path: "./themes/broken.json" },
      { id: "folder", name: "Folder", type: "dark", path: "./themes/folder.json" },
      { id: "polarity", name: "Polarity", type: "light", path: "./themes/night.json" },
    ]);
    expect(result.accepted.map((theme) => theme.source.id)).toEqual(["plugin:acme.themes:night"]);
    expect(result.refused.map((entry) => entry.themeId)).toEqual([
      "missing",
      "broken",
      "folder",
      "polarity",
    ]);
    expect(result.refused[3]!.reason).toContain('manifest declares "light"');
  });

  it("refuses a file over the size cap", async () => {
    await fs.writeFile(path.join(dir, "themes", "huge.json"), " ".repeat(200 * 1024), "utf8");
    const result = await loadPluginThemes("acme.themes", "Acme Themes", dir, [
      { id: "huge", name: "Huge", type: "dark", path: "./themes/huge.json" },
    ]);
    expect(result.refused[0]?.reason).toContain("exceeds");
  });

  it("refuses a theme whose path escapes the plugin dir via symlink", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "theme-outside-"));
    await fs.writeFile(path.join(outside, "theme.json"), themeFile(DAINTREE), "utf8");
    try {
      await fs.symlink(path.join(outside, "theme.json"), path.join(dir, "themes", "link.json"));
    } catch (err) {
      // Windows CI without symlink privilege.
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        await fs.rm(outside, { recursive: true, force: true });
        return;
      }
      throw err;
    }
    try {
      const result = await loadPluginThemes("acme.themes", "Acme Themes", dir, [
        { id: "escape", name: "Escape", type: "dark", path: "./themes/link.json" },
      ]);
      expect(result.accepted).toEqual([]);
      expect(result.refused.map((entry) => entry.themeId)).toEqual(["escape"]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("drops exactly one plugin's themes on unregister", async () => {
    const acme = await loadPluginThemes("acme.themes", "Acme", dir, [
      { id: "night", name: "Night", type: "dark", path: "./themes/night.json" },
    ]);
    const other = await loadPluginThemes("other.themes", "Other", dir, [
      { id: "night", name: "Night", type: "dark", path: "./themes/night.json" },
    ]);
    registerPluginThemes("acme.themes", acme.accepted);
    registerPluginThemes("other.themes", other.accepted);

    expect(unregisterPluginThemes("acme.themes")).toBe(true);
    expect(unregisterPluginThemes("acme.themes")).toBe(false);
    expect(getPluginThemeSchemes().map((scheme) => scheme.id)).toEqual([
      "plugin:other.themes:night",
    ]);
  });

  it("replaces a plugin's earlier registration", async () => {
    const both = await loadPluginThemes("acme.themes", "Acme", dir, [
      { id: "night", name: "Night", type: "dark", path: "./themes/night.json" },
      { id: "day", name: "Day", type: "light", path: "./themes/day.json" },
    ]);
    registerPluginThemes("acme.themes", both.accepted);
    registerPluginThemes("acme.themes", both.accepted.slice(1));
    expect(getPluginThemeSchemes().map((scheme) => scheme.id)).toEqual(["plugin:acme.themes:day"]);
  });
});
