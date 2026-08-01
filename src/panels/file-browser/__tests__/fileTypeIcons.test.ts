import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemes";
import { contrastRatio } from "@shared/theme/contrast";
import { LANGUAGE_MAP } from "@/components/FileViewer/languageUtils";
import { FILE_TREE_ICON_COLOR_CLASS, getFileTypeIcon } from "../fileTypeIcons";

// These tests assert relationships — "these names agree", "this name outranks
// that one", "every category draws a different glyph" — rather than echoing the
// table back. Copying `png -> image` here would just restate the source and
// would have to be edited in lockstep with it, which proves nothing.

/**
 * Members of each group must agree with each other and differ from the others.
 *
 * A list rather than a keyed object so the group labels stay plain data — the
 * labels are only there to name the test cases, and are deliberately NOT
 * asserted against the resolver's own category names.
 */
const GROUPS = [
  { label: "image", samples: ["logo.png", "shot.JPEG", "icon.svg", "still.webp"] },
  { label: "video", samples: ["clip.mp4", "reel.MOV", "capture.mkv"] },
  { label: "audio", samples: ["track.mp3", "voice.wav", "sting.flac"] },
  { label: "archive", samples: ["bundle.zip", "release.tar.gz", "lib.jar"] },
  { label: "source", samples: ["main.ts", "app.tsx", "server.py", "lib.rs"] },
  { label: "script", samples: ["deploy.sh", "setup.bash", "build.ps1"] },
  { label: "data", samples: ["index.json", "records.jsonl", "shape.geojson"] },
  { label: "document", samples: ["notes.md", "manual.pdf", "LICENSE"] },
  { label: "spreadsheet", samples: ["rows.csv", "budget.xlsx"] },
  { label: "database", samples: ["schema.sql", "cache.sqlite3"] },
  { label: "font", samples: ["Inter.woff2", "mono.ttf"] },
  { label: "key", samples: ["server.pem", "client.p12"] },
  { label: "binary", samples: ["app.exe", "core.dylib", "mod.wasm"] },
  { label: "config", samples: ["settings.toml", "values.yaml", "Makefile"] },
  { label: "lock", samples: ["yarn.lock", "Cargo.lock", "poetry.lock"] },
] as const;

/**
 * A name no table can claim, so its result IS the fallback. Comparing against
 * this rather than the string "unknown" keeps the tests from going quiet if the
 * category is ever renamed.
 */
const FALLBACK = getFileTypeIcon("mystery.qqq");

/** The first name in each group, as the group's representative. */
function representative(group: (typeof GROUPS)[number]) {
  return getFileTypeIcon(group.samples[0]);
}

