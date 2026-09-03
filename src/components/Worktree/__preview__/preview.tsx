import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { DiffChangeStepper } from "@/components/FileViewer/DiffChangeStepper";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RenderedMarkdownDiff } from "../RenderedMarkdownDiff";
import { FIXTURES, patchFrom, type MarkdownDiffFixture } from "./markdownDiffFixtures";
import "@/index.css";

// Runs after every static import above, which is fine: nothing here touches the
// bridge at module scope. See the sibling shim's own note.
installPreviewShims();

/**
 * Standalone visual-review harness for the diff panel's **Rendered** layout.
 *
 * Reaching this surface in the real app means opening a project, editing a
 * tracked Markdown file, opening its diff and switching the layout segment —
 * and then you get whatever that one edit happened to look like. The states
 * that decide the design (a paragraph rewritten around its surviving clauses, a
 * changed table cell, an unpaired insertion, two changes separated by a screen
 * and a half of untouched prose) are not states you can ask for.
 *
 * So this renders the real `RenderedMarkdownDiff` against the real theme tokens
 * and the real `index.css`, from fixtures that name each case. Everything below
 * the component is the product's; the page around it is a stand-in for the diff
 * panel's scroll body, which is all the component ever sees.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=prose-rewrite    which case to render
 *   ?width=900                body width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "prose-rewrite";
const width = Number(params.get("width") ?? "900");

function requireFixture(name: string): MarkdownDiffFixture {
  const found = FIXTURES[name];
  if (!found) {
    throw new Error(`unknown fixture "${name}" — one of ${Object.keys(FIXTURES).join(", ")}`);
  }
  return found;
}

const fixture = requireFixture(fixtureName);

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const diff = patchFrom(fixture.old, fixture.new);

/**
 * The diff panel's toolbar row and scroll body, reduced to what this surface
 * touches: the change stepper (the real component, so a review of it is a review
 * of what ships) and the scroll root the stepper scrolls.
 */
function Preview() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);

  const step = useCallback(
    (delta: number) => {
      if (count === 0) return;
      const next = (index + delta + count) % count;
      setIndex(next);
      scrollRef.current
        ?.querySelector(`[data-change-index="${next}"]`)
        ?.scrollIntoView({ block: "center" });
    },
    [count, index]
  );

  const onChangeCount = useCallback((next: number) => {
    setCount(next);
    setIndex(0);
  }, []);

  // Mirrors `DiffPane`'s scroll sync so the harness shows the counter the app
  // actually shows. Kept deliberately short here; the host owns the real one.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || count === 0) return;
    const sync = () => {
      const rootBox = root.getBoundingClientRect();
      let best: number | null = null;
      let bestDistance = Infinity;
      for (const element of root.querySelectorAll("[data-change-index]")) {
        const box = element.getBoundingClientRect();
        const distance = Math.abs(box.top - rootBox.top + box.height / 2 - root.clientHeight / 2);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = Number(element.getAttribute("data-change-index"));
        }
      }
      if (best !== null) setIndex(best);
    };
    root.addEventListener("scroll", sync, { passive: true });
    sync();
    return () => root.removeEventListener("scroll", sync);
  }, [count]);

  return (
    <TooltipProvider>
      <div
        data-preview-shell
        className="flex flex-col bg-surface-canvas"
        style={{ width: `${width}px`, height: "100vh" }}
      >
        <FileViewerToolbar.Root label="Diff viewer controls">
          <DiffChangeStepper count={count} index={index} onStep={step} />
          <FileViewerToolbar.Path
            path="videos/final/teleprompter.md"
            copied={false}
            onCopy={() => {}}
          />
        </FileViewerToolbar.Root>
        <div
          ref={scrollRef}
          data-preview-body
          className="diff-scroll-root flex-1 min-h-0 overflow-auto"
        >
          <RenderedMarkdownDiff
            diff={diff}
            newSource={fixture.new}
            status="modified"
            filePath="/tmp/preview/doc.md"
            rootPath="/tmp/preview"
            attemptKey="preview"
            onChangeCount={onChangeCount}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

const host = document.getElementById("root");
if (!host) throw new Error("preview root missing");
createRoot(host).render(
  <StrictMode>
    <Preview />
  </StrictMode>
);
