import { useState, useCallback } from "react";
import type { CdpRemoteArg, CdpPropertyDescriptor } from "@shared/types/ipc/webviewConsole";
import { cn } from "@/lib/utils";

interface ObjectInspectorProps {
  arg: CdpRemoteArg;
  webContentsId?: number;
  isStale?: boolean;
  depth?: number;
}

const MAX_DEPTH = 5;

function PrimitiveValue({ arg }: { arg: CdpRemoteArg & { type: "primitive" } }) {
  switch (arg.kind) {
    case "string":
      return <span className="text-green-400">&quot;{String(arg.value)}&quot;</span>;
    case "number":
      return <span className="text-blue-400">{String(arg.value)}</span>;
    case "boolean":
      return <span className="text-purple-400">{String(arg.value)}</span>;
    case "null":
      return <span className="text-canopy-text/40">null</span>;
    case "undefined":
      return <span className="text-canopy-text/40">undefined</span>;
    case "symbol":
      return <span className="text-yellow-400">{String(arg.value)}</span>;
    case "bigint":
      return <span className="text-blue-400">{String(arg.value)}</span>;
    default:
      return <span>{String(arg.value)}</span>;
  }
}

function PropertyTree({
  properties,
  webContentsId,
  isStale,
  depth,
}: {
  properties: CdpPropertyDescriptor[];
  webContentsId?: number;
  isStale?: boolean;
  depth: number;
}) {
  // Filter out __proto__ and non-enumerable properties for cleaner display
  const visibleProps = properties.filter((p) => p.enumerable !== false && p.name !== "__proto__");

  return (
    <div className="pl-3 border-l border-white/10">
      {visibleProps.map((prop) => (
        <div key={prop.name} className="flex items-start gap-1">
          <span className="text-purple-300 shrink-0">{prop.name}</span>
          <span className="text-canopy-text/40 shrink-0">:</span>
          {prop.value ? (
            <ObjectInspector
              arg={prop.value}
              webContentsId={webContentsId}
              isStale={isStale}
              depth={depth + 1}
            />
          ) : (
            <span className="text-canopy-text/40">undefined</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function ObjectInspector({
  arg,
  webContentsId,
  isStale = false,
  depth = 0,
}: ObjectInspectorProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [properties, setProperties] = useState<CdpPropertyDescriptor[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);

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
  }, [isExpanded, properties, arg, webContentsId, isStale, depth]);

  if (arg.type === "primitive") {
    return <PrimitiveValue arg={arg} />;
  }

  if (arg.type === "function") {
    return <span className="text-cyan-400 italic">ƒ {arg.description}</span>;
  }

  // Object type
  const canExpand = !!arg.objectId && webContentsId != null && !isStale && depth < MAX_DEPTH;
  const displayText = arg.preview ?? arg.description ?? arg.className ?? "Object";

  if (isStale) {
    return (
      <span className="text-canopy-text/30 italic" title="Value unavailable after navigation">
        {displayText}
      </span>
    );
  }

  if (!canExpand) {
    return <span className="text-canopy-text/70">{displayText}</span>;
  }

  return (
    <span className="inline">
      <button
        type="button"
        onClick={() => void handleExpand()}
        className={cn(
          "inline text-left hover:bg-white/5 rounded px-0.5 -mx-0.5 transition-colors",
          isExpanded ? "text-canopy-text/90" : "text-canopy-text/70"
        )}
      >
        <span className="text-canopy-text/40 mr-0.5 select-none">
          {isLoading ? "⏳" : isExpanded ? "▼" : "▶"}
        </span>
        {displayText}
      </button>
      {fetchError && <span className="text-status-error text-[10px] ml-1">unavailable</span>}
      {isExpanded && properties && (
        <PropertyTree
          properties={properties}
          webContentsId={webContentsId}
          isStale={isStale}
          depth={depth}
        />
      )}
    </span>
  );
}
