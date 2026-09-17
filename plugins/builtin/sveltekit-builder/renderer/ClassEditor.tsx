import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WaitingRow } from "./WaitingRow.js";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { splitClassTokens, type ClassCompletion } from "./inspectorController.js";

const COMPLETION_DEBOUNCE_MS = 120;
const MAX_VISIBLE_CANDIDATES = 8;

interface Candidate {
  candidate: string;
  css: string;
}

/**
 * The element's class tokens as removable chips, plus an add field completed
 * from the project's own Tailwind vocabulary. Suggestions only suggest: a
 * token outside them is said to be unlisted and written as typed, and any
 * refusal comes from main, by name.
 */
export function ClassEditor({
  tokens,
  editable,
  saving,
  onAdd,
  onRemove,
  complete,
}: {
  tokens: string[];
  editable: boolean;
  saving: boolean;
  onAdd: (tokens: string[]) => Promise<boolean>;
  onRemove: (token: string) => void;
  complete: (query: string) => Promise<ClassCompletion>;
}) {
  return (
    // The marker spans BOTH halves: the Backspace step walks from the input to
    // the chips, and a root that contains only the input finds nothing.
    <div data-class-editor className="flex flex-col gap-2">
      {tokens.length === 0 ? (
        <p className="text-xs text-text-secondary">No classes yet</p>
      ) : (
        <ClassChips tokens={tokens} editable={editable} onRemove={onRemove} complete={complete} />
      )}
      <ClassAddField
        tokens={tokens}
        editable={editable}
        saving={saving}
        onAdd={onAdd}
        complete={complete}
      />
    </div>
  );
}

function ClassChips({
  tokens,
  editable,
  onRemove,
  complete,
}: {
  tokens: string[];
  editable: boolean;
  onRemove: (token: string) => void;
  complete: (query: string) => Promise<ClassCompletion>;
}) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Classes">
      {tokens.map((token) => (
        <li key={token} className="max-w-full">
          {/* `Badge` rather than a hand-rolled box: the drawer already shows
              badges for the element tag and for capability labels, and three
              near-identical chips built three ways is how a panel stops looking
              like one system. The remove control stays a real button with its
              own name and focus ring. */}
          <Badge size="sm" tone="neutral" className="max-w-full pl-0 pr-0.5 text-text-primary">
            <ClassInspector token={token} complete={complete} />
            <button
              type="button"
              aria-label={`Remove ${token}`}
              data-class-remove=""
              disabled={!editable}
              onClick={() => onRemove(token)}
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-xs text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-raised hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary disabled:pointer-events-none disabled:opacity-50"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </Badge>
        </li>
      ))}
    </ul>
  );
}

type Inspection =
  | { status: "loading" }
  | { status: "declared"; css: string }
  | { status: "none" }
  | { status: "unavailable"; reason: string };

/**
 * What a class does, on request. A token like `bg-indigo-600` carried nothing
 * but its name and a remove control; the reference class lets you look at a
 * style before you decide about it. The declaration comes from main — the
 * project's own Tailwind compiling this exact token — never from a guess at
 * what a Tailwind-looking name usually means, and a token the project
 * generates nothing for says so, which is itself worth knowing before an edit.
 * Fetched once per token, on first open.
 */
