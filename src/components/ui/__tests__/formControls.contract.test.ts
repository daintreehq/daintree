import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A form control is drawn by its primitive, so a select in a dialog, a textarea
 * in a builder and a switch in a settings row look and focus the same wherever
 * they appear. The audit behind this found native selects in five dialogs —
 * each a 32px box with the OS popup and no focus ring of the app's — a raw
 * textarea beside a `Textarea`, the one small switch in settings, and a key
 * hint hand-painted into two primary buttons. Read from source, because what
 * is guarded is how the controls are written.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../../..");
const REPO = path.resolve(SRC, "..");
// Builtin plugin renderers import the host's primitives through `@/`.
const ROOTS = [SRC, path.join(REPO, "plugins", "builtin")];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "__preview__", "node_modules", "dist"].includes(entry.name)) continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = ROOTS.filter((root) => fs.existsSync(root)).flatMap(sourceFiles);
const rel = (file: string) => path.relative(REPO, file).split(path.sep).join("/");
/** Comments name the elements they replaced; only code counts. */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const source = new Map(
  files.map((file) => [rel(file), stripComments(fs.readFileSync(file, "utf8"))])
);

function filesMatching(pattern: RegExp): string[] {
  return [...source].filter(([, text]) => pattern.test(text)).map(([file]) => file);
}

/** Raw textareas that are editors rather than form fields. */
const RAW_TEXTAREAS: Record<string, string> = {
  "src/components/ui/textarea.tsx": "the primitive",
  // A full-pane scratch editor with its own chrome, not a field on a form.
  "src/components/Terminal/TerminalScratchpad.tsx": "pane editor",
};

describe("form control family", () => {
  it("renders no native <select> — a select is Select/SelectTrigger", () => {
    expect(filesMatching(/<select[\s>]/)).toEqual([]);
  });

  it("renders a raw <textarea> only in the primitive and the listed editors", () => {
    const found = filesMatching(/<textarea[\s>]/).sort();
    expect(found).toEqual(Object.keys(RAW_TEXTAREAS).sort());
  });

  it("reaches the Switch primitive only through SettingsSwitch", () => {
    const importers = filesMatching(/from "@\/components\/ui\/switch"/);
    expect(importers).toEqual(["src/components/Settings/SettingsSwitch.tsx"]);
  });

  it("paints an inverse key chip only inside KbdChord", () => {
    expect(filesMatching(/bg-text-inverse\/15/)).toEqual(["src/components/ui/Kbd.tsx"]);
  });
});
