import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Busy, placeholder and failure states are one family each. A hand-rolled
 * spinner drifts in size, colour and reduced-motion handling; a pane that
 * frames its own load error or placeholder drifts in scale and copy. The audit
 * behind these found raw `Loader2` spinners in six places, "Reconnecting…"
 * drawn three ways and the browser and dev preview panes wording the same
 * states differently.
 *
 * The allowlist names survivors another family owns; an entry that stops
 * matching fails, so the list can only shrink.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const SRC = path.join(REPO_ROOT, "src");

/** `Spinner` is the primitive that wraps the glyph. */
const LOADER_PRIMITIVE = "src/components/ui/Spinner.tsx";

const LOADER_SURVIVORS: Record<string, string> = {
  // The install button's busy glyph belongs to the button-states family.
  "src/components/Setup/AgentCliStep.tsx": "install button busy state (button states family)",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__preview__") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function rel(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

const FILES = sourceFiles(SRC).map((file) => ({
  file: rel(file),
  source: fs.readFileSync(file, "utf-8"),
}));

describe("pane and inline busy states", () => {
  it("renders the spinning loader glyph only through Spinner", () => {
    const offenders = FILES.filter(
      ({ file, source }) =>
        file !== LOADER_PRIMITIVE && !(file in LOADER_SURVIVORS) && /<Loader2\b/.test(source)
    ).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("keeps every loader survivor live", () => {
    const stale = Object.keys(LOADER_SURVIVORS).filter((file) => {
      const hit = FILES.find((f) => f.file === file);
      return !hit || !/<Loader2\b/.test(hit.source);
    });
    expect(stale).toEqual([]);
  });

  it("never spells an ellipsis as three dots in a busy caption", () => {
    const offenders = FILES.flatMap(({ file, source }) =>
      [...source.matchAll(/>\s*(?:Reconnecting|Loading|Checking|Starting)[^<]*\.\.\.\s*</g)].map(
        (m) => `${file}: ${m[0].trim()}`
      )
    );
    expect(offenders).toEqual([]);
  });

  it("frames the browser and dev preview placeholders and load errors with the shared pane states", () => {
    for (const file of [
      "src/components/Browser/BrowserPaneStates.tsx",
      "src/components/DevPreview/DevPreviewEmptyStates.tsx",
    ]) {
      const source = FILES.find((f) => f.file === file)?.source ?? "";
      // Not yet viewed, and evicted.
      expect(source.match(/<PanePlaceholder>/g)?.length ?? 0, file).toBe(2);
      expect(source, file).toMatch(/<PaneState\b[\s\S]*?live="alert"/);
    }
    const overlays =
      FILES.find((f) => f.file === "src/components/DevPreview/DevPreviewWebviewOverlays.tsx")
        ?.source ?? "";
    expect(overlays).toMatch(/<PaneState\b[\s\S]*?live="alert"/);
  });
});
