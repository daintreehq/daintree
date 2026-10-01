import { isValidElement, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, CircleCheck, CircleDashed, CircleHelp, CircleSlash } from "lucide-react";
import type {
  PluginConnectionCardProps,
  PluginConnectionStatus,
  PluginDecisionRequestProps,
  PluginDecisionStatus,
  PluginOperationState,
  PluginOperationStatusProps,
  PluginSourceCitationProps,
  PluginSourceListProps,
  PluginStructuredDiffProps,
  PluginSuggestedValueProps,
  PluginToolCallCardProps,
} from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InlineError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { renderIconSource } from "./PluginKitIcons";
import { pluginKitDates } from "./PluginKitDates";
import { pluginKitObjectInspector } from "./PluginKitObjectInspector";
import { pluginKitRichDisplay } from "./PluginKitRichDisplay";
import { pluginKitTypography } from "./PluginKitTypography";
import { useKitOverlayZClass } from "./kitScope";
import { toTimestamp } from "./kitTime";
import {
  faultMessage,
  isThenable,
  reportPluginFault,
  runPluginAction,
  settleThenable,
} from "./kitDiagnostics";
import {
  content,
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickRootProps,
  str,
} from "./kitProps";

const ErrorGlyph = SEVERITY_GLYPH.error;
const WarningGlyph = SEVERITY_GLYPH.warning;
const StateGlyph = pluginKitTypography.StateGlyph;
const TimeAgo = pluginKitDates.TimeAgo;
const ObjectInspector = pluginKitObjectInspector.ObjectInspector;
const HoverCard = pluginKitRichDisplay.HoverCard;

const GLYPH = "h-3.5 w-3.5 shrink-0";

// ---------------------------------------------------------------------------
// OperationStatus

const OPERATION_STATES = [
  "queued",
  "running",
  "waiting-input",
  "awaiting-approval",
  "cancelling",
  "partial",
  "done",
  "failed",
  "cancelled",
  "unknown",
] as const satisfies readonly PluginOperationState[];

const OPERATION_WORD: Record<PluginOperationState, string> = {
  queued: "Queued",
  running: "Running",
  "waiting-input": "Needs input",
  "awaiting-approval": "Awaiting approval",
  cancelling: "Cancelling",
  partial: "Partly done",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Outcome unknown",
};

// As TaskList draws them: settled work is neutral (status-success-policy),
// a failure keeps its colour, and work held on the user takes the agent
// waiting ring, the app's one "your turn" mark.
export function OperationGlyph({ state }: { state: PluginOperationState }) {
  switch (state) {
    case "running":
    case "cancelling":
      return <Spinner size="sm" className="text-text-secondary" />;
    case "queued":
      return <CircleDashed aria-hidden="true" className={cn(GLYPH, "text-text-secondary")} />;
    case "waiting-input":
    case "awaiting-approval":
      return <StateGlyph state="waiting" size={14} />;
    case "partial":
      return <WarningGlyph aria-hidden="true" className={cn(GLYPH, "text-status-warning")} />;
    case "done":
      return <CircleCheck aria-hidden="true" className={cn(GLYPH, "text-text-secondary")} />;
    case "failed":
      return <ErrorGlyph aria-hidden="true" className={cn(GLYPH, "text-status-error")} />;
    case "cancelled":
      return <CircleSlash aria-hidden="true" className={cn(GLYPH, "text-text-secondary")} />;
    case "unknown":
      return <CircleHelp aria-hidden="true" className={cn(GLYPH, "text-text-secondary")} />;
  }
}

export function readOperationState(value: unknown): PluginOperationState | undefined {
  return oneOf(value, OPERATION_STATES);
}

