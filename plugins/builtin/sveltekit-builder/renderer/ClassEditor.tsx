import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
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
    <div className="flex flex-col gap-2">
      {tokens.length === 0 ? (
        <p className="text-xs text-text-secondary">No classes yet</p>
      ) : (
        <ClassChips tokens={tokens} editable={editable} onRemove={onRemove} />
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
}: {
  tokens: string[];
  editable: boolean;
  onRemove: (token: string) => void;
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
          <Badge size="sm" tone="neutral" className="max-w-full pr-0.5 text-text-primary">
            <span className="truncate font-mono">{token}</span>
            <button
              type="button"
              aria-label={`Remove ${token}`}
              data-class-remove=""
              disabled={!editable}
              onClick={() => onRemove(token)}
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-xs text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-soft hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary disabled:pointer-events-none disabled:opacity-50"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </Badge>
        </li>
      ))}
    </ul>
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
    const visible = open ? candidates.length : 0;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setOpen(true);
        // Reopening a closed list left `active` at -1, so the first Down only
        // revealed the options and a second was needed before Enter chose one.
        if (visible > 0) setActive((index) => (index < 0 ? 0 : (index + 1) % visible));
        return;
      case "ArrowUp":
        event.preventDefault();
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
    <div data-class-editor className="relative flex flex-col gap-1">
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
}: {
  id: string;
  candidates: Candidate[];
  active: number;
  onPick: (candidate: string) => void;
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
    </ul>
  );
}
