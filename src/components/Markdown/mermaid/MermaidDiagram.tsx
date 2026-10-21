import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { createTrustedHTML } from "@/lib/trustedTypesPolicy";
import { SEVERITY_VISUAL, type StatusSeverity } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import {
  instantiateMermaidSvg,
  MERMAID_MAX_SOURCE_CHARS,
  mermaidRefusal,
  nextMermaidInstanceId,
  peekMermaidRender,
  requestMermaidRender,
  type MermaidRenderResult,
} from "./mermaidRenderer";
import { getThemeSignature, subscribeThemeSignature } from "./mermaidTheme";

/** How far outside the viewport a diagram starts rendering. */
const PRERENDER_MARGIN = "800px 0px";

interface ShownResult {
  source: string;
  result: MermaidRenderResult;
}

interface Failure {
  severity: StatusSeverity;
  message: string;
  retryable: boolean;
}

/**
 * What the note under a failed diagram says. A refusal names the fix, since a
 * syntax correction can't remove a URL; Mermaid's own error text stays out of
 * it. A renderer that never loaded says nothing about the diagram, so it is
 * the one failure worth retrying.
 */
function describeFailure(source: string, result: MermaidRenderResult): Failure {
  if (!result.ok && result.transient) {
    return { severity: "error", message: "Diagram renderer couldn't load", retryable: true };
  }
  if (!result.ok && result.undisplayable) {
    return { severity: "error", message: "Diagram couldn't be displayed here", retryable: false };
  }
  const refused = (message: string): Failure => ({
    severity: "warning",
    message,
    retryable: false,
  });
  switch (mermaidRefusal(source)) {
    case "too-large":
      return refused(
        `Diagram not rendered: source is over ${MERMAID_MAX_SOURCE_CHARS.toLocaleString("en-US")} characters`
      );
    case "url":
      return refused("Diagram not rendered: links and URLs aren't allowed in diagrams here");
    case "html":
      return refused("Diagram not rendered: HTML isn't allowed in diagrams here");
    case "css":
      return refused("Diagram not rendered: CSS that loads resources isn't allowed here");
    case "escape":
      return refused("Diagram not rendered: backslash escapes aren't allowed in diagrams here");
    default:
      return {
        severity: "error",
        message: "Diagram couldn't render: check the Mermaid syntax",
        retryable: false,
      };
  }
}

function peekShown(source: string): ShownResult | undefined {
  const result = peekMermaidRender(source, getThemeSignature());
  return result === undefined ? undefined : { source, result };
}

/**
 * A ```mermaid fence rendered as a diagram. Until the diagram is ready — and
 * for good if it fails — the fence's source is shown instead, so the block is
 * never blank, and a line under the source says which of the two it is:
 * "Rendering" once the wait passes the anti-flicker gate, the reason once it
 * has failed. All three states share one frame, so the swap to the diagram
 * changes only the block's height. Rendering waits until the block nears the
 * viewport, so opening a long document only pays for the diagrams on screen.
 *
 * A theme change keeps the previous diagram up until the re-themed one lands.
 * A source change does not: an old diagram under new source would be wrong,
 * so the new source shows until its own diagram is ready.
 */
export function MermaidDiagram({ source, fallback }: { source: string; fallback: ReactNode }) {
  const themeSignature = useSyncExternalStore(subscribeThemeSignature, getThemeSignature);
  const containerRef = useRef<HTMLDivElement>(null);
  const [instanceId] = useState(nextMermaidInstanceId);
  const [shown, setShown] = useState<ShownResult | undefined>(() => peekShown(source));
  const [nearViewport, setNearViewport] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (nearViewport) return;
    const element = containerRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNearViewport(true);
      },
      // `rootMargin` only grows the viewport; the pane's own scroller would
      // still clip a diagram until it scrolled in. `scrollMargin` grows every
      // scroll container on the way.
      { rootMargin: PRERENDER_MARGIN, scrollMargin: PRERENDER_MARGIN }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [nearViewport]);

  useEffect(() => {
    if (!nearViewport) return;
    let cancelled = false;
    const request = requestMermaidRender(source, themeSignature);
    void request.result.then((result) => {
      if (cancelled) return;
      // A transient outcome under a theme that has since moved is superseded by
      // the request the new theme makes. Under the same theme nothing else is
      // coming, so it is shown as the load failure it is rather than left
      // reading "Rendering" for good.
      if (!result.ok && result.transient && getThemeSignature() !== themeSignature) return;
      setShown({ source, result });
    });
    return () => {
      cancelled = true;
      request.cancel();
    };
  }, [nearViewport, source, themeSignature, attempt]);

  const current = shown?.source === source ? shown.result : undefined;
  const markup = useMemo(
    () => (current?.ok ? instantiateMermaidSvg(current, instanceId) : null),
    [current, instanceId]
  );
  const failure = current !== undefined && !current.ok ? describeFailure(source, current) : null;
  const FailureGlyph = failure ? SEVERITY_VISUAL[failure.severity].Icon : null;

  const retry = () => {
    // Retry unmounts with the note it sits in; the block keeps focus instead.
    containerRef.current?.focus({ preventScroll: true });
    setShown(undefined);
    setAttempt((count) => count + 1);
  };

  const state = current === undefined ? "pending" : current.ok ? "rendered" : "failed";
  return (
    <div
      ref={containerRef}
      className="markdown-mermaid"
      role="group"
      aria-label="Mermaid diagram"
      tabIndex={-1}
      data-mermaid-state={state}
    >
      {markup !== null ? (
        <div
          className="markdown-mermaid__diagram"
          // Sanitized by sanitizeMermaidSvg inside mermaidRenderer; instancing
          // only renames the ids it minted.
          dangerouslySetInnerHTML={{ __html: createTrustedHTML(markup) }}
        />
      ) : (
        fallback
      )}
      {/* The pending line holds the row a failure will take, so the source
          never moves; it fades in only past the anti-flicker gate. The live
          region is mounted from the start, so what arrives in it later is
          announced: a failure, or the diagram landing after a Retry, whose
          focused button has just gone. Divs, not <p>: the rendered diff
          strikes paragraphs in removed blocks. */}
      {state === "pending" && (
        <div className="markdown-mermaid__note markdown-mermaid__note--pending">
          Rendering diagram…
        </div>
      )}
      <div
        className={failure ? "markdown-mermaid__note" : undefined}
        role="status"
        aria-atomic="true"
      >
        {state === "rendered" && attempt > 0 && <span className="sr-only">Diagram rendered</span>}
        {failure && FailureGlyph && (
          <>
            <FailureGlyph
              className={cn(
                "markdown-mermaid__note-glyph",
                SEVERITY_VISUAL[failure.severity].toneClass
              )}
              aria-hidden="true"
            />
            <span className="markdown-mermaid__note-text">{failure.message}</span>
            {failure.retryable && (
              <Button variant="link" size="inline" onClick={retry}>
                Retry
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
