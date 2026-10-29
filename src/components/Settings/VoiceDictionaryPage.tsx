import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DismissButton } from "@/components/ui/DismissButton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SearchField } from "@/components/ui/SearchField";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { SettingsSection } from "./SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow, SettingsRowActions } from "./SettingsGroup";
import { useSettingsSubpage } from "./SettingsSubpage";
import { HeardAsMovePrompt } from "./HeardAsMovePrompt";
import {
  MAX_DICTIONARY_IMPORT_TERMS,
  parseDictionaryInput,
  parseHeardAsField,
  summarizeDictionaryAdds,
  type DictionaryAddOutcome,
} from "./voiceDictionaryImport";
import { pluralNoun, pluralize } from "@/lib/pluralize";
import { describeHeardAsConflicts } from "@/lib/heardAsConflictCopy";
import { MAX_DICTIONARY_KEYTERMS } from "@shared/config/voiceKeyterms";
import {
  MAX_DICTIONARY_HEARD_AS,
  MAX_DICTIONARY_TERM_LENGTH,
  findHeardAsConflicts,
  heardAsOwners,
} from "@shared/utils/voiceDictionary";
import type {
  HeardAsConflict,
  SuggestedDictionaryEntry,
  VoiceDictionaryChange,
  VoiceDictionaryEntry,
  VoiceDictionaryState,
} from "@shared/types";

type ChangeDictionary = (
  label: string,
  run: () => Promise<VoiceDictionaryState>,
  onSaved?: () => void
) => Promise<boolean>;

interface VoiceDictionaryPageProps {
  entries: VoiceDictionaryEntry[];
  suggestions: SuggestedDictionaryEntry[];
  onChange: ChangeDictionary;
  /** The failure banner for the dictionary, when a change did not go through. */
  failure: ReactNode;
  onBack: (viaKeyboard?: boolean) => void;
}

const fold = (value: string) => value.toLowerCase();

/** Left-out heard-as phrases a notice names before it only counts the rest. */
const MAX_LISTED_CONFLICTS = 3;

/** A hand add waiting on whether to move the phrases another term has, for the draft as it was. */
interface PendingMove {
  text: string;
  term: string;
  conflicts: HeardAsConflict[];
}

/** The clauses of the add notice, one per kind of change, in the order they matter. */
function describeDictionaryAdds({
  added,
  extended,
  addedHeardAs,
  unchanged,
}: DictionaryAddOutcome): string[] {
  const parts: string[] = [];
  if (added > 0) parts.push(`Added ${pluralize(added, "term")}`);
  if (addedHeardAs > 0) {
    parts.push(
      `Added ${pluralize(addedHeardAs, "heard-as phrase")} to ${pluralize(extended, "existing term")}`
    );
  }
  if (unchanged > 0) {
    parts.push(`${pluralize(unchanged, "term was", "terms were")} already in the dictionary`);
  }
  return parts;
}

export function sourceLabel(entry: VoiceDictionaryEntry): string {
  if (entry.source === "learned") {
    return entry.heardAs[0] ? `Learned from "${entry.heardAs[0]}"` : "Learned from a correction";
  }
  return entry.source === "imported" ? "Imported" : "Added by hand";
}

