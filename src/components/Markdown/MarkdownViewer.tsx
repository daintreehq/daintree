import { forwardRef, lazy, Suspense, useImperativeHandle, useRef } from "react";
import type { MarkdownViewMode } from "@shared/types/panel";
import { CodeViewer, type CodeViewerHandle } from "@/components/FileViewer/CodeViewer";
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";

// The rendered document pulls react-markdown + remark-gfm; keep that weight
// out of the first-paint chunk (MarkdownPane is a firstRenderRestore seed).
const LazyMarkdownDocument = lazy(() =>
  import("./MarkdownDocument").then((m) => ({ default: m.MarkdownDocument }))
);

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
  viewMode: MarkdownViewMode;
  /** Source-mode only: line to scroll to and highlight */
  initialLine?: number;
  className?: string;
}

/**
 * The shared markdown viewing surface: rendered document or syntax-highlighted
 * source. Both the markdown grid panel and the file viewer dialog render this
 * component, so the two surfaces can't drift.
 */
export const MarkdownViewer = forwardRef<MarkdownViewerHandle, MarkdownViewerProps>(
  function MarkdownViewer({ content, filePath, rootPath, viewMode, initialLine, className }, ref) {
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
          className={cn("min-h-[300px]", className)}
        />
      );
    }

    return (
      <Suspense
        fallback={
          <div className="p-6">
            <Skeleton label="Loading markdown">
              <SkeletonText lines={10} />
            </Skeleton>
          </div>
        }
      >
        <LazyMarkdownDocument
          content={content}
          filePath={filePath}
          rootPath={rootPath}
          className={cn("px-6 py-5", className)}
        />
      </Suspense>
    );
  }
);