function ClassInspector({
  token,
  complete,
}: {
  token: string;
  complete: (query: string) => Promise<ClassCompletion>;
}) {
  const [open, setOpen] = useState(false);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  // The request's lifetime is the token's, not the loading state's. An effect
  // that depended on `inspection` re-ran its own cleanup the moment it set
  // "loading", cancelled itself, and left the popover spinning forever.
  const requested = useRef(false);
  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    let cancelled = false;
    setInspection({ status: "loading" });
    void complete(token).then((result) => {
      if (cancelled) return;
      if (result.status !== "ok") {
        setInspection({ status: "unavailable", reason: result.reason });
        return;
      }
      const exact = result.candidates.find((candidate) => candidate.candidate === token);
      setInspection(exact ? { status: "declared", css: exact.css } : { status: "none" });
    });
    return () => {
      // Only an unmount cancels — the token's declaration does not change while
      // the chip is on screen, so one answer serves every open.
      cancelled = true;
      requested.current = false;
    };
    // `open` is deliberately the only trigger: `complete` is stable per controller.
  }, [open, token, complete]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Inspect ${token}`}
          className="min-w-0 truncate rounded-xs py-px pl-1.5 pr-0.5 font-mono text-left transition-colors duration-150 ease-out hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
        >
          {token}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[300px] p-2.5">
        <p className="mb-1.5 truncate font-mono text-xs text-text-primary" title={token}>
          {token}
        </p>
        {inspection === null || inspection.status === "loading" ? (
          <WaitingRow label="Looking up its declaration" />
        ) : inspection.status === "declared" ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-3xs leading-relaxed text-text-secondary">
            {inspection.css}
          </pre>
        ) : inspection.status === "none" ? (
          <p className="text-xs text-text-secondary">
            This project's Tailwind generates no CSS for it. It is still written to the source as
            typed.
          </p>
        ) : (
          <p className="text-xs text-text-secondary">{inspection.reason}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ClassAddField({
  tokens,
  editable,
  saving,
  onAdd,
  complete,
}: {
  tokens: string[];
  editable: boolean;
  saving: boolean;
  onAdd: (tokens: string[]) => Promise<boolean>;
  complete: (query: string) => Promise<ClassCompletion>;
}) {
  const listboxId = useId();
  const errorId = useId();
  const [query, setQuery] = useState("");
  // Suggestions remember the query they answer, so a slow reply for an older
  // query can never be what Enter picks.
  const [completion, setCompletion] = useState<{
    query: string;
    candidates: Candidate[];
    unavailable: string | null;
    exact: boolean;
  } | null>(null);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const trimmed = query.trim();
  useEffect(() => {
    const request = ++requestRef.current;
    if (trimmed.length === 0) return;
    const timer = setTimeout(() => {
      void complete(trimmed).then((result) => {
        if (request !== requestRef.current) return;
        setCompletion(
          result.status === "ok"
            ? {
                query: trimmed,
                candidates: result.candidates.slice(0, MAX_VISIBLE_CANDIDATES),
                unavailable: null,
                exact: result.candidates.some((c) => c.candidate === trimmed),
              }
            : { query: trimmed, candidates: [], unavailable: result.reason, exact: false }
        );
        setActive(-1);
      });
    }, COMPLETION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed, complete]);

  const current = completion?.query === trimmed ? completion : null;
  const candidates = current?.candidates ?? [];

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const submit = async (value: string) => {
    const next = splitClassTokens(value);
    if (next.length === 0 || !editable || saving) return;
    const duplicate = next.find((token) => tokens.includes(token));
    if (duplicate) {
      setError(`${duplicate} is already on this element`);
      return;
    }
    // Suggestions are a bounded search, not a validity oracle, and nothing here
    // or in main asks Tailwind: an unlisted token is written exactly as typed.
    setError(null);
    close();
    const saved = await onAdd(next);
    // A refused write keeps what was typed, so it can be corrected and retried.
    if (saved) setQuery("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    // How many options this keystroke will be acting on. Deliberately NOT
    // `open ? candidates.length : 0`: Down both opens the list and moves within
    // it, so reading the pre-keystroke `open` made the first Down after an
    // Escape a no-op that left `active` at -1 — and Enter then submitted the
    // raw query instead of the suggestion the user thought was highlighted.
    const visible = candidates.length;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setOpen(true);
        if (visible > 0) setActive((index) => (index < 0 ? 0 : (index + 1) % visible));
        return;
      case "ArrowUp":
        event.preventDefault();
        setOpen(true);
        if (visible > 0) setActive((index) => (index <= 0 ? visible - 1 : index - 1));
        return;
      case "Enter": {
        // A composing IME sends Enter to accept its candidate. Writing the
        // user's source file on that keystroke is the wrong reading of it.
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        const picked = open && active >= 0 ? candidates[active] : undefined;
        void submit(picked ? picked.candidate : query);
        return;
      }
      case "Backspace": {
        if (query !== "") return;
        // APG: an empty buffer sends Backspace to the preceding token. It FOCUSES
        // the remove control rather than removing it — this writes to the user's
        // source, so the second press is theirs to make deliberately.
        const removals = event.currentTarget
          .closest("[data-class-editor]")
          ?.querySelectorAll<HTMLButtonElement>("button[data-class-remove]:not([disabled])");
        const last = removals?.[removals.length - 1];
        if (!last) return;
        event.preventDefault();
        close();
        last.focus();
        return;
      }
      case "Escape":
        event.preventDefault();
        if (open && candidates.length > 0) {
          close();
        } else {
          setQuery("");
          setError(null);
        }
        return;
    }
  };

  const showList = open && trimmed.length > 0 && candidates.length > 0;
  const activeId = showList && active >= 0 ? `${listboxId}-${active}` : undefined;

  // Focus stays in the input, so nothing scrolls the active row into view on its
  // own — the list is bounded now, and arrowing past its edge would otherwise
  // move a highlight the user cannot see.
  useEffect(() => {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  return (
    <div className="relative flex flex-col gap-1">
      <Popover open={showList}>
        <PopoverAnchor asChild>
          <Input
            density="compact"
            role="combobox"
            aria-label="Add a class"
            aria-expanded={showList}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            aria-describedby={error ? errorId : undefined}
            placeholder="Add a class"
            // Enabled placeholder text is text: the shared token is a quieter
            // tier the theme system calibrates for light themes, and on the
            // dark ones it measured ~2.7:1. This surface steps it up.
            className="placeholder:text-text-secondary"
            spellCheck={false}
            autoComplete="off"
            value={query}
            invalid={error !== null}
            disabled={!editable && !saving}
            readOnly={saving}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(-1);
              setError(null);
              setOpen(true);
            }}
            onKeyDown={onKeyDown}
            onBlur={close}
          />
        </PopoverAnchor>
        {/* Anchored and bounded rather than in normal flow. In flow it pushed
            the composer down on every keystroke and ran past the bottom of the
            drawer with no sign that more suggestions existed. Radix flips it
            upward when there is no room below. */}
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-[var(--radix-popover-trigger-width)] p-0"
          // Focus stays in the field: the input owns the listbox through
          // aria-activedescendant, so the popover must not take it.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <CandidateList
            id={listboxId}
            candidates={candidates}
            active={active}
            onPick={(candidate) => void submit(candidate)}
            onActivate={setActive}
          />
        </PopoverContent>
      </Popover>
      {error ? (
        <p id={errorId} className="text-xs text-status-error">
          {error}
        </p>
      ) : current?.unavailable ? (
        <p className="text-xs text-text-secondary">No suggestions: {current.unavailable}</p>
      ) : current && !current.exact && !showList ? (
        <p className="text-xs text-text-secondary">
          Not in the suggestion list — it'll be written as typed
        </p>
      ) : null}
    </div>
  );
}

function CandidateList({
  id,
  candidates,
  active,
  onPick,
  onActivate,
}: {
  id: string;
  candidates: Candidate[];
  active: number;
  onPick: (candidate: string) => void;
  onActivate: (index: number) => void;
}) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Class suggestions"
      className="flex max-h-[min(280px,var(--radix-popover-content-available-height))] flex-col overflow-y-auto p-1"
    >
      {candidates.map((candidate, index) => (
        <li
          key={candidate.candidate}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === active}
          // Keep focus in the field: a mousedown here would blur it and close the list.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onActivate(index)}
          onClick={() => onPick(candidate.candidate)}
          className={cn(
            PALETTE_ROW_CLASS,
            "flex cursor-pointer items-baseline gap-2 rounded-sm px-2 py-1 text-xs text-text-primary hover:bg-overlay-subtle"
          )}
        >
          <span className="shrink-0 font-mono">{candidate.candidate}</span>
          <span className="min-w-0 truncate font-mono text-3xs text-text-secondary">
            {candidate.css}
          </span>
        </li>
      ))}
      {active >= 0 && candidates[active] ? (
        <li
          aria-hidden="true"
          className="mt-1 border-t border-border-subtle px-2 pb-1 pt-1.5 font-mono text-3xs leading-relaxed text-text-secondary"
        >
          <span className="block max-h-24 overflow-y-auto whitespace-pre-wrap break-all">
            {candidates[active].css}
          </span>
        </li>
      ) : null}
    </ul>
  );
}