export function VoiceDictionaryPage({
  entries,
  suggestions,
  onChange,
  failure,
  onBack,
}: VoiceDictionaryPageProps) {
  const headerOwnsBack = useSettingsSubpage({
    title: "Custom dictionary",
    parentLabel: "Voice input",
    onBack,
  });
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [removed, setRemoved] = useState<VoiceDictionaryEntry[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [moving, setMoving] = useState<PendingMove | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(
    () =>
      [...entries].sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: "base" })),
    [entries]
  );
  const needle = fold(query.trim());
  const visible = needle
    ? sorted.filter(
        (entry) =>
          fold(entry.term).includes(needle) || entry.heardAs.some((h) => fold(h).includes(needle))
      )
    : sorted;
  const owners = useMemo(() => heardAsOwners(entries), [entries]);
  const rules = entries.reduce((total, entry) => total + entry.heardAs.length, 0);
  const lastRemoved = removed[removed.length - 1];
  // Editing the draft drops the question: a move applies to the draft it was asked about.
  const pendingMove = moving !== null && moving.text === draft ? moving : null;

  const addDraft = (move = false) => {
    const { terms, skipped, overflowTerms, overflowHeardAs } = parseDictionaryInput(draft);
    if (terms.length === 0) {
      if (skipped > 0) {
        setNotice(
          `Nothing added: ${pluralNoun(skipped, "that entry is", "those entries are")} longer than ${MAX_DICTIONARY_TERM_LENGTH} characters`
        );
      }
      return;
    }
    const imported = terms.length > 1 || skipped + overflowTerms + overflowHeardAs > 0;
    const text = draft;
    // A phrase typed for one term that another already has is a question; an import reports it.
    if (!imported && !move) {
      const conflicts = findHeardAsConflicts(owners, terms[0]!.term, terms[0]!.heardAs);
      if (conflicts.length > 0) {
        setMoving({ text, term: terms[0]!.term, conflicts });
        return;
      }
    }
    const before = entries;
    const left: HeardAsConflict[] = [];
    let outcome: DictionaryAddOutcome | undefined;
    draftRef.current?.focus();
    setRemoved([]);
    setMoving(null);
    void onChange(
      "The dictionary",
      async () => {
        let state: VoiceDictionaryChange | undefined;
        for (const { term, heardAs } of terms) {
          state = await window.electron.voiceDictionary.add({
            term,
            heardAs,
            ...(imported
              ? { source: "imported" as const, heardAsConflict: "skip" as const }
              : move
                ? { heardAsConflict: "move" as const }
                : {}),
          });
          left.push(...state.conflicts);
        }
        // Counted from what main kept, not from what was pasted: a term it
        // already had writes nothing (#15233).
        outcome = summarizeDictionaryAdds(terms, before, state!.dictionary);
        return state!;
      },
      () => {
        // Main refused a phrase another term took since this page last saw it: ask the same question.
        if (!imported && left.length > 0) {
          setMoving({ text, term: terms[0]!.term, conflicts: left });
          return;
        }
        // Keep anything typed while the add was in flight.
        setDraft((current) => (current === text ? "" : current));
        const parts = outcome ? describeDictionaryAdds(outcome) : [];
        if (left.length > 0) {
          parts.push(
            `Left out ${pluralize(left.length, "heard-as phrase")}: ${describeHeardAsConflicts(left, MAX_LISTED_CONFLICTS)}`
          );
        }
        if (skipped > 0) {
          parts.push(
            `Skipped ${pluralize(skipped, "entry", "entries")} over ${MAX_DICTIONARY_TERM_LENGTH} characters`
          );
        }
        if (overflowTerms > 0) {
          parts.push(
            `Left out ${pluralize(overflowTerms, "term")} past the first ${MAX_DICTIONARY_IMPORT_TERMS}`
          );
        }
        if (overflowHeardAs > 0) {
          parts.push(
            `Left out ${pluralize(overflowHeardAs, "heard-as phrase")} past the first ${MAX_DICTIONARY_HEARD_AS} for a term`
          );
        }
        setNotice(parts.join(". "));
      }
    );
  };

  const remove = (entry: VoiceDictionaryEntry) => {
    draftRef.current?.focus();
    void onChange(
      "The dictionary",
      () => window.electron.voiceDictionary.remove({ term: entry.term }),
      () => {
        setNotice(null);
        setRemoved((current) => [...current, entry]);
      }
    );
  };

  const undoRemove = () => {
    if (!lastRemoved) return;
    const entry = lastRemoved;
    let left: HeardAsConflict[] = [];
    void onChange(
      "The dictionary",
      async () => {
        // A phrase another term took since stays with it.
        const result = await window.electron.voiceDictionary.add({
          term: entry.term,
          heardAs: entry.heardAs,
          source: entry.source,
          addedAt: entry.addedAt,
          heardAsConflict: "skip",
        });
        left = result.conflicts;
        return result;
      },
      () => {
        draftRef.current?.focus();
        setRemoved((current) => current.filter((e) => e !== entry));
        if (left.length > 0) {
          setNotice(
            `Restored ${entry.term} without ${pluralize(left.length, "heard-as phrase")}: ${describeHeardAsConflicts(left, MAX_LISTED_CONFLICTS)}`
          );
        }
      }
    );
  };

  const acceptSuggestion = (suggestion: SuggestedDictionaryEntry) => {
    draftRef.current?.focus();
    let left: HeardAsConflict[] = [];
    void onChange(
      "The dictionary",
      async () => {
        const result = await window.electron.voiceDictionary.acceptSuggestion({
          word: suggestion.word,
        });
        left = result.conflicts;
        return result;
      },
      () => {
        if (left.length > 0) {
          setNotice(`Added ${suggestion.word}, but ${describeHeardAsConflicts(left)}`);
        }
      }
    );
  };

  const cancelMove = () => {
    setMoving(null);
    draftRef.current?.focus();
  };

  // The edited row may have left the search results; the add field is the fallback.
  const refocusEdit = (term: string) =>
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLElement>("[data-edit-term]");
      const match = [...(buttons ?? [])].find((b) => fold(b.dataset.editTerm ?? "") === fold(term));
      (match ?? draftRef.current)?.focus();
    });

  return (
    <div className="space-y-8">
      {!headerOwnsBack && (
        <div>
          <Button variant="ghost" size="sm" onClick={(event) => onBack(event.detail === 0)}>
            <ChevronLeft aria-hidden="true" />
            Voice input
          </Button>
        </div>
      )}

      {failure}

      {suggestions.length > 0 && (
        <SettingsSection
          title="Suggested from corrections"
          description="Words you fixed by hand before sending. Add one to teach the dictionary what it heard"
        >
          <SettingsGroup>
            {suggestions.map((suggestion) => (
              <SettingsRow
                key={suggestion.word}
                label={suggestion.word}
                description={
                  <>
                    {suggestion.utterance
                      ? `Heard as "${suggestion.utterance}"`
                      : "Typed over a mishearing"}
                    {suggestion.frequency > 1 ? ` · ${suggestion.frequency} times` : ""}
                    {" · "}
                    <TimeAgo timestamp={suggestion.suggestedAt} verbose />
                  </>
                }
                control={
                  <SettingsRowActions>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => acceptSuggestion(suggestion)}
                      aria-label={`Add ${suggestion.word} to dictionary`}
                    >
                      <Plus aria-hidden="true" />
                      Add
                    </Button>
                    <DismissButton
                      onClick={() => {
                        draftRef.current?.focus();
                        void onChange("The suggestion list", () =>
                          window.electron.voiceDictionary.dismissSuggestion({
                            word: suggestion.word,
                          })
                        );
                      }}
                      aria-label={`Dismiss ${suggestion.word}`}
                    />
                  </SettingsRowActions>
                }
              />
            ))}
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection
        title="Terms"
        description={`Sent to the transcription service so it recognises your product names and jargon. Up to the newest ${MAX_DICTIONARY_KEYTERMS} go with each dictation`}
      >
        <SettingsGroup>
          <SettingsRow
            id="voice-dictionary-add"
            label="Add terms"
            description="One per line or separated by commas. Write heard -> Term to teach a mishearing"
            layout="stacked"
            control={({ labelId, descriptionId }) => (
              <div className="space-y-2">
                <Textarea
                  ref={draftRef}
                  variant="code"
                  rows={2}
                  value={draft}
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  placeholder={"Zustand, Vite\nzoo stand -> Zustand"}
                  spellCheck={false}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      addDraft();
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => addDraft()}
                  disabled={!draft.trim()}
                >
                  <Plus aria-hidden="true" />
                  Add
                </Button>
              </div>
            )}
          />

          {entries.length > 0 && (
            <div className="px-4 py-3">
              <SearchField
                size="compact"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onClear={() => setQuery("")}
                placeholder="Search terms and heard-as phrases"
                aria-label="Search the dictionary"
              />
            </div>
          )}

          <div role="status" className="empty:hidden">
            {pendingMove ? (
              <div className="px-4 py-2">
                <HeardAsMovePrompt
                  term={pendingMove.term}
                  conflicts={pendingMove.conflicts}
                  onMove={() => addDraft(true)}
                  onCancel={cancelMove}
                />
              </div>
            ) : lastRemoved ? (
              <div className="flex items-center gap-4 px-4 py-2 text-sm text-text-secondary">
                <span className="min-w-0 flex-1 truncate">Removed {lastRemoved.term}</span>
                <Button size="sm" variant="outline" onClick={undoRemove}>
                  Undo
                </Button>
              </div>
            ) : notice ? (
              <p className="px-4 py-2 text-sm text-text-secondary">{notice}</p>
            ) : null}
          </div>

          <div ref={listRef} className="divide-y divide-border-subtle empty:hidden">
            {entries.length === 0 ? (
              <SettingsEmptyRow>
                Add product names, APIs or jargon the transcription keeps getting wrong
              </SettingsEmptyRow>
            ) : visible.length === 0 ? (
              <SettingsEmptyRow>No terms match “{query.trim()}”</SettingsEmptyRow>
            ) : (
              visible.map((entry) =>
                editing !== null && fold(editing) === fold(entry.term) ? (
                  <EntryEditor
                    key={entry.term}
                    entry={entry}
                    others={entries.filter((e) => e !== entry)}
                    owners={owners}
                    onCancel={() => {
                      setEditing(null);
                      refocusEdit(entry.term);
                    }}
                    onSave={(term, heardAs, heardAsConflict) => {
                      let left: HeardAsConflict[] = [];
                      return onChange(
                        "The dictionary",
                        async () => {
                          const result = await window.electron.voiceDictionary.update({
                            term: entry.term,
                            changes: { term, heardAs, ...(heardAsConflict && { heardAsConflict }) },
                          });
                          left = result.conflicts;
                          return result;
                        },
                        () => {
                          // Refused for a phrase another term took meanwhile: the editor asks.
                          if (left.length > 0) return;
                          // Another row may have been opened while this saved.
                          setEditing((current) =>
                            current !== null && fold(current) === fold(entry.term) ? null : current
                          );
                          refocusEdit(term);
                        }
                      ).then((saved) => (saved ? left : []));
                    }}
                  />
                ) : (
                  <SettingsRow
                    key={entry.term}
                    label={entry.term}
                    description={
                      <>
                        {entry.heardAs.length > 0 && (
                          <span className="block">
                            Heard as {entry.heardAs.map((h) => `"${h}"`).join(", ")}
                          </span>
                        )}
                        <ShadowedHeardAs owners={owners} entry={entry} />
                        <span className="block">
                          {sourceLabel(entry)} · <TimeAgo timestamp={entry.addedAt} verbose />
                        </span>
                      </>
                    }
                    control={
                      <SettingsRowActions>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          data-edit-term={entry.term}
                          onClick={() => setEditing(entry.term)}
                          aria-label={`Edit ${entry.term}`}
                        >
                          <Pencil aria-hidden="true" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost-danger"
                          onClick={() => remove(entry)}
                          aria-label={`Remove ${entry.term}`}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </SettingsRowActions>
                    }
                  />
                )
              )
            )}
          </div>
        </SettingsGroup>
        {entries.length > 0 && (
          <p className="mt-2 text-xs text-text-secondary">
            {pluralize(entries.length, "term")}, {pluralize(rules, "heard-as phrase")}
          </p>
        )}
      </SettingsSection>
    </div>
  );
}

