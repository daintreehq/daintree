import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { WORKTREE_COLOR_PALETTE } from "@shared/theme/worktreeColors";
import { LANGUAGE_MAP } from "@/components/FileViewer/languageUtils";
import { UNKNOWN_FILE_COLOR_CLASS, getFileTypeIcon } from "../fileTypeIcons";

// These tests assert relationships — "these names agree", "this name outranks
// that one", "this hue comes from the proven palette" — rather than echoing the
// table back. Copying `png -> image` here would just restate the source and
// would have to be edited in lockstep with it, which proves nothing.

/** Members of each group must agree with each other and differ from the others. */
const GROUPS = {
  image: ["logo.png", "shot.JPEG", "icon.svg", "still.webp"],
  video: ["clip.mp4", "reel.MOV", "capture.mkv"],
  audio: ["track.mp3", "voice.wav", "sting.flac"],
  archive: ["bundle.zip", "release.tar.gz", "lib.jar"],
  source: ["main.ts", "app.tsx", "server.py", "lib.rs"],
  script: ["deploy.sh", "setup.bash", "build.ps1"],
  data: ["index.json", "records.jsonl", "shape.geojson"],
  document: ["notes.md", "manual.pdf", "LICENSE"],
  spreadsheet: ["rows.csv", "budget.xlsx"],
  database: ["schema.sql", "cache.sqlite3"],
  font: ["Inter.woff2", "mono.ttf"],
  key: ["server.pem", "client.p12"],
  binary: ["app.exe", "core.dylib", "mod.wasm"],
} as const;

const GROUP_NAMES = Object.keys(GROUPS) as Array<keyof typeof GROUPS>;

/** The first name in each group, as the group's representative. */
function representative(group: keyof typeof GROUPS) {
  return getFileTypeIcon(GROUPS[group][0]);
}

describe("getFileTypeIcon grouping", () => {
  for (const group of GROUP_NAMES) {
    it(`resolves every ${group} name to one identity`, () => {
      const first = representative(group);
      for (const name of GROUPS[group]) {
        const entry = getFileTypeIcon(name);
        expect(entry.category).toBe(first.category);
        expect(entry.Icon).toBe(first.Icon);
        expect(entry.colorClass).toBe(first.colorClass);
      }
    });
  }

  it("gives every group a distinct category and a distinct glyph", () => {
    const categories = GROUP_NAMES.map((group) => representative(group).category);
    const icons = GROUP_NAMES.map((group) => representative(group).Icon);

    expect(new Set(categories).size).toBe(GROUP_NAMES.length);
    // Shape is the primary signal, so no two categories may share a glyph —
    // hues are allowed to repeat, glyphs are not.
    expect(new Set(icons).size).toBe(GROUP_NAMES.length);
  });

  it("separates unrecognized files from every classified group", () => {
    const unknown = getFileTypeIcon("mystery.qqq");
    expect(unknown.category).toBe("unknown");
    expect(unknown.colorClass).toBe(UNKNOWN_FILE_COLOR_CLASS);

    for (const group of GROUP_NAMES) {
      expect(representative(group).Icon).not.toBe(unknown.Icon);
    }
  });
});

describe("getFileTypeIcon name normalization", () => {
  it("ignores case", () => {
    expect(getFileTypeIcon("Photo.PNG")).toEqual(getFileTypeIcon("photo.png"));
    expect(getFileTypeIcon("MAKEFILE")).toEqual(getFileTypeIcon("Makefile"));
  });

  it("classifies on the basename of a path, either separator", () => {
    const bare = getFileTypeIcon("notes.md");
    expect(getFileTypeIcon("docs/deep/notes.md")).toEqual(bare);
    expect(getFileTypeIcon("docs\\deep\\notes.md")).toEqual(bare);
    // A directory segment must never leak into the decision.
    expect(getFileTypeIcon("images.png/readme.md")).toEqual(getFileTypeIcon("readme.md"));
  });

  it("reads a compound extension by its last segment", () => {
    expect(getFileTypeIcon("release.tar.gz")).toEqual(getFileTypeIcon("release.gz"));
  });

  it("treats a leading dot as part of the name, not an extension", () => {
    // `.env` must not resolve as an `env` extension — it has none.
    expect(getFileTypeIcon(".env").category).not.toBe("unknown");
    expect(getFileTypeIcon(".env")).toEqual(getFileTypeIcon(".env.production"));
  });
});

