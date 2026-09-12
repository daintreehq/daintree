import type { CSSProperties } from "react";
import type { PanelKind } from "@shared/types/panel";
import { getPanelKindColor } from "@shared/config/panelKindRegistry";
import { cn } from "@/lib/utils";

interface PlaceholderContentProps {
  kind: PanelKind;
  agentId?: string;
  /** Use compact mode for smaller spaces like dock */
  compact?: boolean;
}

// Every bar and block in the illustrations is one of three tints of the kind
// colour, set once on the root. The bars are decorative — the header carries
// the identity — so they stay quiet, but light themes need more than the 10%
// wash that near-vanished on cream surfaces.
function tintVars(color: string): CSSProperties {
  const vars: CSSProperties & Record<`--ph-${string}`, string> = {
    "--ph-soft": `color-mix(in srgb, ${color} 8%, transparent)`,
    "--ph-ink": `color-mix(in srgb, ${color} 16%, transparent)`,
    "--ph-strong": `color-mix(in srgb, ${color} 26%, transparent)`,
    "--ph-solid": `color-mix(in srgb, ${color} 60%, transparent)`,
  };
  return vars;
}

const SOFT = "rounded-sm bg-[var(--ph-soft)]";
const INK = "rounded-sm bg-[var(--ph-ink)]";
const STRONG = "rounded-sm bg-[var(--ph-strong)]";

/**
 * Panel-specific placeholder content for drag operations. Each built-in kind
 * has a distinct composition; anything the registry does not know gets a
 * deliberately generic one instead of impersonating a terminal.
 */
export function PlaceholderContent({ kind, agentId, compact = false }: PlaceholderContentProps) {
  const color = getPanelKindColor(kind, agentId);
  const props = { compact };

  let body: React.ReactNode;
  switch (kind) {
    case "terminal":
      body = <TerminalPlaceholder {...props} />;
      break;
    case "browser":
      body = <BrowserPlaceholder {...props} />;
      break;
    case "dev-preview":
      body = <DevPreviewPlaceholder {...props} />;
      break;
    case "review":
      body = <ReviewPlaceholder {...props} />;
      break;
    case "file":
      body = <FilePlaceholder {...props} />;
      break;
    case "file-browser":
      body = <FileBrowserPlaceholder {...props} />;
      break;
    case "diff":
      body = <DiffPlaceholder {...props} />;
      break;
    default:
      body = <GenericPlaceholder {...props} />;
  }

  return (
    <div className="flex w-full flex-1 flex-col" style={tintVars(color)}>
      {body}
    </div>
  );
}

interface PlaceholderProps {
  compact: boolean;
}

/** A row of output: an optional prompt tick, then a bar. */
function Line({
  width,
  tone = INK,
  compact,
  prompt = false,
}: {
  width: string;
  tone?: string;
  compact: boolean;
  prompt?: boolean;
}) {
  const h = compact ? "h-1" : "h-1.5";
  return (
    <div className={cn("flex items-center", compact ? "gap-1" : "gap-1.5")}>
      {prompt && <div className={cn(STRONG, "shrink-0", compact ? "size-1" : "size-1.5")} />}
      <div className={cn(tone, h)} style={{ width }} />
    </div>
  );
}

/** Terminal: staggered output lines behind a prompt tick. */
function TerminalPlaceholder({ compact }: PlaceholderProps) {
  return (
    <div className={cn("flex w-full flex-col", compact ? "gap-1" : "gap-1.5")}>
      <Line width="70%" compact={compact} prompt />
      <Line width="50%" compact={compact} />
      {!compact && <Line width="40%" compact={compact} />}
    </div>
  );
}

/** Browser: address bar over a page with a row of controls and a content line. */
function BrowserPlaceholder({ compact }: PlaceholderProps) {
  return (
    <div className={cn("flex w-full flex-1 flex-col", compact ? "gap-1" : "gap-1.5")}>
      <div className={cn(INK, "w-[85%]", compact ? "h-1" : "h-1.5")} />
      {/* Page body — omitted in compact so the dock ghost stays within --dock-item-height */}
      {!compact && (
        <div data-placeholder-body className={cn(SOFT, "flex min-h-8 flex-1 flex-col gap-1 p-1.5")}>
          <div className="flex gap-1">
            <div className={cn(STRONG, "size-2.5")} />
            <div className={cn(STRONG, "size-2.5")} />
            <div className={cn(STRONG, "size-2.5")} />
          </div>
          <div className={cn(INK, "h-1 w-4/5")} />
        </div>
      )}
    </div>
  );
}

