import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronLeft, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SearchField } from "@/components/ui/SearchField";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { SettingsSection } from "./SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow, SettingsRowActions } from "./SettingsGroup";
import { useSettingsSubpage } from "./SettingsSubpage";
import { parseDictionaryInput, parseHeardAsField } from "./voiceDictionaryImport";
import { MAX_DICTIONARY_KEYTERMS } from "@shared/config/voiceKeyterms";
import { MAX_DICTIONARY_TERM_LENGTH } from "@shared/utils/voiceDictionary";
import type {
  SuggestedDictionaryEntry,
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
  const rules = entries.reduce((total, entry) => total + entry.heardAs.length, 0);
  const lastRemoved = removed[removed.length - 1];

  const addDraft = () => {
    const { terms, skipped } = parseDictionaryInput(draft);
    if (terms.length === 0) {
      if (skipped > 0) {
        setNotice(
          `Nothing added: ${skipped === 1 ? "that entry is" : "those entries are"} longer than ${MAX_DICTIONARY_TERM_LENGTH} characters`
        );
      }
      return;
    }
    const text = draft;
    draftRef.current?.focus();
    setRemoved([]);
    void onChange(
      "The dictionary",
      async () => {
        let state: VoiceDictionaryState | undefined;
        for (const { term, heardAs } of terms) {
          state = await window.electron.voiceDictionary.add({
            term,
            heardAs,
            ...(terms.length > 1 || skipped > 0 ? { source: "imported" as const } : {}),
          });
        }
        return state!;
      },
      () => {
        // Keep anything typed while the add was in flight.
        setDraft((current) => (current === text ? "" : current));
        const base = `Added ${terms.length} ${terms.length === 1 ? "term" : "terms"}`;
        setNotice(
          skipped > 0
            ? `${base}. Skipped ${skipped} over ${MAX_DICTIONARY_TERM_LENGTH} characters`
            : base
        );
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
    void onChange(
      "The dictionary",
      () =>
        window.electron.voiceDictionary.add({
          term: entry.term,
          heardAs: entry.heardAs,
          source: entry.source,
          addedAt: entry.addedAt,
        }),
      () => setRemoved((current) => current.filter((e) => e !== entry))
    );
  };

  const refocusEdit = (term: string) =>
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLElement>("[data-edit-term]");
      for (const button of buttons ?? []) {
        if (fold(button.dataset.editTerm ?? "") === fold(term)) button.focus();
      }
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
                      onClick={() => {
                        draftRef.current?.focus();
                        void onChange("The dictionary", () =>
                          window.electron.voiceDictionary.acceptSuggestion({
                            word: suggestion.word,
                          })
                        );
                      }}
                      aria-label={`Add ${suggestion.word} to dictionary`}
                    >
                      <Plus aria-hidden="true" />
                      Add
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => {
                        draftRef.current?.focus();
                        void onChange("The suggestion list", () =>
                          window.electron.voiceDictionary.dismissSuggestion({
                            word: suggestion.word,
                          })
                        );
                      }}
                      aria-label={`Dismiss ${suggestion.word}`}
                    >
                      <X aria-hidden="true" />
                    </Button>
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
                <Button size="sm" variant="outline" onClick={addDraft} disabled={!draft.trim()}>
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
            {lastRemoved ? (
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
                    onCancel={() => {
                      setEditing(null);
                      refocusEdit(entry.term);
                    }}
                    onSave={(term, heardAs) => {
                      void onChange(
                        "The dictionary",
                        () =>
                          window.electron.voiceDictionary.update({
                            term: entry.term,
                            changes: { term, heardAs },
                          }),
                        () => {
                          setEditing(null);
                          refocusEdit(term);
                        }
                      );
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
            {entries.length} {entries.length === 1 ? "term" : "terms"}, {rules}{" "}
            {rules === 1 ? "heard-as phrase" : "heard-as phrases"}
          </p>
        )}
      </SettingsSection>
    </div>
  );
}

function EntryEditor({
  entry,
  others,
  onSave,
  onCancel,
}: {
  entry: VoiceDictionaryEntry;
  others: VoiceDictionaryEntry[];
  onSave: (term: string, heardAs: string[]) => void;
  onCancel: () => void;
}) {
  const [term, setTerm] = useState(entry.term);
  const [heard, setHeard] = useState(entry.heardAs.join(", "));
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
  const submit = () => {
    if (!error) onSave(trimmed, heardAs);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
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
          <Input
            value={heard}
            aria-label={`Heard-as phrases for ${entry.term}`}
            placeholder="Heard as, separated by commas"
            onChange={(e) => setHeard(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <SettingsRowActions>
            <Button size="sm" variant="contrast" onClick={submit} disabled={!!error}>
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </SettingsRowActions>
        </div>
      )}
    />
  );
}
