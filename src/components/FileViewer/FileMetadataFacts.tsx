import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { FileTextEncoding } from "@shared/types/ipc/files";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { formatBytes } from "@/lib/formatBytes";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { matchCodeMirrorLanguage } from "./codeMirrorLanguages";
import { FILE_METADATA_RUN_CLASS } from "./fileMetadataStrip";

export type FileLineEnding = "LF" | "CRLF" | "CR" | "mixed";

/** What the strip says about a file — every field observed, none assumed. */
export interface FileTextFacts {
  /** The grammar the viewer highlights with, or "Plain text" when none matches. */
  language: string;
  lineCount: number;
  /** Null when the byte length wasn't observed (an older main). */
  byteLength: number | null;
  /** Null when the encoding wasn't observed (an older main). */
  encoding: FileTextEncoding | null;
  /** Null for text with no line break, where there is no ending to report. */
  lineEnding: FileLineEnding | null;
}

/** Every break CodeMirror recognises: CRLF as one, and a lone CR or LF. */
const LINE_BREAK = /\r\n|\r|\n/g;

export function detectLineEnding(text: string): FileLineEnding | null {
  const kinds = new Set<string>();
  for (const match of text.matchAll(LINE_BREAK)) {
    kinds.add(match[0]);
    if (kinds.size > 1) return "mixed";
  }
  const [only] = kinds;
  if (only === undefined) return null;
  return only === "\r\n" ? "CRLF" : only === "\r" ? "CR" : "LF";
}

/**
 * Lines as the viewer's gutter numbers them, except that an empty file has
 * none — the editor counts it the same way.
 */
export function countLines(text: string): number {
  return text.length === 0 ? 0 : (text.match(LINE_BREAK)?.length ?? 0) + 1;
}

export function describeFileText(input: {
  content: string;
  filePath: string;
  encoding?: FileTextEncoding | null;
  byteLength?: number | null;
}): FileTextFacts {
  // A BOM is three bytes of the size but no text: a BOM-only file has no lines.
  const text =
    input.encoding === "utf-8-bom" && input.content.charCodeAt(0) === 0xfeff
      ? input.content.slice(1)
      : input.content;
  return {
    language: matchCodeMirrorLanguage(input.filePath)?.name ?? "Plain text",
    lineCount: countLines(text),
    byteLength: input.byteLength ?? null,
    encoding: input.encoding ?? null,
    lineEnding: detectLineEnding(text),
  };
}

const ENCODING_LABEL: Record<FileTextEncoding, string> = {
  "utf-8": "UTF-8",
  "utf-8-bom": "UTF-8 with BOM",
  invalid: "Not valid UTF-8",
};

interface FactItem {
  key: string;
  label: string;
  tabular?: boolean;
  /** Amber, with the warning glyph, and this text in a tooltip. Never yields. */
  warning?: string;
}

/** The facts in reading order: identity, then anything unusual, then the routine. */
function factItems(
  facts: FileTextFacts,
  mixedEndingsTooltip: string
): { lead: FactItem[]; routine: FactItem[] } {
  const lead: FactItem[] = [{ key: "language", label: facts.language }];
  const routine: FactItem[] = [];

  if (facts.encoding === "invalid") {
    lead.push({
      key: "encoding",
      label: ENCODING_LABEL.invalid,
      warning:
        "Some bytes in this file aren't valid UTF-8, so they show as �. The file on disk is unchanged.",
    });
  } else if (facts.encoding === "utf-8-bom") {
    lead.push({ key: "encoding", label: ENCODING_LABEL["utf-8-bom"] });
  }
  if (facts.lineEnding === "mixed") {
    lead.push({ key: "eol", label: "Mixed line endings", warning: mixedEndingsTooltip });
  } else if (facts.lineEnding === "CRLF" || facts.lineEnding === "CR") {
    lead.push({ key: "eol", label: facts.lineEnding });
  }

  lead.push({ key: "lines", label: pluralize(facts.lineCount, "line"), tabular: true });
  if (facts.byteLength !== null) {
    lead.push({ key: "size", label: formatBytes(facts.byteLength), tabular: true });
  }

  if (facts.encoding === "utf-8") routine.push({ key: "encoding", label: ENCODING_LABEL["utf-8"] });
  if (facts.lineEnding === "LF") routine.push({ key: "eol", label: "LF" });
  return { lead, routine };
}

/**
 * The order facts leave the visible run under width pressure: the routine
 * pair, then size, then the line count, and the language only when that is
 * what it takes to keep a warning legible. Warnings never leave.
 */
const YIELD_ORDER = ["routine", "size", "lines", "language"] as const;
type Yieldable = (typeof YIELD_ORDER)[number];

/** Space kept between the lead run and the trailing routine pair. */
const ROUTINE_MIN_GAP_PX = 16;

/**
 * Which facts fit the run's width, measured rather than guessed: a fixed
 * breakpoint can't know that this file's run carries two warnings and a
 * six-digit line count. Reads every fact's natural width off an invisible
 * copy of the full run, then drops facts in `YIELD_ORDER` until the visible
 * ones — plus the `…` that stands in for what went — fit.
 */
