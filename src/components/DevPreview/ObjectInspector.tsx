import { useState, useCallback } from "react";
import type { CdpRemoteArg, CdpPropertyDescriptor } from "@shared/types/ipc/webviewConsole";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/Spinner";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { DisclosureChevron } from "./DisclosureChevron";

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
}

const MAX_DEPTH = 5;

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
  properties,
  webContentsId,
  paneId,
  rowId,
  isStale,
  depth,
}: {
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
    <div className="pl-3 border-l border-tint/10">
      {visibleProps.map((prop) => (
        <div key={prop.name} className="flex items-start gap-1">
          <span className="text-text-secondary shrink-0">{prop.name}</span>
          <span className="text-text-secondary shrink-0">:</span>
          {prop.value ? (
            <ObjectInspector
              arg={prop.value}
              webContentsId={webContentsId}
              paneId={paneId}
              rowId={rowId}
              isStale={isStale}
              depth={depth + 1}
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
}: ObjectInspectorProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [properties, setProperties] = useState<CdpPropertyDescriptor[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  // Most property reads land inside the gate, where an indicator would only flash.
  const showLoading = useDeferredLoading(isLoading, UI_INLINE_LOADING_GATE_MS);

  const handleExpand = useCallback(async () => {
    if (isExpanded) {
      setIsExpanded(false);
      return;
    }

    if (properties) {
      setIsExpanded(true);
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
      setProperties(result.properties);
      setIsExpanded(true);
      setFetchError(false);
    } catch {
      setFetchError(true);
    } finally {
      setIsLoading(false);
    }
  }, [isExpanded, properties, arg, webContentsId, paneId, rowId, isStale, depth]);

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
      <span className="text-text-placeholder italic" title="Value unavailable after navigation">
        {displayText}
      </span>
    );
  }

  if (!canExpand) {
    return <span className="text-text-secondary">{displayText}</span>;
  }

  return (
    <span className="inline">
      <button
        type="button"
        onClick={() => void handleExpand()}
        aria-expanded={isExpanded}
        aria-busy={isLoading || undefined}
        className={cn(
          "inline text-left hover:bg-tint/5 rounded px-0.5 -mx-0.5 transition-colors",
          isExpanded ? "text-text-primary" : "text-text-secondary"
        )}
      >
        <span className="inline-flex align-middle mr-0.5 text-text-secondary select-none">
          {showLoading ? <Spinner size="xs" /> : <DisclosureChevron expanded={isExpanded} />}
        </span>
        {displayText}
      </button>
      {fetchError && <span className="text-status-error text-3xs ml-1">unavailable</span>}
      {isExpanded && properties && (
        <PropertyTree
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
