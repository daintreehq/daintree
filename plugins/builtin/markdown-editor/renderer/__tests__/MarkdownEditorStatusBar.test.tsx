// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { MarkdownEditorStatusBar } from "../MarkdownEditorStatusBar";
import { FILE_METADATA_STRIP_CLASS } from "@/components/FileViewer/fileMetadataStrip";

const BASE = {
  lineCount: 117,
  byteLength: 12_392,
  hasBom: false,
  eolLabel: "LF",
  mixedEol: false,
  dirty: false,
  saving: false,
  saveBlocked: false,
  onSave: () => {},
};

const strip = () => screen.getByTestId("markdown-editor-status");
const saveButton = () => screen.getByTestId("markdown-editor-save") as HTMLButtonElement;

const repoRoot = path.resolve(__dirname, "../../../../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

afterEach(cleanup);

describe("MarkdownEditorStatusBar", () => {
  it("carries the shared strip geometry rather than its own", () => {
    // The rule, not the value: whatever the shared geometry becomes, the strip
    // renders exactly it, so Source and Edit modes cannot drift to different
    // heights and shift the document under the cursor on a mode toggle.
    render(<MarkdownEditorStatusBar {...BASE} />);
    expect(strip().className).toBe(FILE_METADATA_STRIP_CLASS);
  });

  it("the read-mode twin carries the same shared geometry", () => {
    // FilePane is far too large to mount here, so this asserts the structural
    // fact instead: it takes its class from the shared constant and holds no
    // second copy of the geometry.
    const source = read("src/panels/file/FilePane.tsx");
    expect(source).toMatch(
      /data-testid="file-viewer-metadata"[\s\S]{0,80}FILE_METADATA_STRIP_CLASS/
    );
  });

  it("keeps the save button focusable across the write", () => {
    // `loading` blocks activation through ARIA precisely so focus survives the
    // save. A native `disabled` would drop a keyboard user out of the strip the
    // moment they pressed the button, so saving must never set it.
    render(<MarkdownEditorStatusBar {...BASE} dirty saving />);
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    expect(saveButton().getAttribute("aria-busy")).toBe("true");
  });

  it("refuses the save when there is nothing to write or a conflict holds it", () => {
    const { rerender } = render(<MarkdownEditorStatusBar {...BASE} />);
    expect(saveButton().disabled).toBe(true);
    rerender(<MarkdownEditorStatusBar {...BASE} dirty saveBlocked />);
    expect(saveButton().disabled).toBe(true);
    rerender(<MarkdownEditorStatusBar {...BASE} dirty />);
    expect(saveButton().disabled).toBe(false);
  });

  it("declares no live region — the controller owns terminal announcements", () => {
    // A second live region here would double every announcement the controller
    // already makes AND fire on the first keystroke of every edit, which is the
    // documented way to make a status bar exhausting to listen to.
    render(<MarkdownEditorStatusBar {...BASE} dirty />);
    expect(strip().querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(strip().querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(0);
  });

  it("gives the draft state more weight than the bytes it describes", () => {
    // The rule: whatever the palette, the answer to "are my edits safe?" is
    // never rendered at or below the emphasis of the reference metadata.
    const { rerender } = render(<MarkdownEditorStatusBar {...BASE} dirty />);
    expect(screen.getByTestId("markdown-editor-dirty-state").className).toContain(
      "text-text-primary"
    );
    expect(strip().className).toContain("text-text-secondary");
    rerender(<MarkdownEditorStatusBar {...BASE} saving dirty />);
    expect(screen.getByTestId("markdown-editor-dirty-state").className).toContain(
      "text-text-primary"
    );
  });

  it("lets the state and the action keep their width while the metadata yields", () => {
    // Under pressure a truncated byte count is worth less than a legible answer
    // to "are my edits safe?" — so the run that truncates is the metadata one.
    render(<MarkdownEditorStatusBar {...BASE} dirty />);
    const metadata = strip().firstElementChild as HTMLElement;
    expect(metadata.className).toContain("min-w-0");
    expect(metadata.className).toContain("truncate");
    const actions = strip().lastElementChild as HTMLElement;
    expect(actions.className).toContain("shrink-0");
    expect(actions.className).toContain("whitespace-nowrap");
  });

  it("states the destination of the line-ending conversion, and never truncates it away", () => {
    render(<MarkdownEditorStatusBar {...BASE} mixedEol eolLabel="CRLF" />);
    const warning = screen.getByTestId("markdown-editor-mixed-eol");
    // The destination is the actionable half — a warning that says only
    // "mixed line endings" tells the user nothing about what saving will do.
    expect(warning.textContent).toContain("CRLF");
    expect(warning.getAttribute("title")).toContain("CRLF");
    expect(warning.className).toContain("shrink-0");
    expect(warning.className).toContain("whitespace-nowrap");
  });

  it("renders no mono face — mono is carried by the numerics as tabular figures", () => {
    render(<MarkdownEditorStatusBar {...BASE} />);
    expect(strip().className).not.toContain("font-mono");
    expect(strip().querySelector(".tabular-nums")).not.toBeNull();
  });

  it("uses no legacy shadcn colour alias in either strip", () => {
    // The house rule is that these names only ever shrink. Both halves of this
    // pair used to carry `text-muted-foreground`; neither may regain it.
    for (const file of [
      "plugins/builtin/markdown-editor/renderer/MarkdownEditorStatusBar.tsx",
      "src/components/FileViewer/fileMetadataStrip.ts",
    ]) {
      expect(read(file)).not.toContain("muted-foreground");
    }
  });
});
