// @vitest-environment jsdom
import React from "react";
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { HunkData } from "react-diff-view";
import { DiffViewer, FULL_FILE_MAX_LINES, _resetLangStateForTests } from "../DiffViewer";
import type { FullFileUnavailableReason } from "../DiffViewer";
import { TooltipProvider } from "@/components/ui/tooltip";

const { capturedDiffProps } = vi.hoisted(() => ({
  capturedDiffProps: {} as { hunks?: HunkData[] },
}));

vi.mock("react-diff-view", async () => {
  const actual = await vi.importActual<typeof import("react-diff-view")>("react-diff-view");
  return {
    ...actual,
    Diff: (props: { children: (hunks: unknown[]) => React.ReactNode; hunks: HunkData[] }) => {
      capturedDiffProps.hunks = props.hunks;
      return <div data-testid="diff-element">{props.children(props.hunks)}</div>;
    },
    Hunk: () => <div data-testid="hunk" />,
    tokenize: vi.fn(),
    markEdits: vi.fn(() => vi.fn()),
  };
});

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

/**
 * A single-hunk modification of one line, with three lines of context, plus the
 * exact new-side file content it was generated from. Keeping the two in one
 * factory is the point: the source-consistency check only means something if
 * the "good" fixture is genuinely consistent.
 */
function makeFixture(totalLines: number, changedLine: number) {
  const originalLine = (n: number) => `line${n}`;
  const contextStart = changedLine - 3;
  const hunkLines: string[] = [];
  for (let n = contextStart; n < changedLine; n++) hunkLines.push(` ${originalLine(n)}`);
  hunkLines.push(`-${originalLine(changedLine)}`);
  hunkLines.push(`+CHANGED`);
  for (let n = changedLine + 1; n <= changedLine + 3; n++) hunkLines.push(` ${originalLine(n)}`);

  const diff = [
    "diff --git a/f.ts b/f.ts",
    "index 1111111..2222222 100644",
    "--- a/f.ts",
    "+++ b/f.ts",
    `@@ -${contextStart},7 +${contextStart},7 @@`,
    ...hunkLines,
  ].join("\n");

  const source = Array.from({ length: totalLines }, (_, i) =>
    i + 1 === changedLine ? "CHANGED" : originalLine(i + 1)
  ).join("\n");

  return { diff, source };
}

/** Every line of content the viewer handed to the diff table. */
function renderedContent(): string[] {
  const lines: string[] = [];
  for (const hunk of capturedDiffProps.hunks ?? []) {
    for (const change of hunk.changes) lines.push(change.content);
  }
  return lines;
}

function renderViewer(props: Partial<React.ComponentProps<typeof DiffViewer>> & { diff: string }) {
  return render(
    <TooltipProvider>
      <DiffViewer {...props} />
    </TooltipProvider>
  );
}

