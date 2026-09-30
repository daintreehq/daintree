import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createTrustedHTML } from "@/lib/trustedTypesPolicy";
import {
  instantiateMermaidSvg,
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

function peekShown(source: string): ShownResult | undefined {
  const result = peekMermaidRender(source, getThemeSignature());
  return result === undefined ? undefined : { source, result };
}

/**
 * A ```mermaid fence rendered as a diagram. Until the diagram is ready — and
 * for good if it fails to parse — the fence's source is shown instead, so the
 * block is never blank. Rendering waits until the block nears the viewport, so
 * opening a long document only pays for the diagrams on screen.
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
      { rootMargin: PRERENDER_MARGIN }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [nearViewport]);

  useEffect(() => {
    if (!nearViewport) return;
    let cancelled = false;
    const request = requestMermaidRender(source, themeSignature);
    void request.result.then((result) => {
      if (cancelled || (!result.ok && result.transient)) return;
      setShown({ source, result });
    });
    return () => {
      cancelled = true;
      request.cancel();
    };
  }, [nearViewport, source, themeSignature]);

  const current = shown?.source === source ? shown.result : undefined;
  const markup = useMemo(
    () => (current?.ok ? instantiateMermaidSvg(current, instanceId) : null),
    [current, instanceId]
  );

  const state = current === undefined ? "pending" : current.ok ? "rendered" : "failed";
  return (
    <div ref={containerRef} className="markdown-mermaid" data-mermaid-state={state}>
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
    </div>
  );
}
