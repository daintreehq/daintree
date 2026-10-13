import { createContext, useCallback, useContext, useId, useRef, useState } from "react";
import type { CdpRemoteArg, CdpPropertyDescriptor } from "@shared/types/ipc/webviewConsole";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { DisclosureChevron } from "./DisclosureChevron";
import { DISCLOSURE_TOGGLE_CLASS } from "./StackTrace";
import { useRowFocusTooltip } from "./rowFocusTooltip";

interface ObjectInspectorProps {
  arg: CdpRemoteArg;
  webContentsId?: number;
  /**
   * Pane and row that own this handle. Main attributes the descendant handles
   * an expansion returns to that row, so they are released with it rather than
   * outliving the row on screen (#12298).
   */
  paneId: string;
  rowId: number;
  isStale?: boolean;
  depth?: number;
  /** Where this value sits in its row: the argument index, then property names. */
  path: string;
}

const MAX_DEPTH = 5;

export interface ObjectView {
  expanded: boolean;
  properties: CdpPropertyDescriptor[] | null;
}

/**
 * What the user has opened, kept by the console rather than by each inspector:
 * the list is virtualized, so a row scrolled out of view unmounts and would
 * otherwise come back closed and read its properties again. Keyed by row and
 * property path; the console drops a row's entries when the row goes.
 */
export type ObjectViewCache = Map<string, ObjectView>;
export const ObjectViewCacheContext = createContext<ObjectViewCache | null>(null);

const CLOSED_VIEW: ObjectView = { expanded: false, properties: null };

function PrimitiveValue({ arg }: { arg: CdpRemoteArg & { type: "primitive" } }) {
  switch (arg.kind) {
    case "string":
      return <span className="text-syntax-string">&quot;{String(arg.value)}&quot;</span>;
    case "number":
      return <span className="text-syntax-number">{String(arg.value)}</span>;
    case "boolean":
      return <span className="text-category-purple">{String(arg.value)}</span>;
    case "null":
      return <span className="text-text-secondary">null</span>;
    case "undefined":
      return <span className="text-text-secondary">undefined</span>;
    case "symbol":
      return <span className="text-syntax-keyword">{String(arg.value)}</span>;
    case "bigint":
      return <span className="text-syntax-number">{String(arg.value)}</span>;
    default:
      return <span>{String(arg.value)}</span>;
  }
}

