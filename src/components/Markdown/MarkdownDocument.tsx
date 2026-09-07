import { useEffect, useRef, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMarkdownRenderPolicy } from "./markdownRenderPolicy";
import { useScopedSelectAll } from "@/hooks/useScopedSelectAll";
import { cn } from "@/lib/utils";
import type { MarkdownFontSize } from "@/store/preferencesStore";
import "./MarkdownDocument.css";

/**
 * Each reading rung resolved to the shared type scale — the same stock Tailwind
 * steps the diff text-size preference names, so the reading size keeps tracking
 * the scale when the scale moves. Same shape as `DIFF_FONT_SIZE`.
 *
 * Spelled out rather than interpolated, and beware of writing one of these
 * references into prose: `builtInThemes.test.ts` scans every non-test renderer
 * file — comments included — for CSS variable references, and reads an
 * interpolated one as a variable named after the part before the placeholder.
 * `satisfies` keeps the set exhaustive; that each rung names its own step is
 * pinned in MarkdownDocument.test.ts, which that scan skips.
 */
export const MARKDOWN_FONT_SIZE_TOKEN = {
  "2xs": "var(--text-2xs)",
  xs: "var(--text-xs)",
  sm: "var(--text-sm)",
  base: "var(--text-base)",
  lg: "var(--text-lg)",
  xl: "var(--text-xl)",
  "2xl": "var(--text-2xl)",
  "3xl": "var(--text-3xl)",
} satisfies Record<MarkdownFontSize, string>;

/** `MarkdownDocument.css` reads this; declaring it here is what applies the rung. */
type MarkdownFontStyle = CSSProperties & Record<"--markdown-font-size", string>;

export interface MarkdownDocumentProps {
  /** Markdown source text */
  content: string;
  /** Absolute path of the file, used to resolve relative links and images */
  filePath: string;
  /** Containment root for daintree-file:// image loads */
  rootPath: string;
  /**
   * Cache-busting token appended to local image URLs. The daintree-file:// URL
   * is otherwise a pure function of path + root, so a rewritten image keeps a
   * byte-identical `src` and Chromium never refetches it (#11587). Hosts pass
   * whatever token already tracks their refresh cycle; same `cacheBust` idiom
   * as FileImagePreview and ZoomableImage.
   */
  cacheBust?: string;
  className?: string;
  /**
   * Reading scale for this document, as a rung of the shared type scale. Absent
   * leaves the CSS fallback in charge, which is the size every surface rendered
   * at before the control existed (#12134).
   */
  fontSize?: MarkdownFontSize;
  /**
   * Fired once the document has committed. Hosts that pinned their height
   * across the swap into rendered mode use this to release the pin (#11255).
   */
  onRendered?: () => void;
}

/**
 * Read-only rendered view of a markdown document. Shared by the markdown
 * panel and the file viewer dialog. GFM (tables, task lists, strikethrough,
 * autolinks) is on; raw HTML embedded in the markdown is intentionally never
 * rendered — there is no rehype-raw in the pipeline and `skipHtml` drops the
 * raw nodes entirely. That is the safety boundary that lets this render
 * arbitrary repo files inside an Electron renderer without a sanitizer.
 */
export function MarkdownDocument({
  content,
  filePath,
  rootPath,
  cacheBust,
  className,
  fontSize,
  onRendered,
}: MarkdownDocumentProps) {
  // Runs after the first commit, which is the point the host's height pin can
  // hand the box back to the document. Cold fence grammars land later and swap
  // plain text for span-wrapped identical text — same characters, same line
  // count, so they can't shrink the box and don't gate this.
  useEffect(() => {
    onRendered?.();
  }, [onRendered]);

  // Nothing owns Select All over plain rendered DOM, so the native Edit-menu
  // command falls back to the whole app (#12135). Claim it for the document.
  const rootRef = useRef<HTMLDivElement>(null);
  useScopedSelectAll(rootRef);

  const { components, urlTransform } = useMarkdownRenderPolicy({
    filePath,
    rootPath,
    cacheBust,
  });

  const fontStyle: MarkdownFontStyle | undefined =
    fontSize === undefined
      ? undefined
      : { "--markdown-font-size": MARKDOWN_FONT_SIZE_TOKEN[fontSize] };

  return (
    <div ref={rootRef} className={cn("markdown-document prose", className)} style={fontStyle}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={components}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
