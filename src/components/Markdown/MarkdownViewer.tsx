import { forwardRef, lazy, Suspense, useImperativeHandle, useRef } from "react";
import type { FileRenderMode } from "@shared/types/panel";
import { CodeViewer, type CodeViewerHandle } from "@/components/FileViewer/CodeViewer";
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import type { MarkdownFontSize } from "@/store/preferencesStore";

// The rendered document pulls react-markdown + remark-gfm; keep that weight
// out of the first-paint chunk (FilePane is a firstRenderRestore seed).
const LazyMarkdownDocument = lazy(() =>
  import("./MarkdownDocument").then((m) => ({ default: m.MarkdownDocument }))
);

/** The rendered document's inset; the loading placeholder occupies the same box. */
const DOCUMENT_INSET = "px-6 py-5";

/**
 * The placeholder's text bars, per reading rung, so each bar lands on the line
 * that replaces it. A body line box is 1.75× the rung (the prose line height);
 * to the nearest stock step, the bar is the glyph height, the gap is the rest
 * of the line box, and `lead` is half of it, centring the first bar on the
 * first line. At `sm` that half-leading is why the bars start 24px down a box
 * whose inset is 20px.
 */
const SKELETON_LINES = {
  "2xs": { bar: "h-3", gap: "space-y-1.75", lead: "py-1" },
  xs: { bar: "h-3.5", gap: "space-y-1.75", lead: "py-1" },
  sm: { bar: "h-4", gap: "space-y-2", lead: "py-1" },
  base: { bar: "h-4.5", gap: "space-y-2.5", lead: "py-1.25" },
  lg: { bar: "h-5", gap: "space-y-3", lead: "py-1.5" },
  xl: { bar: "h-6", gap: "space-y-2.75", lead: "py-1.5" },
  "2xl": { bar: "h-7", gap: "space-y-3.5", lead: "py-1.75" },
  "3xl": { bar: "h-8", gap: "space-y-5", lead: "py-2.5" },
} satisfies Record<MarkdownFontSize, { bar: string; gap: string; lead: string }>;

export interface MarkdownViewerHandle {
  /** Opens CodeMirror's find bar; no-op in rendered mode. */
  openSearch: () => void;
}

export interface MarkdownViewerProps {
  content: string;
  /** Absolute path of the markdown file */
  filePath: string;
  /** Containment root for image loads and relative links */
  rootPath: string;
  viewMode: FileRenderMode;
  /** Source-mode only: line to scroll to and highlight */
  initialLine?: number;
  /** Source-mode only: soft-wrap long lines */
  wrapLines?: boolean;
  /**
   * Rendered-mode only: cache-busting token for local images. Without it a
   * rewritten image keeps a byte-identical daintree-file:// src and Chromium
   * never refetches it (#11587). Source mode renders raw text, so there is no
   * image to bust — hosts only pass this where they render the document.
   */
  cacheBust?: string;
  /**
   * Rendered-mode only: the reading scale, as a rung of the shared type scale.
   * Source mode is CodeMirror, which has its own sizing and no prose hierarchy
   * to tune, so this deliberately never reaches it (#12134).
   */
  fontSize?: MarkdownFontSize;
  className?: string;
  /**
   * Rendered-mode only: fired once the rendered document has committed. Hosts
   * that size to their content pin their height across the swap and release it
   * here, so the lazy chunk's skeleton can't collapse them first (#11255).
   */
  onRendered?: () => void;
}

/**
 * The shared markdown viewing surface: rendered document or syntax-highlighted
 * source. Both the markdown grid panel and the file viewer dialog render this
 * component, so the two surfaces can't drift.
 */
export const MarkdownViewer = forwardRef<MarkdownViewerHandle, MarkdownViewerProps>(
  function MarkdownViewer(
    {
      content,
      filePath,
      rootPath,
      viewMode,
      initialLine,
      wrapLines,
      cacheBust,
      fontSize,
      className,
      onRendered,
    },
    ref
  ) {
    const codeViewerRef = useRef<CodeViewerHandle>(null);

    useImperativeHandle(
      ref,
      () => ({
        openSearch: () => codeViewerRef.current?.openSearch(),
      }),
      []
    );

    if (viewMode === "source") {
      return (
        <CodeViewer
          ref={codeViewerRef}
          content={content}
          filePath={filePath}
          initialLine={initialLine}
          wrapLines={wrapLines}
          className={cn("min-h-[300px]", className)}
        />
      );
    }

    // No rung means the stylesheet's own fallback size, which is `sm`.
    const lines = SKELETON_LINES[fontSize ?? "sm"];

    return (
      <Suspense
        fallback={
          // MarkdownDocument.css centres the document in a 48rem reading column,
          // but that stylesheet ships in the lazy chunk, so the placeholder
          // restates the column (`max-w-3xl` is 48rem). Without it a maximized
          // pane's bars run the full width and snap inward on the swap.
          <div className={cn(DOCUMENT_INSET, "mx-auto max-w-3xl")}>
            <Skeleton label="Loading markdown">
              <SkeletonText
                lines={10}
                lineHeightClassName={lines.bar}
                gapClassName={lines.gap}
                className={lines.lead}
              />
            </Skeleton>
          </div>
        }
      >
        <LazyMarkdownDocument
          content={content}
          filePath={filePath}
          rootPath={rootPath}
          cacheBust={cacheBust}
          fontSize={fontSize}
          className={cn(DOCUMENT_INSET, className)}
          onRendered={onRendered}
        />
      </Suspense>
    );
  }
);