function PropertyTree({
  id,
  path,
  properties,
  webContentsId,
  paneId,
  rowId,
  isStale,
  depth,
}: {
  id: string;
  path: string;
  properties: CdpPropertyDescriptor[];
  webContentsId?: number;
  paneId: string;
  rowId: number;
  isStale?: boolean;
  depth: number;
}) {
  // Filter out __proto__ and non-enumerable properties for cleaner display
  const visibleProps = properties.filter((p) => p.enumerable !== false && p.name !== "__proto__");

  return (
    <div id={id} className="pl-3 border-l border-tint/10">
      {visibleProps.map((prop) => (
        // 24px apart, so neighbouring property disclosures keep the
        // target-spacing clearance (WCAG 2.5.8) without growing the button.
        <div key={prop.name} className="flex items-start gap-1 py-[0.1875rem]">
          <span className="text-text-secondary shrink-0">{prop.name}:</span>
          {prop.value ? (
            <ObjectInspector
              arg={prop.value}
              webContentsId={webContentsId}
              paneId={paneId}
              rowId={rowId}
              isStale={isStale}
              depth={depth + 1}
              path={`${path}.${prop.name}`}
            />
          ) : (
            <span className="text-text-secondary">undefined</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function ObjectInspector({
  arg,
  webContentsId,
  paneId,
  rowId,
  isStale = false,
  depth = 0,
  path,
}: ObjectInspectorProps) {
  const cache = useContext(ObjectViewCacheContext);
  const cacheKey = `${rowId}:${path}`;
  const [view, setViewState] = useState<ObjectView>(() => cache?.get(cacheKey) ?? CLOSED_VIEW);
  const { expanded: isExpanded, properties } = view;
  const setView = useCallback(
    (next: ObjectView) => {
      setViewState(next);
      cache?.set(cacheKey, next);
    },
    [cache, cacheKey]
  );
  const [isLoading, setIsLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  // Most property reads land inside the gate, where an indicator would only flash.
  const showLoading = useDeferredLoading(isLoading, UI_INLINE_LOADING_GATE_MS);
  const propertiesId = useId();
  const staleTooltip = useRowFocusTooltip();
  const disclosureRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  const handleExpand = useCallback(async () => {
    if (isExpanded) {
      setView({ expanded: false, properties });
      return;
    }

    if (properties) {
      setView({ expanded: true, properties });
      return;
    }

    if (
      arg.type !== "object" ||
      !arg.objectId ||
      webContentsId == null ||
      isStale ||
      depth >= MAX_DEPTH
    ) {
      return;
    }

    setIsLoading(true);
    try {
      const result = await window.electron.webview.getConsoleProperties(
        webContentsId,
        paneId,
        rowId,
        arg.objectId
      );
      // A successful retry takes its button away; focus moves to the value
      // it opened rather than falling to the page.
      const retryHadFocus =
        retryRef.current !== null && retryRef.current === document.activeElement;
      setView({ expanded: true, properties: result.properties });
      setFetchError(false);
      if (retryHadFocus) requestAnimationFrame(() => disclosureRef.current?.focus());
    } catch {
      setFetchError(true);
    } finally {
      setIsLoading(false);
    }
  }, [isExpanded, properties, setView, arg, webContentsId, paneId, rowId, isStale, depth]);

  if (arg.type === "primitive") {
    return <PrimitiveValue arg={arg} />;
  }

  if (arg.type === "function") {
    return <span className="text-category-cyan italic">ƒ {arg.description}</span>;
  }

  // Object type
  const canExpand = !!arg.objectId && webContentsId != null && !isStale && depth < MAX_DEPTH;
  const displayText = arg.preview ?? arg.description ?? arg.className ?? "Object";

  if (isStale) {
    return (
      <Tooltip open={staleTooltip.open} onOpenChange={staleTooltip.onOpenChange}>
        <TooltipTrigger asChild>
          <span className="text-text-secondary italic" {...staleTooltip.triggerProps}>
            {displayText}
            <span className="sr-only"> (unavailable after navigation)</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">Value unavailable after navigation</TooltipContent>
      </Tooltip>
    );
  }

  if (!canExpand) {
    return <span className="text-text-secondary">{displayText}</span>;
  }

  return (
    <span className="inline">
      <button
        ref={disclosureRef}
        type="button"
        onClick={() => void handleExpand()}
        aria-expanded={isExpanded}
        aria-controls={isExpanded && properties ? propertiesId : undefined}
        aria-busy={isLoading || undefined}
        className={cn(
          "inline text-left hover:bg-overlay-subtle rounded-[var(--radius-xs)] px-0.5 -mx-0.5 transition-colors duration-150 ease-out",
          isExpanded ? "text-text-primary" : "text-text-secondary"
        )}
      >
        <span className="inline-flex align-middle mr-0.5 text-text-secondary select-none">
          {showLoading ? <Spinner size="xs" /> : <DisclosureChevron expanded={isExpanded} />}
        </span>
        {displayText}
      </button>
      {fetchError && (
        <span className="ml-2 inline-flex items-baseline gap-2">
          <span role="alert" className="text-status-error">
            Couldn't load value
          </span>
          <button
            ref={retryRef}
            type="button"
            onClick={() => void handleExpand()}
            className={cn(DISCLOSURE_TOGGLE_CLASS, "min-h-6 -my-1")}
          >
            Retry
          </button>
        </span>
      )}
      {isExpanded && properties && (
        <PropertyTree
          id={propertiesId}
          path={path}
          properties={properties}
          webContentsId={webContentsId}
          paneId={paneId}
          rowId={rowId}
          isStale={isStale}
          depth={depth}
        />
      )}
    </span>
  );
}
