import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectPluginCustomIconRefs,
  loadPluginCustomIcon,
  loadPluginCustomIcons,
} from "../pluginIconAssets.js";
import { PLUGIN_CUSTOM_ICON_MAX_BYTES } from "../../../../shared/config/pluginCustomIcon.js";

const GOOD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>';

let root: string;
let pluginDir: string;

async function write(rel: string, content: string | Buffer): Promise<void> {
  const target = path.join(pluginDir, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-icon-assets-"));
  pluginDir = path.join(root, "plugin");
  await fs.mkdir(pluginDir);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function expectError(ref: string, match: RegExp): Promise<void> {
  const outcome = await loadPluginCustomIcon("acme.tools", pluginDir, ref);
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error).toMatch(match);
}

describe("loadPluginCustomIcon", () => {
  it("loads a well-formed monochrome svg", async () => {
    await write("icons/x.svg", GOOD_SVG);
    const outcome = await loadPluginCustomIcon("acme.tools", pluginDir, "./icons/x.svg");
    expect(outcome).toEqual({ ok: true, svg: GOOD_SVG });
  });

  it("accepts an xml prolog, comment and width/height in place of a viewBox", async () => {
    await write(
      "x.svg",
      '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6"/></svg>'
    );
    expect((await loadPluginCustomIcon("acme.tools", pluginDir, "./x.svg")).ok).toBe(true);
  });

  it("rejects a malformed reference before touching the disk", async () => {
    await expectError("./../outside.svg", /segments/);
  });

  it("rejects a missing file and a directory", async () => {
    await expectError("./icons/missing.svg", /not found/);
    await fs.mkdir(path.join(pluginDir, "dir.svg"));
    await expectError("./dir.svg", /not found/);
  });

  it("rejects a symlink that escapes the plugin directory", async () => {
    await fs.writeFile(path.join(root, "outside.svg"), GOOD_SVG);
    await fs.symlink(path.join(root, "outside.svg"), path.join(pluginDir, "link.svg"));
    await expectError("./link.svg", /outside the plugin directory/);
  });

  it("follows a symlink that stays inside the plugin directory", async () => {
    await write("real.svg", GOOD_SVG);
    await fs.symlink(path.join(pluginDir, "real.svg"), path.join(pluginDir, "alias.svg"));
    expect((await loadPluginCustomIcon("acme.tools", pluginDir, "./alias.svg")).ok).toBe(true);
  });

  it("rejects a file over the size cap", async () => {
    const padding = "<!--" + "x".repeat(PLUGIN_CUSTOM_ICON_MAX_BYTES) + "-->";
    await write("big.svg", GOOD_SVG.replace("<path", `${padding}<path`));
    await expectError("./big.svg", /larger than 64 KB/);
  });

  it("rejects invalid UTF-8", async () => {
    await write("bad.svg", Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe]));
    await expectError("./bad.svg", /UTF-8/);
  });

  it.each([
    ["a DOCTYPE", `<!DOCTYPE svg [<!ENTITY x "y">]>${GOOD_SVG}`, /DOCTYPE/],
    [
      "a stylesheet instruction",
      `<?xml-stylesheet href="https://evil.test/a.css"?>${GOOD_SVG}`,
      /stylesheet/,
    ],
    ["a non-svg root", `<html>${GOOD_SVG}</html>`, /root element/],
    [
      "no viewBox or size",
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>',
      /viewBox/,
    ],
    ["nothing drawable", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>', /drawable/],
    [
      "a script",
      GOOD_SVG.replace("</svg>", "<script>alert(1)</script></svg>"),
      /unsafe content/,
    ],
    ["an event handler", GOOD_SVG.replace("<path", '<path onclick="x()"'), /unsafe content/],
    [
      "an external reference",
      GOOD_SVG.replace("</svg>", '<use href="https://evil.test/a.svg#x"/></svg>'),
      /unsafe content/,
    ],
  ])("rejects %s", async (_label, content, match) => {
    await write("x.svg", content);
    await expectError("./x.svg", match);
  });
});

describe("loadPluginCustomIcons", () => {
  const contributes = {
    panels: [{ iconId: "./icons/a.svg" }, { iconId: "puzzle" }],
    toolbarButtons: [{ iconId: "./icons/a.svg" }, { iconId: "./icons/missing.svg" }],
    processTools: [{ iconId: "./icons/missing.svg" }],
  };

  it("collects each reference once with every location that names it", () => {
    expect(collectPluginCustomIconRefs(contributes)).toEqual(
      new Map([
        ["./icons/a.svg", ["contributes.panels.0.iconId", "contributes.toolbarButtons.0.iconId"]],
        [
          "./icons/missing.svg",
          ["contributes.toolbarButtons.1.iconId", "contributes.processTools.0.iconId"],
        ],
      ])
    );
  });

  it("loads the good references and reports each location of a broken one", async () => {
    await write("icons/a.svg", GOOD_SVG);
    const result = await loadPluginCustomIcons("acme.tools", pluginDir, contributes);
    expect([...result.loaded.keys()]).toEqual(["./icons/a.svg"]);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "contributes.toolbarButtons.1.iconId",
      "contributes.processTools.0.iconId",
    ]);
  });
});
