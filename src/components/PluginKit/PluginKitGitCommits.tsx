import { useRef } from "react";
import { ArrowUp, Check, Cloud, GitBranch, GitCommitHorizontal, Tag } from "lucide-react";
import type {
  PluginCommit,
  PluginCommitListProps,
  PluginCommitRef,
  PluginCommitRowProps,
} from "@shared/types/plugin-sdk-react";
import { Badge } from "@/components/ui/badge";
import { DiffStat } from "@/components/ui/DiffStat";
import { LIST_ROW_HOVER_CLASS } from "@/components/ui/paletteRowStyles";
import { SkeletonBone } from "@/components/ui/Skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { cn } from "@/lib/utils";
import { field, fn, hasContent, node, nonEmpty, oneOf, pickRootProps, str } from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";
import { toTimestamp } from "./kitTime";
import { FOCUS_RING, KitAvatar, KitTimeAgo, count, Dot, readPerson } from "./kitGitShared";
import { useRovingRows, roveFocus, roveKeyDown } from "./kitRovingRows";

// ---------------------------------------------------------------------------
// CommitRow and CommitList

interface CommitEntry {
  commit: PluginCommit;
  sha: string;
  subject: string;
  author?: { name: string; avatarUrl?: string; email?: string };
  date: number;
  refs: { name: string; kind: NonNullable<PluginCommitRef["kind"]> }[];
  additions?: number;
  deletions?: number;
  unpushed: boolean;
}

const REF_KINDS = ["branch", "tag", "remote", "head"] as const;

function readCommit(value: PluginCommit | undefined): CommitEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const sha = nonEmpty(field(value, "sha"));
  if (!sha) return null;
  const refsRaw = field(value, "refs");
  const refs = Array.isArray(refsRaw)
    ? refsRaw.flatMap((ref: unknown) => {
        if (typeof ref !== "object" || ref === null) return [];
        const name = nonEmpty(field(ref, "name"));
        if (!name) return [];
        return [{ name, kind: oneOf(field(ref, "kind"), REF_KINDS) ?? ("branch" as const) }];
      })
    : [];
  return {
    commit: value,
    sha,
    subject: str(field(value, "subject")) ?? "",
    author: readPerson(field(value, "author")),
    date: toTimestamp(field(value, "date")),
    refs,
    additions: count(field(value, "additions")),
    deletions: count(field(value, "deletions")),
    unpushed: field(value, "unpushed") === true,
  };
}

const REF_GLYPH = { branch: GitBranch, head: GitBranch, remote: Cloud, tag: Tag } as const;
const REF_WORD = { branch: "Branch", head: "Checked out", remote: "Remote branch", tag: "Tag" };
const MAX_REFS = 2;