describe("getFileTypeIcon grouping", () => {
  for (const group of GROUPS) {
    it(`resolves every ${group.label} name to one identity`, () => {
      const first = representative(group);
      for (const name of group.samples) {
        const entry = getFileTypeIcon(name);
        expect(entry.category).toBe(first.category);
        expect(entry.Icon).toBe(first.Icon);
      }
    });
  }

  it("gives every group a distinct category and a distinct glyph", () => {
    const categories = GROUPS.map((group) => representative(group).category);
    const icons = GROUPS.map((group) => representative(group).Icon);

    expect(new Set(categories).size).toBe(GROUPS.length);
    // Shape is the only signal now that color is gone, so two categories
    // sharing a glyph would erase one of them rather than merely blur it.
    expect(new Set(icons).size).toBe(GROUPS.length);
  });

  it("separates unrecognized files from every classified group", () => {
    for (const group of GROUPS) {
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
    expect(getFileTypeIcon(".env").category).not.toBe(FALLBACK.category);
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

describe("getFileTypeIcon carries no color", () => {
  const ALL_NAMES = [
    ...GROUPS.flatMap((group) => [...group.samples]),
    "mystery.qqq",
    "vite.config.ts",
  ];

  it("hands back no color of any kind", () => {
    // The resolver used to return a per-category `colorClass`, which made the
    // tree a fourth consumer of the eight `category-*` hues already spoken for
    // by worktree identity, agent state and action categories. Scanning the
    // values for a color-shaped utility rather than pinning the key set: a new
    // non-color field is fine and should not fail here, a color is the whole
    // point of the guard.
    for (const name of ALL_NAMES) {
      for (const value of Object.values(getFileTypeIcon(name))) {
        if (typeof value !== "string") continue;
        expect(value, `${name} -> ${value}`).not.toMatch(/^(text|bg|border|fill|stroke)-/);
      }
    }
  });

  it("paints every row from one exported neutral", () => {
    // The single class both list views apply. Asserting it is not a category
    // hue, an accent or a status token is the actual invariant — the token's
    // own value is the source of truth and copying it here would prove
    // nothing.
    expect(FILE_TREE_ICON_COLOR_CLASS).not.toMatch(/category/);
    expect(FILE_TREE_ICON_COLOR_CLASS).not.toMatch(/accent/);
    expect(FILE_TREE_ICON_COLOR_CLASS).not.toMatch(/status-/);
    // The `/30`-`/40` alpha is the "near invisible" bug #11596 fixed.
    expect(FILE_TREE_ICON_COLOR_CLASS).not.toMatch(/\//);
  });

  it("keeps that neutral above the graphical-object floor in every theme", () => {
    // Shape is the only type channel left, so an icon that fades out costs the
    // whole signal rather than half of it. 3:1 is WCAG 1.4.11 for a graphical
    // object.
    //
    // This is the guard that `shared/theme/contrast.ts` does NOT provide: its
    // `text-muted` rows are `appliesTo: "light"`, so dark muted is sanctioned
    // sub-AA (namib ~2.2:1, redwoods ~2.5:1) and picking it here would have
    // reintroduced the pre-#11596 bug on two dark themes with nothing failing.
    // Computed per theme rather than asserting the token's name, so it stays
    // honest if either the token or a palette moves.
    // `text-text-secondary` -> the `secondary` entry of the palette's text
    // ramp. The two guards below are what keep this honest if the constant
    // ever moves off that ramp: an accent or activity hue would not carry the
    // prefix, and a misspelling would not resolve to a color.
    const key = FILE_TREE_ICON_COLOR_CLASS.replace(/^text-text-/, "");
    expect(key, `${FILE_TREE_ICON_COLOR_CLASS} is not a text-ramp token`).not.toBe(
      FILE_TREE_ICON_COLOR_CLASS
    );

    for (const source of BUILT_IN_THEME_SOURCES) {
      const ramp: Record<string, string> = source.palette.text;
      const foreground = ramp[key];
      // Throw rather than expect(): this also narrows the type, and a missing
      // ramp entry is a broken test rather than a failing assertion.
      if (foreground === undefined) throw new Error(`${source.id} has no text.${key}`);

      for (const [name, surface] of Object.entries(source.palette.surfaces)) {
        expect(
          contrastRatio(foreground, surface),
          `${source.id} ${FILE_TREE_ICON_COLOR_CLASS} on ${name}`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("getFileTypeIcon components", () => {
  const REPRESENTATIVES: string[] = [...GROUPS.map((group) => group.samples[0]), "mystery.qqq"];

  it("returns icons that paint from currentColor so one class can tint them", () => {
    for (const name of REPRESENTATIVES) {
      const markup = renderToStaticMarkup(createElement(getFileTypeIcon(name).Icon));
      expect(markup.startsWith("<svg")).toBe(true);
      expect(markup).toContain("currentColor");
    }
  });

  it("draws a visibly different glyph for every category", () => {
    // With color gone the glyph is the only type channel, so this is the whole
    // signal rather than half of it.
    //
    // Compares the painted geometry with the wrapper stripped. Lucide stamps a
    // per-icon `lucide-file-code` class on the <svg>, so comparing whole markup
    // would call any two icons distinct on their names alone — including two
    // exports that draw identical art, which is exactly the collision worth
    // catching.
    const geometry = REPRESENTATIVES.map((name) =>
      renderToStaticMarkup(createElement(getFileTypeIcon(name).Icon)).replace(/^<svg[^>]*>/, "")
    );
    // Non-vacuous: stripping the wrapper must leave the drawing behind.
    for (const [index, drawn] of geometry.entries()) {
      expect(drawn, REPRESENTATIVES[index]).toMatch(/<(path|circle|rect|line|polyline|polygon)/);
    }
    expect(new Set(geometry).size).toBe(REPRESENTATIVES.length);
  });
});