function KitOperationStatus({
  state,
  label,
  detail,
  compact,
  className,
  ...rest
}: PluginOperationStatusProps) {
  const overlayZ = useKitOverlayZClass();
  const resolved = readOperationState(state) ?? "unknown";
  const word = nonEmpty(label) ?? OPERATION_WORD[resolved];
  const more = nonEmpty(detail);
  if (compact === true) {
    const spoken = more ? `${word}, ${more}` : word;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            {...pickRootProps(rest)}
            role="img"
            aria-label={spoken}
            data-operation-state={resolved}
            className={cn("inline-flex shrink-0 items-center", str(className))}
          >
            <OperationGlyph state={resolved} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className={overlayZ}>
          {spoken}
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <span
      {...pickRootProps(rest)}
      data-operation-state={resolved}
      className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs", str(className))}
    >
      <OperationGlyph state={resolved} />
      <span className="shrink-0 text-text-primary">{word}</span>
      {more ? <span className="min-w-0 truncate text-text-secondary">{more}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ConnectionCard

const CONNECTION_STATUSES = [
  "connected",
  "connecting",
  "disconnected",
  "expired",
  "limited",
  "error",
] as const satisfies readonly PluginConnectionStatus[];

const CONNECTION_WORD: Record<PluginConnectionStatus, string> = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Not connected",
  expired: "Sign-in expired",
  limited: "Limited access",
  error: "Couldn't connect",
};

function ConnectionGlyph({ status }: { status: PluginConnectionStatus }) {
  switch (status) {
    case "connected":
      return <CircleCheck aria-hidden="true" className={cn(GLYPH, "text-text-secondary")} />;
    case "connecting":
      return <Spinner size="sm" className="text-text-secondary" />;
    case "disconnected":
      return <CircleDashed aria-hidden="true" className={cn(GLYPH, "text-text-secondary")} />;
    case "expired":
    case "limited":
      return <WarningGlyph aria-hidden="true" className={cn(GLYPH, "text-status-warning")} />;
    case "error":
      return <ErrorGlyph aria-hidden="true" className={cn(GLYPH, "text-status-error")} />;
  }
}

function KitConnectionCard({
  name,
  icon,
  account,
  status,
  detail,
  checkedAt,
  actions,
  className,
  ...rest
}: PluginConnectionCardProps) {
  const titleId = useId();
  const service = nonEmpty(name) ?? "";
  const state = oneOf(status, CONNECTION_STATUSES) ?? "disconnected";
  const who = nonEmpty(account);
  const checked = toTimestamp(checkedAt);
  const glyph = renderIconSource(icon ?? "plug");
  return (
    <section
      {...pickRootProps(rest)}
      aria-labelledby={titleId}
      data-connection-status={state}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-surface-panel p-3",
        str(className)
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {glyph ? (
          <span className="mt-0.5 flex shrink-0 text-text-secondary [&_svg]:h-4 [&_svg]:w-4">
            {glyph}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 id={titleId} className="truncate text-sm font-medium text-text-primary">
            {service}
          </h3>
          {who ? <span className="truncate text-xs text-text-secondary">{who}</span> : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5 text-text-primary">
          <ConnectionGlyph status={state} />
          {CONNECTION_WORD[state]}
        </span>
        {Number.isNaN(checked) ? null : (
          <span className="text-text-secondary">
            Checked <TimeAgo value={checked} />
          </span>
        )}
      </div>
      {hasContent(detail) ? (
        <div className="text-xs text-text-secondary">{node(detail)}</div>
      ) : null}
      {hasContent(actions) ? (
        <div className="flex flex-wrap items-center gap-2">{node(actions)}</div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// ToolCallCard

function durationOf(started: number, finished: number): string | null {
  if (Number.isNaN(started) || Number.isNaN(finished) || finished < started) return null;
  return formatElapsedDuration(finished - started, { subSecond: true });
}

function ToolCallValue({ value, label }: { value: unknown; label: string }) {
  if (isValidElement(value)) return value;
  if (typeof value === "string") {
    return (
      <pre className="max-h-60 overflow-auto rounded-[var(--radius-sm)] bg-overlay-subtle p-2 font-mono text-xs whitespace-pre-wrap text-text-primary">
        {value}
      </pre>
    );
  }
  return (
    <ObjectInspector
      value={value}
      aria-label={label}
      toolbar={false}
      className="max-h-60 rounded-[var(--radius-sm)] bg-overlay-subtle"
    />
  );
}

function KitToolCallCard({
  name,
  summary,
  state,
  input,
  result,
  error,
  startedAt,
  finishedAt,
  open,
  defaultOpen,
  onOpenChange,
  className,
  ...rest
}: PluginToolCallCardProps) {
  const panelId = useId();
  const controlled = typeof open === "boolean";
  const [own, setOwn] = useState(defaultOpen === true);
  const isOpen = controlled ? open : own;
  const changeOpen = fn(onOpenChange);
  const tool = nonEmpty(name) ?? "tool";
  const purpose = nonEmpty(summary);
  const resolved = readOperationState(state) ?? "unknown";
  const took = durationOf(toTimestamp(startedAt), toTimestamp(finishedAt));
  const hasInput = input !== undefined;
  const hasResult = result !== undefined && result !== null;
  const hasError = hasContent(error);
  const expandable = hasInput || hasResult || hasError;
  const toggle = () => {
    if (!controlled) setOwn(!isOpen);
    if (changeOpen) runPluginAction("ToolCallCard onOpenChange", () => changeOpen(!isOpen));
  };
  const row = (
    <>
      {expandable ? (
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform duration-150 ease-out motion-reduce:transition-none",
            isOpen && "rotate-90"
          )}
        />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <OperationGlyph state={resolved} />
      <span className="sr-only">{OPERATION_WORD[resolved]}: </span>
      <span className="shrink-0 font-mono text-xs text-text-primary">{tool}</span>
      {purpose ? (
        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{purpose}</span>
      ) : (
        <span className="flex-1" />
      )}
      {took ? (
        <span className="shrink-0 text-xs tabular-nums text-text-secondary">{took}</span>
      ) : null}
    </>
  );
  const rowClass =
    "flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1 text-left";
  return (
    <div
      {...pickRootProps(rest)}
      data-tool-call=""
      data-operation-state={resolved}
      className={cn("flex min-w-0 flex-col", str(className))}
    >
      {expandable ? (
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={isOpen ? panelId : undefined}
          onClick={toggle}
          className={cn(
            rowClass,
            "transition-colors duration-150 ease-out hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
          )}
        >
          {row}
        </button>
      ) : (
        <div className={rowClass}>{row}</div>
      )}
      {expandable && isOpen ? (
        <div id={panelId} className="flex min-w-0 flex-col gap-2 py-1.5 pr-1.5 pl-7">
          {hasError ? <InlineError>{node(error)}</InlineError> : null}
          {hasInput ? (
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-text-secondary">Input</span>
              <ToolCallValue value={input} label={`${tool} input`} />
            </div>
          ) : null}
          {hasResult ? (
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-text-secondary">Result</span>
              <ToolCallValue value={result} label={`${tool} result`} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StructuredDiff

const CHANGE_KINDS = ["added", "changed", "removed"] as const;

interface ChangeEntry {
  id: string;
  label: string;
  kind: (typeof CHANGE_KINDS)[number];
  before: ReactNode;
  after: ReactNode;
  note: ReactNode;
  error: string | undefined;
}

function readChanges(value: unknown): ChangeEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: ChangeEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    const label = nonEmpty(field(entry, "label"));
    if (id === undefined || label === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label,
      kind: oneOf(field(entry, "kind"), CHANGE_KINDS) ?? "changed",
      before: content(field(entry, "before")),
      after: content(field(entry, "after")),
      note: content(field(entry, "note")),
      error: nonEmpty(field(entry, "error")),
    });
  }
  return out;
}

const EMPTY_VALUE = <span className="text-text-secondary">—</span>;

function KitStructuredDiff({
  changes,
  selected,
  onSelectedChange,
  title,
  empty,
  disabled,
  className,
  ...rest
}: PluginStructuredDiffProps) {
  const titleId = useId();
  const list = readChanges(changes);
  const choose = fn(onSelectedChange);
  const inert = disabled === true;
  const selectable = list.filter((entry) => entry.error === undefined).map((entry) => entry.id);
  const picked = new Set(
    Array.isArray(selected) ? selected.filter((id): id is string => typeof id === "string") : []
  );
  const chosen = selectable.filter((id) => picked.has(id));
  const hasTitle = hasContent(title);
  if (list.length === 0) {
    return (
      <div {...pickRootProps(rest)} className={cn("text-sm text-text-secondary", str(className))}>
        {hasContent(empty) ? node(empty) : "No changes"}
      </div>
    );
  }
  const set = (next: string[]) => {
    if (choose) runPluginAction("StructuredDiff onSelectedChange", () => choose(next));
  };
  const all =
    chosen.length === 0
      ? false
      : chosen.length === selectable.length
        ? true
        : ("indeterminate" as const);
  return (
    <div
      {...pickRootProps(rest)}
      data-structured-diff=""
      className={cn("flex min-w-0 flex-col gap-1.5", str(className))}
    >
      {hasTitle || choose ? (
        <div className="flex min-w-0 items-center gap-2">
          {choose ? (
            <Checkbox
              size="sm"
              checked={all}
              disabled={inert || selectable.length === 0}
              aria-label="Select all changes"
              onCheckedChange={() => set(all === true ? [] : selectable)}
            />
          ) : null}
          {hasTitle ? (
            <span id={titleId} className="min-w-0 truncate text-sm font-medium text-text-primary">
              {node(title)}
            </span>
          ) : null}
          {choose ? (
            <span className="ml-auto shrink-0 text-xs tabular-nums text-text-secondary">
              {chosen.length} of {selectable.length} selected
            </span>
          ) : null}
        </div>
      ) : null}
      <table
        aria-labelledby={hasTitle ? titleId : undefined}
        className="w-full min-w-0 table-fixed border-collapse text-sm"
      >
        <thead className="sr-only">
          <tr>
            {choose ? <th scope="col">Apply</th> : null}
            <th scope="col">Field</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {list.map((entry) => {
            const valid = entry.error === undefined;
            return (
              <tr
                key={entry.id}
                data-change={entry.id}
                data-kind={entry.kind}
                className="border-t border-divider align-top first:border-t-0"
              >
                {choose ? (
                  <td className="w-7 py-1.5 pr-1">
                    <Checkbox
                      size="sm"
                      checked={valid && picked.has(entry.id)}
                      disabled={inert || !valid}
                      aria-label={`Apply ${entry.label}`}
                      onCheckedChange={(next) =>
                        set(
                          next === true
                            ? selectable.filter((id) => picked.has(id) || id === entry.id)
                            : chosen.filter((id) => id !== entry.id)
                        )
                      }
                    />
                  </td>
                ) : null}
                <th
                  scope="row"
                  className="w-1/4 py-1.5 pr-3 text-left font-normal text-text-secondary"
                >
                  <span className="block truncate">{entry.label}</span>
                </th>
                <td className="py-1.5 pr-3 text-text-secondary">
                  {entry.kind === "added" ? (
                    EMPTY_VALUE
                  ) : (
                    <span className={cn("break-words", entry.kind === "removed" && "line-through")}>
                      {entry.before ?? EMPTY_VALUE}
                    </span>
                  )}
                </td>
                <td className="py-1.5 text-text-primary">
                  {entry.kind === "removed" ? (
                    <span className="text-text-secondary">Removed</span>
                  ) : (
                    <span className="break-words">{entry.after ?? EMPTY_VALUE}</span>
                  )}
                  {entry.note !== undefined ? (
                    <div className="mt-0.5 text-xs text-text-secondary">{entry.note}</div>
                  ) : null}
                  {entry.error !== undefined ? (
                    <InlineError className="mt-0.5">{entry.error}</InlineError>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SuggestedValue

function KitSuggestedValue({
  label,
  current,
  suggested,
  reason,
  source,
  onAccept,
  onReject,
  onEdit,
  stale,
  disabled,
  className,
  ...rest
}: PluginSuggestedValueProps) {
  const labelId = useId();
  const accept = fn(onAccept);
  const reject = fn(onReject);
  const edit = fn(onEdit);
  const inert = disabled === true;
  const outdated = stale === true;
  const name = nonEmpty(label);
  return (
    <div
      {...pickRootProps(rest)}
      role="group"
      aria-labelledby={name ? labelId : undefined}
      aria-label={name ? undefined : "Suggestion"}
      data-suggestion=""
      data-stale={outdated ? "" : undefined}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-[var(--radius-md)] border border-border-subtle bg-surface-panel p-2.5",
        str(className)
      )}
    >
      {name ? (
        <span id={labelId} className="text-xs text-text-secondary">
          {name}
        </span>
      ) : null}
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
        {hasContent(current) ? (
          <>
            <dt className="text-text-secondary">Current</dt>
            <dd className="min-w-0 break-words text-text-secondary">{node(current)}</dd>
          </>
        ) : null}
        <dt className="text-text-secondary">Suggested</dt>
        <dd className="min-w-0 break-words text-text-primary">{node(suggested)}</dd>
      </dl>
      {hasContent(reason) || hasContent(source) ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-text-secondary">
          {hasContent(reason) ? <span className="min-w-0">{node(reason)}</span> : null}
          {hasContent(source) ? <span className="shrink-0">{node(source)}</span> : null}
        </div>
      ) : null}
      {outdated ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-text-primary">
          <WarningGlyph aria-hidden="true" className={cn(GLYPH, "text-status-warning")} />
          Made from data that has since changed
        </span>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          disabled={inert || outdated || !accept}
          onClick={() => accept && runPluginAction("SuggestedValue onAccept", accept)}
        >
          Accept
        </Button>
        {edit ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={inert}
            onClick={() => runPluginAction("SuggestedValue onEdit", edit)}
          >
            Edit
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          disabled={inert || !reject}
          onClick={() => reject && runPluginAction("SuggestedValue onReject", reject)}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources

const CITATION_CLASS =
  "inline-flex h-4 min-w-4 items-center justify-center rounded-[var(--radius-xs)] bg-overlay-medium px-1 align-[0.15em] text-3xs leading-none font-medium tabular-nums text-text-primary";

function KitSourceCitation({
  index,
  title,
  locator,
  onOpen,
  preview,
  className,
  ...rest
}: PluginSourceCitationProps) {
  const overlayZ = useKitOverlayZClass();
  const number = typeof index === "number" && Number.isInteger(index) && index > 0 ? index : 0;
  const name = nonEmpty(title) ?? "Source";
  const where = nonEmpty(locator);
  const spoken = `Source ${number}: ${name}${where ? `, ${where}` : ""}`;
  const open = fn(onOpen);
  const marker = open ? (
    <button
      {...pickRootProps(rest)}
      type="button"
      aria-label={spoken}
      onClick={() => runPluginAction("SourceCitation onOpen", open)}
      data-citation={number}
      className={cn(
        CITATION_CLASS,
        "cursor-pointer transition-colors duration-150 ease-out hover:bg-overlay-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
        str(className)
      )}
    >
      {number}
    </button>
  ) : (
    <span
      {...pickRootProps(rest)}
      role="img"
      aria-label={spoken}
      tabIndex={0}
      data-citation={number}
      className={cn(
        CITATION_CLASS,
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
        str(className)
      )}
    >
      {number}
    </span>
  );
  if (hasContent(preview)) return <HoverCard content={node(preview)}>{marker}</HoverCard>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{marker}</TooltipTrigger>
      <TooltipContent side="top" className={overlayZ}>
        {where ? `${name} · ${where}` : name}
      </TooltipContent>
    </Tooltip>
  );
}

function readSources(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: {
    id: string;
    title: string;
    locator: string | undefined;
    excerpt: string | undefined;
    icon: unknown;
  }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    const title = nonEmpty(field(entry, "title"));
    if (id === undefined || title === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title,
      locator: nonEmpty(field(entry, "locator")),
      excerpt: nonEmpty(field(entry, "excerpt")),
      icon: field(entry, "icon"),
    });
  }
  return out;
}

function KitSourceList({
  sources,
  onOpen,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginSourceListProps) {
  const list = readSources(sources);
  const open = fn(onOpen);
  if (list.length === 0) return null;
  return (
    <ol
      {...pickRootProps(rest)}
      aria-label={nonEmpty(ariaLabel) ?? "Sources"}
      className={cn("flex min-w-0 flex-col gap-2", str(className))}
    >
      {list.map((source, index) => {
        const glyph = renderIconSource(source.icon ?? "file-text");
        return (
          <li key={source.id} data-source={source.id} className="flex min-w-0 gap-2 text-sm">
            <span aria-hidden="true" className={cn(CITATION_CLASS, "mt-0.5 shrink-0")}>
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1.5">
                {glyph ? (
                  <span className="flex shrink-0 text-text-secondary [&_svg]:h-3.5 [&_svg]:w-3.5">
                    {glyph}
                  </span>
                ) : null}
                {open ? (
                  <button
                    type="button"
                    onClick={() => runPluginAction("SourceList onOpen", () => open(source.id))}
                    className="min-w-0 truncate rounded-[var(--radius-xs)] text-left text-text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                  >
                    {source.title}
                  </button>
                ) : (
                  <span className="min-w-0 truncate text-text-primary">{source.title}</span>
                )}
                {source.locator ? (
                  <span className="shrink-0 text-xs text-text-secondary">{source.locator}</span>
                ) : null}
              </div>
              {source.excerpt ? (
                <blockquote className="line-clamp-3 border-l-2 border-border-subtle pl-2 text-xs text-text-secondary">
                  {source.excerpt}
                </blockquote>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// DecisionRequest

const DECISION_STATUSES = ["pending", "answered", "expired", "cancelled", "superseded"] as const;
const CHOICE_VARIANTS = ["default", "secondary", "destructive"] as const;

const CLOSED_WORD: Record<Exclude<PluginDecisionStatus, "pending" | "answered">, string> = {
  expired: "Expired: this can no longer be answered",
  cancelled: "Cancelled",
  superseded: "Replaced by a newer request",
};

function readChoices(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: { id: string; label: string; variant: (typeof CHOICE_VARIANTS)[number] }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    const label = nonEmpty(field(entry, "label"));
    if (id === undefined || label === undefined || seen.has(id)) continue;
    seen.add(id);
    // Omitted, a choice is secondary: only one marked `default` takes the
    // accent, the one load-bearing signal a region gets.
    out.push({
      id,
      label,
      variant: oneOf(field(entry, "variant"), CHOICE_VARIANTS) ?? "secondary",
    });
  }
  return out;
}

function KitDecisionRequest({
  title,
  description,
  consequence,
  children,
  choices,
  onRespond,
  status,
  answer,
  className,
  ...rest
}: PluginDecisionRequestProps) {
  const titleId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // A response that settles after the request moved on, or the card went,
  // changes nothing.
  const sessionRef = useRef(0);
  // Held from the press, before the plugin runs, so one press is one answer.
  const lockRef = useRef(false);
  // Whether focus was in the card, so closing it can keep the user's place
  // when the answer they pressed disappears under them.
  const focusWithinRef = useRef(false);
  const state = oneOf(status, DECISION_STATUSES) ?? "pending";
  useEffect(
    () => () => {
      sessionRef.current += 1;
    },
    []
  );
  useEffect(() => {
    sessionRef.current += 1;
    lockRef.current = false;
    setSending(null);
    setFailure(null);
    const section = sectionRef.current;
    if (state === "pending" || !section || !focusWithinRef.current) return;
    const active = section.ownerDocument.activeElement;
    if (active === null || active === section.ownerDocument.body) section.focus();
  }, [state]);
  const options = readChoices(choices);
  const respond = fn(onRespond);
  const open = state === "pending";
  const given = options.find((choice) => choice.id === answer);
  const send = (id: string) => {
    if (!respond || !open || lockRef.current) return;
    lockRef.current = true;
    setFailure(null);
    const session = ++sessionRef.current;
    let out: unknown;
    try {
      out = respond(id);
    } catch (thrown) {
      lockRef.current = false;
      reportPluginFault("DecisionRequest onRespond threw", thrown);
      setFailure(faultMessage(thrown, "Couldn't send the answer"));
      return;
    }
    if (!isThenable(out)) {
      lockRef.current = false;
      return;
    }
    setSending(id);
    settleThenable(out).then(
      () => {
        if (sessionRef.current !== session) return;
        lockRef.current = false;
        setSending(null);
      },
      (rejected: unknown) => {
        if (sessionRef.current !== session) return;
        lockRef.current = false;
        setSending(null);
        setFailure(faultMessage(rejected, "Couldn't send the answer"));
      }
    );
  };
  return (
    <section
      {...pickRootProps(rest)}
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-decision={state}
      onFocusCapture={() => {
        focusWithinRef.current = true;
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          focusWithinRef.current = false;
        }
      }}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-surface-panel p-3 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
        str(className)
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        {open ? <StateGlyph state="waiting" size={14} className="mt-0.5" /> : null}
        <h3 id={titleId} className="min-w-0 text-sm font-medium text-text-primary">
          {nonEmpty(title) ?? ""}
        </h3>
      </div>
      {hasContent(description) ? (
        <div className="text-sm text-text-secondary">{node(description)}</div>
      ) : null}
      {hasContent(consequence) ? (
        <div className="rounded-[var(--radius-sm)] bg-overlay-subtle px-2.5 py-1.5 text-xs text-text-primary">
          {node(consequence)}
        </div>
      ) : null}
      {open && hasContent(children) ? <div className="min-w-0">{node(children)}</div> : null}
      {failure ? <InlineError role="alert">{failure}</InlineError> : null}
      {open ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {options.map((choice) => (
            <Button
              key={choice.id}
              size="sm"
              variant={choice.variant === "secondary" ? "outline" : choice.variant}
              loading={sending === choice.id}
              disabled={sending !== null && sending !== choice.id}
              onClick={() => send(choice.id)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      ) : null}
      {/* Mounted (and not display:none) while pending, so the outcome is announced when it lands. */}
      <span
        role="status"
        className={
          open ? "sr-only" : "inline-flex items-center gap-1.5 text-xs text-text-secondary"
        }
      >
        {open ? null : state === "answered" ? (
          <>
            <CircleCheck aria-hidden="true" className={GLYPH} />
            {given ? `Answered: ${given.label}` : "Answered"}
          </>
        ) : (
          CLOSED_WORD[state]
        )}
      </span>
    </section>
  );
}

export const pluginKitAgentWork = {
  OperationStatus: KitOperationStatus,
  ConnectionCard: KitConnectionCard,
  ToolCallCard: KitToolCallCard,
  StructuredDiff: KitStructuredDiff,
  SuggestedValue: KitSuggestedValue,
  SourceCitation: KitSourceCitation,
  SourceList: KitSourceList,
  DecisionRequest: KitDecisionRequest,
};
