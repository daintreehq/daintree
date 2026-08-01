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
  config: ["settings.toml", "values.yaml", "Makefile"],
  lock: ["yarn.lock", "Cargo.lock", "poetry.lock"],
} as const;

/**
 * A name no table can claim, so its result IS the fallback. Comparing against
 * this rather than the string "unknown" keeps the tests from going quiet if the
 * category is ever renamed.
 */
const FALLBACK = getFileTypeIcon("mystery.qqq");

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
    expect(FALLBACK.colorClass).toBe(UNKNOWN_FILE_COLOR_CLASS);

    for (const group of GROUP_NAMES) {
      expect(representative(group).Icon).not.toBe(FALLBACK.Icon);
      expect(representative(group).category).not.toBe(FALLBACK.category);
    }
  });

  it("falls back rather than throwing on degenerate names", () => {
    // Nothing here can match a table, so every one must land on the fallback
    // instead of resolving to a partial or undefined result.
    for (const name of ["", ".", "...", "foo.", "  ", "a".repeat(300), `x.${"y".repeat(300)}`]) {
      expect(getFileTypeIcon(name)).toEqual(FALLBACK);
    }
  });

  it("does not mistake inherited object members for classifications", () => {
    // The lookup tables are plain objects, so a file actually named
    // `constructor` would read Object.prototype without an own-key guard and
    // hand back undefined — which the tree then paints as a folder.
    for (const name of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "file.constructor",
      "file.__proto__",
      "file.toString",
    ]) {
      const resolved = getFileTypeIcon(name);
      expect(resolved).toBeDefined();
      expect(resolved).toEqual(FALLBACK);
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

  it("lets a strong extension outrank a `.config.` infix", () => {
    // `.config.` is common enough inside ordinary names that an open suffix
    // would swallow media and executables whose own extension says more.
    expect(getFileTypeIcon("photo.config.png")).toEqual(getFileTypeIcon("photo.png"));
    expect(getFileTypeIcon("payload.config.exe")).toEqual(getFileTypeIcon("payload.exe"));
    // ...while a real config carrier still wins over its own format.
    expect(getFileTypeIcon("vite.config.ts")).not.toEqual(getFileTypeIcon("vite.ts"));
  });

  it("reads Terraform's dependency lock as a lock, not as HCL config", () => {
    expect(getFileTypeIcon(".terraform.lock.hcl")).toEqual(getFileTypeIcon("yarn.lock"));
    expect(getFileTypeIcon(".terraform.lock.hcl")).not.toEqual(getFileTypeIcon("main.hcl"));
  });

  it("reads the Gradle wrapper launchers as scripts", () => {
    const script = getFileTypeIcon("deploy.sh");
    expect(getFileTypeIcon("gradlew")).toEqual(script);
    // `.bat` already resolves as a script, so this must not be overridden back
    // to config the way an exact entry once did.
    expect(getFileTypeIcon("gradlew.bat")).toEqual(script);
  });
});

describe("getFileTypeIcon coverage", () => {
  it("classifies every extension the file viewer knows a language for", () => {
    // Sourced from LANGUAGE_MAP rather than restated, so a language added there
    // and forgotten here fails instead of silently rendering a blank file icon.
    const keys = Object.keys(LANGUAGE_MAP);
    // Without this the filter below would pass on an empty map.
    expect(keys.length).toBeGreaterThan(0);

    // Most keys are extensions, a couple (Dockerfile, Makefile) are whole
    // basenames. Accept either reading rather than hardcoding which is which.
    const unresolved = keys.filter(
      (key) =>
        getFileTypeIcon(`sample.${key}`).category === FALLBACK.category &&
        getFileTypeIcon(key).category === FALLBACK.category
    );
    expect(unresolved).toEqual([]);
  });
});

describe("getFileTypeIcon palette", () => {
  const ALLOWED = new Set(WORKTREE_COLOR_PALETTE.map((token) => `text-${token}`));
  const ALL_NAMES = [...Object.values(GROUPS).flat(), "mystery.qqq", "yarn.lock", "vite.config.ts"];

  it("draws every classified hue from the CVD-proven palette", () => {
    for (const name of ALL_NAMES) {
      const { category, colorClass } = getFileTypeIcon(name);
      if (category === FALLBACK.category) continue;
      expect(ALLOWED.has(colorClass), `${name} -> ${colorClass}`).toBe(true);
    }
  });

  it("keeps the unknown fallback outside the categorical palette", () => {
    expect(ALLOWED.has(FALLBACK.colorClass)).toBe(false);
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
  const REPRESENTATIVES = [...GROUP_NAMES.map((group) => GROUPS[group][0]), "mystery.qqq"];

  it("returns icons that paint from currentColor so one class can tint them", () => {
    for (const name of REPRESENTATIVES) {
      const markup = renderToStaticMarkup(createElement(getFileTypeIcon(name).Icon));
      expect(markup.startsWith("<svg")).toBe(true);
      expect(markup).toContain("currentColor");
    }
  });

  it("draws a visibly different glyph for every category", () => {
    // Component identity is checked above; this compares what actually paints,
    // so two distinct exports that happen to render the same art still fail.
    const drawn = REPRESENTATIVES.map((name) =>
      renderToStaticMarkup(createElement(getFileTypeIcon(name).Icon))
    );
    expect(new Set(drawn).size).toBe(REPRESENTATIVES.length);
  });
});