/** Phrases an entry lists that fire for an older entry: saved before a second claim was refused, they never fire here. */
function ShadowedHeardAs({
  owners,
  entry,
}: {
  owners: ReadonlyMap<string, string>;
  entry: VoiceDictionaryEntry;
}) {
  const shadowed = findHeardAsConflicts(owners, entry.term, entry.heardAs);
  if (shadowed.length === 0) return null;
  return <span className="block">Not used: {describeHeardAsConflicts(shadowed)}</span>;
}

function EntryEditor({
  entry,
  others,
  owners,
  onSave,
  onCancel,
}: {
  entry: VoiceDictionaryEntry;
  others: VoiceDictionaryEntry[];
  owners: ReadonlyMap<string, string>;
  /** Resolves with the phrases main refused for another term, empty once saved or failed. */
  onSave: (term: string, heardAs: string[], heardAsConflict?: "move") => Promise<HeardAsConflict[]>;
  onCancel: () => void;
}) {
  const [term, setTerm] = useState(entry.term);
  const [heard, setHeard] = useState(entry.heardAs.join("\n"));
  const [moving, setMoving] = useState<{
    term: string;
    heard: string;
    conflicts: HeardAsConflict[];
  } | null>(null);
  const heardRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = term.trim();
  const heardAs = parseHeardAsField(heard);
  const tooLong =
    trimmed.length > MAX_DICTIONARY_TERM_LENGTH ||
    heardAs.some((phrase) => phrase.length > MAX_DICTIONARY_TERM_LENGTH);
  const duplicate = others.some((other) => fold(other.term) === fold(trimmed));
  const error = !trimmed
    ? "A term can't be empty"
    : duplicate
      ? "That term is already in the dictionary"
      : tooLong
        ? `Terms and phrases can't be longer than ${MAX_DICTIONARY_TERM_LENGTH} characters`
        : undefined;
  const dirty =
    trimmed !== entry.term ||
    heardAs.length !== entry.heardAs.length ||
    heardAs.some((phrase, i) => phrase !== entry.heardAs[i]);
  // Editing either field drops the question: a move applies to the fields it was asked about.
  const pendingMove =
    moving !== null && moving.term === term && moving.heard === heard ? moving : null;
  const save = (heardAsConflict?: "move") => {
    const asked = { term, heard };
    void onSave(trimmed, heardAs, heardAsConflict).then((conflicts) => {
      if (conflicts.length > 0) setMoving({ ...asked, conflicts });
    });
  };
  const submit = () => {
    if (error || !dirty) return;
    const conflicts = findHeardAsConflicts(owners, entry.term, heardAs);
    if (conflicts.length > 0) setMoving({ term, heard, conflicts });
    else save();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <SettingsRow
      label={`Edit ${entry.term}`}
      layout="stacked"
      error={error}
      control={({ labelId, descriptionId }) => (
        <div className="space-y-2">
          <Input
            autoFocus
            value={term}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <Textarea
            ref={heardRef}
            rows={2}
            value={heard}
            aria-label={`Heard-as phrases for ${entry.term}`}
            placeholder="Heard as, one phrase per line"
            onChange={(e) => setHeard(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {pendingMove ? (
            <HeardAsMovePrompt
              term={trimmed}
              conflicts={pendingMove.conflicts}
              onMove={() => save("move")}
              onCancel={() => {
                setMoving(null);
                heardRef.current?.focus();
              }}
            />
          ) : (
            <SettingsRowActions>
              <Button size="sm" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button size="sm" variant="contrast" onClick={submit} disabled={!!error || !dirty}>
                Save
              </Button>
            </SettingsRowActions>
          )}
        </div>
      )}
    />
  );
}