describe("getFileTypeIcon precedence", () => {
  it("reads a lockfile as a lock, not as its container format", () => {
    const lock = getFileTypeIcon("yarn.lock");
    expect(getFileTypeIcon("package-lock.json")).toEqual(lock);
    expect(getFileTypeIcon("pnpm-lock.yaml")).toEqual(lock);
    expect(getFileTypeIcon("Cargo.lock")).toEqual(lock);
    expect(getFileTypeIcon("go.sum")).toEqual(lock);

    expect(getFileTypeIcon("package-lock.json")).not.toEqual(getFileTypeIcon("data.json"));
    expect(getFileTypeIcon("pnpm-lock.yaml")).not.toEqual(getFileTypeIcon("values.yaml"));
  });

  it("reads a tool config as config, not as its source language", () => {
    const config = getFileTypeIcon("settings.toml");
    expect(getFileTypeIcon("vite.config.ts")).toEqual(config);
    expect(getFileTypeIcon("tsconfig.build.json")).toEqual(config);
    expect(getFileTypeIcon(".prettierrc")).toEqual(config);
    expect(getFileTypeIcon("Dockerfile.dev")).toEqual(config);
    expect(getFileTypeIcon("docker-compose.yml")).toEqual(config);

    expect(getFileTypeIcon("vite.config.ts")).not.toEqual(getFileTypeIcon("index.ts"));
    expect(getFileTypeIcon("tsconfig.build.json")).not.toEqual(getFileTypeIcon("data.json"));
  });

  it("keeps `.ts` on TypeScript rather than MPEG transport stream", () => {
    expect(getFileTypeIcon("player.ts")).toEqual(getFileTypeIcon("player.tsx"));
    expect(getFileTypeIcon("player.ts")).not.toEqual(getFileTypeIcon("player.mp4"));
  });
});

describe("getFileTypeIcon coverage", () => {
  it("classifies every extension the file viewer knows a language for", () => {
    // Sourced from LANGUAGE_MAP rather than restated, so a language added there
    // and forgotten here fails instead of silently rendering a blank file icon.
    // Its two extensionless keys are whole basenames; the rest are extensions.
    const EXTENSIONLESS = new Set(["dockerfile", "makefile"]);
    const unresolved = Object.keys(LANGUAGE_MAP).filter((key) => {
      const name = EXTENSIONLESS.has(key) ? key : `sample.${key}`;
      return getFileTypeIcon(name).category === "unknown";
    });
    expect(unresolved).toEqual([]);
  });
});

describe("getFileTypeIcon palette", () => {
  const ALLOWED = new Set(WORKTREE_COLOR_PALETTE.map((token) => `text-${token}`));
  const ALL_NAMES = [...Object.values(GROUPS).flat(), "mystery.qqq", "yarn.lock", "vite.config.ts"];

  it("draws every classified hue from the CVD-proven palette", () => {
    for (const name of ALL_NAMES) {
      const { category, colorClass } = getFileTypeIcon(name);
      if (category === "unknown") continue;
      expect(ALLOWED.has(colorClass), `${name} -> ${colorClass}`).toBe(true);
    }
  });

  it("keeps the unknown fallback outside the categorical palette", () => {
    expect(ALLOWED.has(getFileTypeIcon("mystery.qqq").colorClass)).toBe(false);
  });

  it("never reaches for the accent, a status hue, or an alpha suffix", () => {
    for (const name of ALL_NAMES) {
      const { colorClass } = getFileTypeIcon(name);
      // Accent restraint: one load-bearing accent signal per focus region, and
      // a tree tinting dozens of rows is not it.
      expect(colorClass).not.toMatch(/accent/);
      expect(colorClass).not.toMatch(/status-/);
      // The `/30`-`/40` alpha is the "near invisible" bug this issue fixed.
      expect(colorClass).not.toMatch(/\//);
    }
  });
});

describe("getFileTypeIcon components", () => {
  it("returns icons that paint from currentColor so one class can tint them", () => {
    for (const name of Object.values(GROUPS).flat()) {
      const markup = renderToStaticMarkup(createElement(getFileTypeIcon(name).Icon));
      expect(markup.startsWith("<svg")).toBe(true);
      expect(markup).toContain("currentColor");
    }
  });
});