function CommitRefs({ refs }: { refs: CommitEntry["refs"] }) {
  if (refs.length === 0) return null;
  const shown = refs.slice(0, MAX_REFS);
  const rest = refs.length - shown.length;
  return (
    // The subject outranks its decorations: the refs give way three times as
    // fast, each cut to an ellipsis with its full name in a tooltip.
    <span className="flex min-w-[6ch] shrink-[3] items-center gap-1">
      {shown.map((ref) => {
        const Glyph = REF_GLYPH[ref.kind];
        return (
          <Badge
            key={`${ref.kind}:${ref.name}`}
            size="xs"
            tone="outline"
            data-ref-kind={ref.kind}
            aria-label={`${REF_WORD[ref.kind]} ${ref.name}`}
            className={cn(
              "max-w-[140px] shrink font-mono",
              // A tag cut to "v0…" names no version; it keeps room for one.
              ref.kind === "tag" ? "min-w-[12ch]" : "min-w-0",
              ref.kind === "head" && "text-text-primary"
            )}
          >
            <Glyph aria-hidden="true" />
            <TruncatedTooltip content={ref.name} focusable={false}>
              <span className="min-w-0 truncate">{ref.name}</span>
            </TruncatedTooltip>
          </Badge>
        );
      })}
      {rest > 0 ? (
        <span
          className="shrink-0 text-2xs text-text-secondary tabular-nums"
          aria-label={`${rest} more: ${refs
            .slice(MAX_REFS)
            .map((ref) => ref.name)
            .join(", ")}`}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

function ShaButton({ sha, length }: { sha: string; length: number }) {
  const overlayZ = useKitOverlayZClass();
  const { copied, copy } = useCopyWithFeedback();
  const short = sha.slice(0, length);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-kit-commit-sha=""
          data-kit-rove=""
          onClick={(event) => {
            event.stopPropagation();
            void copy(sha);
          }}
          aria-label={`Copy hash ${short}`}
          className={cn(
            // 24px tall to the pointer without growing the metadata line.
            "relative after:absolute after:-inset-y-1 after:inset-x-0 after:content-['']",
            "ml-auto flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-1 font-mono text-xs text-text-secondary transition-colors duration-150 ease-out hover:text-text-primary",
            FOCUS_RING,
            copied && "text-text-primary"
          )}
        >
          {copied ? <Check aria-hidden="true" className="size-3" /> : null}
          <span>{short}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className={overlayZ}>
        {copied ? "Copied" : "Copy hash"}
      </TooltipContent>
    </Tooltip>
  );
}

const COMMIT_ROW_CLASS = "flex items-start gap-2 px-3 py-2.5";

function CommitSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-kit-commit-skeleton=""
      className={cn(COMMIT_ROW_CLASS, "h-[58px] box-border")}
    >
      <SkeletonBone className="mt-0.5 size-4 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1">
        <SkeletonBone className="h-5 w-3/4 rounded-[var(--radius-sm)]" />
        <div className="mt-0.5 flex items-center gap-1.5">
          <SkeletonBone className="h-4 w-20 rounded-[var(--radius-sm)]" />
          <SkeletonBone className="h-4 w-12 rounded-[var(--radius-sm)]" />
          <SkeletonBone className="ml-auto h-4 w-14 rounded-[var(--radius-sm)]" />
        </div>
      </div>
    </div>
  );
}

function CommitBody({
  entry,
  onActivate,
  shaLength,
}: {
  entry: CommitEntry;
  onActivate?: (commit: PluginCommit) => void;
  shaLength: number;
}) {
  const overlayZ = useKitOverlayZClass();
  const subjectClass = "min-w-0 truncate text-sm font-medium text-text-primary";
  const subject = onActivate ? (
    <button
      type="button"
      data-kit-commit-subject=""
      data-kit-rove=""
      onClick={() => onActivate(entry.commit)}
      className={cn(
        subjectClass,
        "cursor-pointer rounded-sm text-left hover:underline",
        FOCUS_RING
      )}
    >
      {entry.subject}
    </button>
  ) : (
    <p className={cn(subjectClass, "m-0")}>{entry.subject}</p>
  );
  const dated = !Number.isNaN(entry.date);
  return (
    <>
      {entry.author ? (
        <KitAvatar
          name={entry.author.name}
          src={entry.author.avatarUrl}
          size="xs"
          decorative
          className="mt-0.5"
        />
      ) : (
        <GitCommitHorizontal
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-text-secondary"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <TruncatedTooltip content={entry.subject} contentClassName={overlayZ}>
            {subject}
          </TruncatedTooltip>
          <CommitRefs refs={entry.refs} />
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
          {/* Like the forge row's: one line whose items drop out whole, with
              their separators, when the row is too narrow. "Not pushed" leads
              and the hash keeps its own place at the end. */}
          <div
            data-kit-commit-meta=""
            className="flex h-4 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 overflow-hidden leading-4"
          >
            {entry.unpushed ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-text-primary">
                <ArrowUp aria-hidden="true" className="size-3" />
                Not pushed
              </span>
            ) : null}
            {entry.author ? (
              // Placed at 6ch and grown into the room left, so the author
              // truncates before the age and churn are lost.
              <span className="inline-flex min-w-0 max-w-max shrink-0 grow basis-[6ch] items-center gap-1.5">
                {entry.unpushed ? <Dot /> : null}
                {entry.author.email ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="min-w-0 truncate">{entry.author.name}</span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className={overlayZ}>
                      {entry.author.email}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <span className="min-w-0 truncate">{entry.author.name}</span>
                )}
              </span>
            ) : null}
            {dated ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                {entry.unpushed || entry.author ? <Dot /> : null}
                <KitTimeAgo value={entry.date} />
              </span>
            ) : null}
            {entry.additions || entry.deletions ? (
              <span className="inline-flex shrink-0 items-center gap-1.5">
                {entry.unpushed || entry.author || dated ? <Dot /> : null}
                <DiffStat insertions={entry.additions} deletions={entry.deletions} />
              </span>
            ) : null}
          </div>
          <ShaButton sha={entry.sha} length={shaLength} />
        </div>
      </div>
    </>
  );
}