beforeEach(() => {
  capturedDiffProps.hunks = undefined;
  _resetLangStateForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("DiffViewer full file scope", () => {
  it("renders only the changed region and its context when scope is off", () => {
    const { diff, source } = makeFixture(12, 5);
    renderViewer({ diff, source, fullFile: false });

    const content = renderedContent();
    // The first and last lines of the file sit outside the hunk's context.
    expect(content).not.toContain("line1");
    expect(content).not.toContain("line12");
    expect(content).toContain("CHANGED");
  });

  it("renders every line of the file when scope is on", () => {
    const { diff, source } = makeFixture(12, 5);
    renderViewer({ diff, source, fullFile: true });

    const content = renderedContent();
    expect(content).toContain("line1");
    expect(content).toContain("line12");
    expect(content).toContain("CHANGED");
  });

  it("covers the file end to end without gaps once expanded", () => {
    const totalLines = 12;
    const { diff, source } = makeFixture(totalLines, 5);
    renderViewer({ diff, source, fullFile: true });

    const hunks = capturedDiffProps.hunks ?? [];
    const first = hunks.at(0);
    const last = hunks.at(-1);
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (!first || !last) return;
    expect(first.oldStart).toBe(1);
    // Old and new sides are the same length here (one line replaced one line),
    // so full coverage means the last hunk reaches the final line.
    expect(last.oldStart + last.oldLines - 1).toBe(totalLines);
  });

  it("restores the unexpanded view when scope is switched back off", () => {
    const { diff, source } = makeFixture(12, 5);
    const { rerender } = renderViewer({ diff, source, fullFile: true });
    expect(renderedContent()).toContain("line1");

    rerender(
      <TooltipProvider>
        <DiffViewer diff={diff} source={source} fullFile={false} />
      </TooltipProvider>
    );
    expect(renderedContent()).not.toContain("line1");
  });

  it("refuses to expand against a source that isn't the diff's new side", () => {
    const { diff } = makeFixture(12, 5);
    // Same shape, different content — exactly what a file edited between the
    // diff and the source read looks like.
    const drifted = Array.from({ length: 12 }, (_, i) => `unrelated${i + 1}`).join("\n");
    const onVerdict =
      vi.fn<
        (reason: FullFileUnavailableReason | null, forSource: string | null | undefined) => void
      >();

    renderViewer({ diff, source: drifted, fullFile: true, onFullFileVerdict: onVerdict });

    const content = renderedContent();
    // None of the drifted file's lines may leak in as context.
    expect(content.some((line) => line.startsWith("unrelated"))).toBe(false);
    expect(content).toContain("CHANGED");
    expect(onVerdict).toHaveBeenCalledWith("source-mismatch", expect.any(String));
  });

  it("reports a truncated source as a mismatch rather than expanding past its end", () => {
    const { diff } = makeFixture(12, 5);
    const truncated = ["line1", "line2", "line3"].join("\n");
    const onVerdict =
      vi.fn<
        (reason: FullFileUnavailableReason | null, forSource: string | null | undefined) => void
      >();

    renderViewer({ diff, source: truncated, fullFile: true, onFullFileVerdict: onVerdict });

    expect(onVerdict).toHaveBeenCalledWith("source-mismatch", expect.any(String));
  });

  it("falls back rather than committing more rows than the table can carry", () => {
    const totalLines = FULL_FILE_MAX_LINES + 1;
    const { diff, source } = makeFixture(totalLines, 100);
    const onVerdict =
      vi.fn<
        (reason: FullFileUnavailableReason | null, forSource: string | null | undefined) => void
      >();

    renderViewer({ diff, source, fullFile: true, onFullFileVerdict: onVerdict });

    expect(onVerdict).toHaveBeenCalledWith("too-large", expect.any(String));
    // The diff itself still renders — the fallback is to changed lines, never
    // to an empty pane.
    expect(renderedContent()).toContain("CHANGED");
  });

  it("expands a file sitting exactly on the row ceiling", () => {
    const { diff, source } = makeFixture(FULL_FILE_MAX_LINES, 100);
    const onVerdict =
      vi.fn<
        (reason: FullFileUnavailableReason | null, forSource: string | null | undefined) => void
      >();

    renderViewer({ diff, source, fullFile: true, onFullFileVerdict: onVerdict });

    expect(onVerdict).toHaveBeenLastCalledWith(null, expect.any(String));
    expect(renderedContent()).toContain("line1");
  });

  it("stays on the plain diff when no source is supplied", () => {
    const { diff } = makeFixture(12, 5);
    const onVerdict =
      vi.fn<
        (reason: FullFileUnavailableReason | null, forSource: string | null | undefined) => void
      >();

    renderViewer({ diff, fullFile: true, onFullFileVerdict: onVerdict });

    expect(renderedContent()).not.toContain("line1");
    // No source is a pending read, not a refusal — there's nothing to explain.
    expect(onVerdict).toHaveBeenLastCalledWith(null, undefined);
  });

  // Files on disk almost always end in a newline; a fixture built by joining
  // lines does not. The difference is invisible until it renders.
  it("doesn't invent a trailing blank line for a file that ends in a newline", () => {
    const totalLines = 12;
    const { diff, source } = makeFixture(totalLines, 5);
    renderViewer({ diff, source: `${source}\n`, fullFile: true });

    const content = renderedContent();
    expect(content).toContain("line12");
    expect(content[content.length - 1]).toBe("line12");
    expect(content.length).toBe(totalLines + 1); // +1 for the replaced line's delete row
  });

  it("counts lines for the size ceiling without the trailing newline's empty split", () => {
    // Exactly at the ceiling once the trailing newline is discounted — a naive
    // split would read this as one line over and refuse to expand.
    const { diff, source } = makeFixture(FULL_FILE_MAX_LINES, 100);
    const onVerdict =
      vi.fn<
        (reason: FullFileUnavailableReason | null, forSource: string | null | undefined) => void
      >();

    renderViewer({
      diff,
      source: `${source}\n`,
      fullFile: true,
      onFullFileVerdict: onVerdict,
    });

    expect(onVerdict).toHaveBeenLastCalledWith(null, expect.any(String));
  });

  it("tolerates a CRLF checkout, where disk lines carry a return the diff doesn't", () => {
    const { diff, source } = makeFixture(12, 5);
    const crlf = source.split("\n").join("\r\n");
    const onVerdict =
      vi.fn<(reason: FullFileUnavailableReason | null, forSource: unknown) => void>();

    renderViewer({ diff, source: crlf, fullFile: true, onFullFileVerdict: onVerdict });

    expect(onVerdict).toHaveBeenLastCalledWith(null, expect.any(String));
    expect(renderedContent()).toContain("line1");
  });

  it("measures the ceiling against the larger side, not just the old one", () => {
    // A big insertion leaves the old side small while the new side — which is
    // rendered too — blows past the ceiling.
    const oldLines = 10;
    const inserted = FULL_FILE_MAX_LINES + 1 - oldLines;
    const body = [
      " line1",
      ...Array.from({ length: inserted }, (_, i) => `+new${i + 1}`),
      " line2",
    ];
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "index 1111111..2222222 100644",
      "--- a/f.ts",
      "+++ b/f.ts",
      `@@ -1,2 +1,${inserted + 2} @@`,
      ...body,
    ].join("\n");
    const source = [
      "line1",
      ...Array.from({ length: inserted }, (_, i) => `new${i + 1}`),
      "line2",
      ...Array.from({ length: oldLines - 2 }, (_, i) => `tail${i + 1}`),
    ].join("\n");
    const onVerdict =
      vi.fn<(reason: FullFileUnavailableReason | null, forSource: unknown) => void>();

    renderViewer({ diff, source, fullFile: true, onFullFileVerdict: onVerdict });

    expect(onVerdict).toHaveBeenCalledWith("too-large", expect.any(String));
  });

  it("calls a hunkless diff unsupported rather than claiming the file changed", () => {
    // A pure rename carries no hunks; reporting a mismatch would tell the user
    // their file changed when nothing did.
    const renameDiff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
    ].join("\n");
    const onVerdict =
      vi.fn<(reason: FullFileUnavailableReason | null, forSource: unknown) => void>();

    renderViewer({
      diff: renameDiff,
      source: "line1\nline2\n",
      fullFile: true,
      onFullFileVerdict: onVerdict,
    });

    expect(onVerdict).toHaveBeenLastCalledWith("unsupported", expect.any(String));
  });

  it("clears a fallback verdict once a refreshed diff makes the same source usable", () => {
    // A host that only heard about failures would keep the explanation up while
    // the file below it silently rendered fully expanded.
    const { diff, source } = makeFixture(12, 5);
    const staleDiff = makeFixture(12, 9).diff;
    const onVerdict =
      vi.fn<(reason: FullFileUnavailableReason | null, forSource: unknown) => void>();

    const { rerender } = render(
      <TooltipProvider>
        <DiffViewer diff={staleDiff} source={source} fullFile onFullFileVerdict={onVerdict} />
      </TooltipProvider>
    );
    expect(onVerdict).toHaveBeenLastCalledWith("source-mismatch", source);

    // The diff is refreshed and now matches, while the source string is
    // unchanged — so the verdict, not the source, is what has to move.
    rerender(
      <TooltipProvider>
        <DiffViewer diff={diff} source={source} fullFile onFullFileVerdict={onVerdict} />
      </TooltipProvider>
    );
    expect(onVerdict).toHaveBeenLastCalledWith(null, source);
  });

  it("reports the reason against the source it judged, so a host can tell verdicts apart", () => {
    const { diff } = makeFixture(12, 5);
    const drifted = Array.from({ length: 12 }, (_, i) => `unrelated${i + 1}`).join("\n");
    const onVerdict =
      vi.fn<(reason: FullFileUnavailableReason | null, forSource: unknown) => void>();

    renderViewer({ diff, source: drifted, fullFile: true, onFullFileVerdict: onVerdict });

    expect(onVerdict).toHaveBeenLastCalledWith("source-mismatch", drifted);
  });

  it("notifies once when the scope changes the rendered rows, and not on mount", () => {
    const { diff, source } = makeFixture(12, 5);
    const onToggleCollapse = vi.fn();
    const { rerender } = render(
      <TooltipProvider>
        <DiffViewer
          diff={diff}
          source={source}
          fullFile={false}
          onToggleCollapse={onToggleCollapse}
        />
      </TooltipProvider>
    );
    expect(onToggleCollapse).not.toHaveBeenCalled();

    rerender(
      <TooltipProvider>
        <DiffViewer diff={diff} source={source} fullFile onToggleCollapse={onToggleCollapse} />
      </TooltipProvider>
    );
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it("notifies when a late-arriving source expands the rows", () => {
    const { diff, source } = makeFixture(12, 5);
    const onToggleCollapse = vi.fn();
    // Scope is on before the read resolves — the common ordering, since the
    // diff renders first and the file content follows.
    const { rerender } = render(
      <TooltipProvider>
        <DiffViewer diff={diff} fullFile onToggleCollapse={onToggleCollapse} />
      </TooltipProvider>
    );
    expect(onToggleCollapse).not.toHaveBeenCalled();

    rerender(
      <TooltipProvider>
        <DiffViewer diff={diff} source={source} fullFile onToggleCollapse={onToggleCollapse} />
      </TooltipProvider>
    );
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it("discards expanded context when the source is replaced", async () => {
    const { diff, source } = makeFixture(12, 5);
    const { rerender } = renderViewer({ diff, source, fullFile: true });
    expect(renderedContent()).toContain("line1");

    const drifted = Array.from({ length: 12 }, (_, i) => `unrelated${i + 1}`).join("\n");
    await act(async () => {
      rerender(
        <TooltipProvider>
          <DiffViewer diff={diff} source={drifted} fullFile />
        </TooltipProvider>
      );
    });

    const content = renderedContent();
    expect(content).not.toContain("line1");
    expect(content.some((line) => line.startsWith("unrelated"))).toBe(false);
  });
});