/** Dev preview: address bar with a live dot, then a code column beside a preview. */
function DevPreviewPlaceholder({ compact }: PlaceholderProps) {
  return (
    <div className={cn("flex w-full flex-1 flex-col", compact ? "gap-1" : "gap-1.5")}>
      <div className={cn("flex items-center", compact ? "gap-1" : "gap-1.5")}>
        <div className={cn(INK, "flex-1", compact ? "h-1" : "h-1.5")} />
        <div
          className={cn(
            "shrink-0 rounded-full bg-[var(--ph-solid)]",
            compact ? "size-1.5" : "size-2"
          )}
        />
      </div>
      {/* Split preview — omitted in compact so the dock ghost stays within --dock-item-height */}
      {!compact && (
        <div data-placeholder-body className="flex min-h-8 flex-1 gap-1">
          <div className={cn(SOFT, "flex w-[30%] flex-col gap-0.5 p-1")}>
            <div className={cn(INK, "h-1 w-4/5")} />
            <div className={cn(INK, "h-1 w-3/5")} />
          </div>
          <div className={cn(SOFT, "flex flex-1 flex-col gap-1 p-1")}>
            <div className="flex gap-1">
              <div className={cn(STRONG, "size-2")} />
              <div className={cn(STRONG, "size-2")} />
            </div>
            <div className={cn(INK, "h-1 w-[70%]")} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Review: a narrow file list beside a block of diff hunks. */
function ReviewPlaceholder({ compact }: PlaceholderProps) {
  const h = compact ? "h-1" : "h-1.5";
  return (
    <div className={cn("flex w-full", compact ? "gap-1" : "gap-1.5")}>
      <div className={cn("flex w-[32%] flex-col", compact ? "gap-1" : "gap-1")}>
        <div className={cn(STRONG, h, "w-[85%]")} />
        <div className={cn(INK, h, "w-[70%]")} />
        {!compact && <div className={cn(INK, h, "w-3/5")} />}
      </div>
      <div className={cn(SOFT, "flex flex-1 flex-col", compact ? "gap-0.5 p-1" : "gap-1 p-1")}>
        <div className={cn(INK, h, "w-[90%]")} />
        <div className={cn(INK, h, "w-3/4")} />
        {!compact && <div className={cn(INK, h, "w-[65%]")} />}
      </div>
    </div>
  );
}

/** File: a document — a short heading over long body lines. */
function FilePlaceholder({ compact }: PlaceholderProps) {
  const h = compact ? "h-1" : "h-1.5";
  return (
    <div className={cn("flex w-full flex-col", compact ? "gap-1" : "gap-1.5")}>
      <div className={cn(STRONG, h, "w-[45%]")} />
      <div className={cn(INK, h, "w-[90%]")} />
      {!compact && <div className={cn(INK, h, "w-4/5")} />}
      {!compact && <div className={cn(INK, h, "w-3/5")} />}
    </div>
  );
}

/** File browser: an indented tree of node markers and names. */
function FileBrowserPlaceholder({ compact }: PlaceholderProps) {
  const h = compact ? "h-1" : "h-1.5";
  const node = compact ? "size-1" : "size-1.5";
  const rows: Array<[string, string]> = compact
    ? [
        ["pl-0", "40%"],
        ["pl-2", "55%"],
      ]
    : [
        ["pl-0", "40%"],
        ["pl-2", "55%"],
        ["pl-4", "45%"],
      ];
  return (
    <div className={cn("flex w-full flex-col", compact ? "gap-1" : "gap-1.5")}>
      {rows.map(([indent, width]) => (
        <div key={indent} className={cn("flex items-center gap-1", indent)}>
          <div className={cn(STRONG, "shrink-0", node)} />
          <div className={cn(INK, h)} style={{ width }} />
        </div>
      ))}
    </div>
  );
}

/** Diff: lines with change markers in the gutter. */
function DiffPlaceholder({ compact }: PlaceholderProps) {
  const h = compact ? "h-1" : "h-1.5";
  const lines: Array<[boolean, string]> = compact
    ? [
        [true, "70%"],
        [true, "55%"],
      ]
    : [
        [false, "60%"],
        [true, "80%"],
        [true, "70%"],
        [false, "45%"],
      ];
  return (
    <div className={cn("flex w-full flex-col", compact ? "gap-1" : "gap-1.5")}>
      {lines.map(([changed, width], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <div
            className={cn(
              "w-0.5 shrink-0 rounded-full",
              h,
              changed ? "bg-[var(--ph-solid)]" : "bg-transparent"
            )}
          />
          <div className={cn(changed ? INK : SOFT, h)} style={{ width }} />
        </div>
      ))}
    </div>
  );
}

/** Anything the registry does not know: two tiles and a caption, no pretence. */
function GenericPlaceholder({ compact }: PlaceholderProps) {
  return (
    <div className={cn("flex w-full flex-col", compact ? "gap-1" : "gap-1.5")}>
      <div className={cn("grid grid-cols-2", compact ? "gap-1" : "gap-1.5")}>
        <div className={cn(SOFT, compact ? "h-2" : "h-5")} />
        <div className={cn(SOFT, compact ? "h-2" : "h-5")} />
      </div>
      <div className={cn(INK, "w-1/2", compact ? "h-1" : "h-1.5")} />
    </div>
  );
}