function shaLengthOf(value: unknown): number {
  const length = count(value);
  return length !== undefined && length >= 4 && length <= 40 ? length : 7;
}

export function KitCommitRow({
  commit,
  skeleton,
  onActivate,
  shaLength,
  className,
  ...rest
}: PluginCommitRowProps) {
  if (skeleton === true) {
    return (
      <div {...pickRootProps(rest)} className={str(className)}>
        <CommitSkeleton />
      </div>
    );
  }
  const entry = readCommit(commit);
  if (!entry) return null;
  return (
    <div
      {...pickRootProps(rest)}
      data-kit-commit={entry.sha}
      className={cn(
        COMMIT_ROW_CLASS,
        "rounded-[var(--radius-md)]",
        LIST_ROW_HOVER_CLASS,
        str(className)
      )}
    >
      <CommitBody entry={entry} onActivate={fn(onActivate)} shaLength={shaLengthOf(shaLength)} />
    </div>
  );
}

export function KitCommitList({
  commits,
  loading,
  onActivate,
  shaLength,
  empty,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginCommitListProps) {
  const entries = Array.isArray(commits)
    ? commits.flatMap((raw: PluginCommit) => {
        const entry = readCommit(raw);
        return entry ? [entry] : [];
      })
    : [];
  const skeletons =
    loading === true ? 3 : count(loading) !== undefined ? Math.min(count(loading) ?? 0, 20) : 0;
  const activate = fn(onActivate);
  const length = shaLengthOf(shaLength);
  const listRef = useRef<HTMLUListElement>(null);
  useRovingRows(listRef);
  if (entries.length === 0 && skeletons === 0) {
    return hasContent(empty) ? (
      <div
        {...pickRootProps(rest)}
        className={cn("px-3 py-2 text-xs text-text-secondary", str(className))}
      >
        {node(empty)}
      </div>
    ) : null;
  }
  const seen = new Map<string, number>();
  return (
    <div
      {...pickRootProps(rest)}
      data-kit-commit-list=""
      className={cn("flex min-w-0 flex-col", str(className))}
    >
      <ul
        ref={listRef}
        aria-label={nonEmpty(ariaLabel)}
        aria-busy={skeletons > 0 ? true : undefined}
        onFocus={roveFocus}
        onKeyDown={roveKeyDown}
        className="m-0 flex list-none flex-col p-0"
      >
        {entries.map((entry) => {
          // A list repeats a hash only by mistake; the second copy still draws.
          const nth = (seen.get(entry.sha) ?? 0) + 1;
          seen.set(entry.sha, nth);
          const key = nth === 1 ? entry.sha : `${entry.sha}:${nth}`;
          return (
            <li
              key={key}
              data-kit-rove-row=""
              data-kit-commit={entry.sha}
              className={cn(COMMIT_ROW_CLASS, "rounded-[var(--radius-md)]", LIST_ROW_HOVER_CLASS)}
            >
              <CommitBody entry={entry} onActivate={activate} shaLength={length} />
            </li>
          );
        })}
        {Array.from({ length: skeletons }, (_, index) => (
          <li key={`skeleton:${index}`} aria-hidden="true">
            <CommitSkeleton />
          </li>
        ))}
      </ul>
      {skeletons > 0 ? (
        <span role="status" className="sr-only">
          Loading commits
        </span>
      ) : null}
    </div>
  );
}