function useFittedFacts(leadKeys: string, hasRoutine: boolean) {
  const runRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [hidden, setHidden] = useState<ReadonlySet<Yieldable>>(() => new Set());

  useLayoutEffect(() => {
    const run = runRef.current;
    const measure = measureRef.current;
    if (!run || !measure) return;

    const keys = { lead: leadKeys.split(","), hasRoutine };
    const fit = () => {
      const width = (selector: string) =>
        measure.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? 0;
      const gap = parseFloat(getComputedStyle(run).columnGap) || 0;
      const lead = new Map(keys.lead.map((key) => [key, width(`[data-measure="${key}"]`)]));
      const separator = width('[data-measure="separator"]');
      const routine = keys.hasRoutine ? width('[data-measure="routine"]') : 0;
      const marker = width('[data-measure="marker"]');
      const available = run.clientWidth;

      const total = (drop: ReadonlySet<Yieldable>) => {
        const shown = keys.lead.filter((key) => !drop.has(key as Yieldable));
        let sum = 0;
        shown.forEach((key, index) => {
          sum += (lead.get(key) ?? 0) + (index > 0 ? separator + gap * 2 : 0);
        });
        if (keys.hasRoutine && !drop.has("routine")) sum += gap + ROUTINE_MIN_GAP_PX + routine;
        if (drop.size > 0) sum += separator + gap * 2 + marker;
        return sum;
      };

      const drop = new Set<Yieldable>();
      for (const next of YIELD_ORDER) {
        if (total(drop) <= available) break;
        if (next === "routine" ? keys.hasRoutine : keys.lead.includes(next)) drop.add(next);
      }
      setHidden((previous) =>
        previous.size === drop.size && [...drop].every((key) => previous.has(key)) ? previous : drop
      );
    };

    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(run);
    // A changed label (a new line count, a bigger file) resizes the copy.
    observer.observe(measure);
    return () => observer.disconnect();
  }, [leadKeys, hasRoutine]);

  return { runRef, measureRef, hidden };
}

function FactBody({ item }: { item: FactItem }): ReactNode {
  if (item.warning) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 text-status-warning">
            <AlertTriangle aria-hidden="true" className="h-3 w-3 shrink-0" />
            {item.label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{item.warning}</TooltipContent>
      </Tooltip>
    );
  }
  return <span className={cn(item.tabular && "tabular-nums")}>{item.label}</span>;
}

/**
 * The run of facts both file metadata strips carry — Source mode's reader and
 * the Markdown editor's — in one order, through one component, so toggling
 * the mode changes nothing about what the facts say or where they sit.
 *
 * Identity and anything unusual about the bytes lead; the routine encoding and
 * line ending (`UTF-8`, `LF`), true of nearly every file, trail at the run's
 * far edge where they stay out of the way. Under width pressure whole facts
 * leave in `YIELD_ORDER` — never mid-word — and a `…` takes their place and
 * names every fact on hover. A fact that left the screen stays in the
 * accessibility tree (`sr-only`, not removed), so it is still read in order.
 */
export function FileMetadataFacts({
  facts,
  mixedEndingsTooltip,
}: {
  facts: FileTextFacts;
  mixedEndingsTooltip: string;
}) {
  const { lead, routine } = factItems(facts, mixedEndingsTooltip);
  const everything = [...lead, ...routine].map((item) => item.label).join(" · ");
  const { runRef, measureRef, hidden } = useFittedFacts(
    lead.map((item) => item.key).join(","),
    routine.length > 0
  );

  const visibleLead = lead.filter((item) => !hidden.has(item.key as Yieldable));
  const firstVisible = visibleLead[0]?.key;

  return (
    <span
      ref={runRef}
      className={cn(FILE_METADATA_RUN_CLASS, "relative")}
      data-testid="file-metadata-facts"
    >
      {lead.map((item) => {
        const gone = hidden.has(item.key as Yieldable);
        return (
          <span
            key={item.key}
            data-fact={item.key}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap",
              gone && "sr-only"
            )}
          >
            {item.key !== firstVisible && !gone && <FactSeparator />}
            <FactBody item={item} />
          </span>
        );
      })}
      {hidden.size > 0 && (
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <FactSeparator />
          <Tooltip>
            <TooltipTrigger asChild>
              <span aria-hidden="true" data-testid="file-metadata-overflow">
                …
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{everything}</TooltipContent>
          </Tooltip>
        </span>
      )}
      {routine.length > 0 && (
        <span
          data-fact-group="routine"
          className={cn(
            "ml-auto inline-flex shrink-0 items-center gap-1.5 pl-4",
            hidden.has("routine") && "sr-only"
          )}
        >
          {routine.map((item, index) => (
            <span key={item.key} data-fact={item.key} className="inline-flex items-center gap-1.5">
              {index > 0 && <FactSeparator />}
              <FactBody item={item} />
            </span>
          ))}
        </span>
      )}

      {/* The full run at natural width, invisible and out of flow, for the fit. */}
      <span
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute top-0 left-0 inline-flex whitespace-nowrap"
      >
        {lead.map((item) => (
          <span key={item.key} data-measure={item.key} className="inline-flex shrink-0">
            {item.warning ? (
              <span className="inline-flex items-center gap-1">
                <span className="h-3 w-3" />
                {item.label}
              </span>
            ) : (
              <span className={cn(item.tabular && "tabular-nums")}>{item.label}</span>
            )}
          </span>
        ))}
        <span data-measure="separator">·</span>
        <span data-measure="marker">…</span>
        {routine.length > 0 && (
          <span data-measure="routine" className="inline-flex shrink-0 items-center gap-1.5">
            {routine.map((item, index) => (
              <span key={item.key} className="inline-flex items-center gap-1.5">
                {index > 0 && <span>·</span>}
                {item.label}
              </span>
            ))}
          </span>
        )}
      </span>
    </span>
  );
}
