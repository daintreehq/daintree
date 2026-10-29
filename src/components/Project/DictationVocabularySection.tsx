import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { HeardAsMovePrompt } from "@/components/Settings/HeardAsMovePrompt";
import {
  MAX_DICTIONARY_TERM_LENGTH,
  findHeardAsConflicts,
  heardAsOwners,
} from "@shared/utils/voiceDictionary";
import type { HeardAsConflict, VoiceDictionaryEntry } from "@shared/types/ipc/api";
import { pluralize } from "@/lib/pluralize";
import { describeHeardAsConflicts } from "@/lib/heardAsConflictCopy";
import { logWarn } from "@/utils/logger";
import { voiceErrorLogFields } from "@shared/utils/voiceLogFields";

type Failure = { title: string; message: string; retry: () => void };

/** "zoo stand, zoo-stand" → ["zoo stand", "zoo-stand"]. */
export function parseHeardAs(raw: string): string[] {
  return raw
    .split(",")
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}

interface Queue {
  queueRef: React.RefObject<Promise<void>>;
  visitRef: React.RefObject<number>;
  setEntries: (entries: VoiceDictionaryEntry[]) => void;
  setFailure: (failure: Failure | null) => void;
}

/**
 * Runs `run` after everything already queued, and shows its result unless the
 * page has moved to another visit since it was queued. A failure hands back a
 * retry that queues the same call again.
 */
function enqueue(
  { queueRef, visitRef, setEntries, setFailure }: Queue,
  run: () => Promise<VoiceDictionaryEntry[]>,
  onFailure: (error: unknown, retry: () => void) => void,
  onSaved?: () => void
): void {
  const visit = visitRef.current;
  const attempt = () => {
    queueRef.current = queueRef.current.then(async () => {
      if (visitRef.current !== visit) return;
      try {
        const next = await run();
        if (visitRef.current !== visit) return;
        setEntries(next);
        setFailure(null);
        onSaved?.();
      } catch (error) {
        if (visitRef.current !== visit) return;
        onFailure(error, attempt);
      }
    });
  };
  attempt();
}

/** An entry's heard-as phrases, and those an older entry fires for instead. */
function describeEntry(
  entry: VoiceDictionaryEntry,
  owners: ReadonlyMap<string, string>
): string | undefined {
  if (entry.heardAs.length === 0) return undefined;
  const heard = `Heard as ${entry.heardAs.map((phrase) => `“${phrase}”`).join(", ")}`;
  const shadowed = findHeardAsConflicts(owners, entry.term, entry.heardAs);
  return shadowed.length > 0 ? `${heard}. Not used: ${describeHeardAsConflicts(shadowed)}` : heard;
}

/**
 * The project's own dictation terms. Main owns the list and where it lives
 * (the repo file when project settings are stored there), so every change is
 * one operation and the page shows what main returns, never a local copy.
 */
export function DictationVocabularySection({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<VoiceDictionaryEntry[]>([]);
  const [term, setTerm] = useState("");
  const [heardAs, setHeardAs] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  // An add waiting on whether to move phrases another term has, for the draft as it was.
  const [moving, setMoving] = useState<{
    term: string;
    heardAs: string;
    conflicts: HeardAsConflict[];
  } | null>(null);
  // A refused add whose draft had moved on by the time main answered.
  const [notice, setNotice] = useState<string | null>(null);
  const termInputRef = useRef<HTMLInputElement>(null);
  // The draft as typed, read when a save lands after further edits.
  const draftRef = useRef({ term, heardAs });
  useEffect(() => {
    draftRef.current = { term, heardAs };
  }, [term, heardAs]);
  // Bumped whenever the page moves to a project, so anything still in flight
  // for an earlier visit is dropped, even one to the same project.
  const visitRef = useRef(0);
  // Reads and changes run one at a time, so a read can't land over a change
  // made after it, and each change starts from what the last one saved.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    visitRef.current++;
    // A visit doesn't wait on an earlier one, whose results are dropped anyway.
    queueRef.current = Promise.resolve();
    setEntries([]);
    setFailure(null);
    setMoving(null);
    setNotice(null);
    enqueue(
      { queueRef, visitRef, setEntries, setFailure },
      () => window.electron.voiceDictionary.getProject({ projectId }),
      (error, retry) => {
        logWarn("Failed to read the project vocabulary", voiceErrorLogFields(error));
        setFailure({
          title: "Couldn't load the vocabulary",
          message: "The project's terms couldn't be read.",
          retry,
        });
      }
    );
  }, [projectId]);

  const change = (run: () => Promise<VoiceDictionaryEntry[]>, onSaved?: () => void) => {
    enqueue(
      { queueRef, visitRef, setEntries, setFailure },
      run,
      (error, retry) => {
        logWarn("Failed to change the project vocabulary", voiceErrorLogFields(error));
        setFailure({
          title: "Couldn't save that change",
          message: "The vocabulary is as it was.",
          retry,
        });
      },
      onSaved
    );
  };

  const owners = heardAsOwners(entries);
  // Editing the draft drops the question: a move applies to the draft it was asked about.
  const pendingMove =
    moving !== null && moving.term === term && moving.heardAs === heardAs ? moving : null;

  const add = (move = false) => {
    const nextTerm = term.trim();
    if (!nextTerm) return;
    const submittedTerm = term;
    const submittedHeardAs = heardAs;
    const nextHeardAs = parseHeardAs(heardAs);
    if (!move) {
      const conflicts = findHeardAsConflicts(owners, nextTerm, nextHeardAs);
      if (conflicts.length > 0) {
        setMoving({ term, heardAs, conflicts });
        return;
      }
    }
    setMoving(null);
    setNotice(null);
    termInputRef.current?.focus();
    let left: HeardAsConflict[] = [];
    change(
      async () => {
        const result = await window.electron.voiceDictionary.addToProject({
          projectId,
          term: nextTerm,
          ...(nextHeardAs.length > 0 ? { heardAs: nextHeardAs } : {}),
          ...(move ? { heardAsConflict: "move" as const } : {}),
        });
        left = result.conflicts;
        return result.dictionary;
      },
      () => {
        // A draft edited while this was saving is the user's next entry.
        const unchanged =
          draftRef.current.term === submittedTerm && draftRef.current.heardAs === submittedHeardAs;
        // Refused for a phrase another term took since this page last read the list: ask, or
        // say so when the draft has moved on and the question has nothing to hang on.
        if (left.length > 0) {
          if (unchanged) {
            setMoving({ term: submittedTerm, heardAs: submittedHeardAs, conflicts: left });
          } else {
            setNotice(`Didn't add ${nextTerm}: ${describeHeardAsConflicts(left)}`);
          }
          return;
        }
        if (!unchanged) return;
        setTerm("");
        setHeardAs("");
      }
    );
  };

  const remove = (entryTerm: string) => {
    change(() => window.electron.voiceDictionary.removeFromProject({ projectId, term: entryTerm }));
  };

  const submitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    add();
  };

  const cancelMove = () => {
    setMoving(null);
    termInputRef.current?.focus();
  };

  return (
    <SettingsSection
      id="project-dictation-vocabulary"
      title="Dictation vocabulary"
      description="Terms sent with dictation into this project's panels, ahead of your own dictionary. Stored with the project's shared settings when those are kept in the repo."
    >
      {failure && (
        <SettingsLoadErrorBanner
          title={failure.title}
          message={failure.message}
          onRetry={failure.retry}
        />
      )}
      <SettingsGroup>
        <SettingsRow
          label="Add a term"
          description={
            entries.length > 0
              ? `${pluralize(entries.length, "term")}. Adding a term that's already here adds its heard-as forms.`
              : "Add the package, component and people's names the transcription gets wrong in this project"
          }
          layout="stacked"
          control={({ labelId, descriptionId }) => (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Input
                  ref={termInputRef}
                  type="text"
                  value={term}
                  maxLength={MAX_DICTIONARY_TERM_LENGTH}
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  onChange={(e) => setTerm(e.target.value)}
                  onKeyDown={submitOnEnter}
                  placeholder="Term, as written…"
                  className="w-auto min-w-40 flex-1"
                />
                <Input
                  type="text"
                  value={heardAs}
                  aria-label="Heard as"
                  onChange={(e) => setHeardAs(e.target.value)}
                  onKeyDown={submitOnEnter}
                  placeholder="Heard as, comma separated (optional)…"
                  className="w-auto min-w-40 flex-1"
                />
                <Button onClick={() => add()} disabled={!term.trim()} size="sm" variant="outline">
                  <Plus aria-hidden="true" />
                  Add
                </Button>
              </div>
              <div role="status" className="empty:hidden">
                {pendingMove ? (
                  <HeardAsMovePrompt
                    term={term.trim()}
                    conflicts={pendingMove.conflicts}
                    onMove={() => add(true)}
                    onCancel={cancelMove}
                  />
                ) : (
                  notice && <p className="text-sm text-text-secondary">{notice}</p>
                )}
              </div>
            </div>
          )}
        />
        {entries.map((entry) => (
          <SettingsRow
            key={entry.term}
            label={entry.term}
            description={describeEntry(entry, owners)}
            control={
              <Button
                size="icon-sm"
                variant="ghost-danger"
                onClick={() => remove(entry.term)}
                aria-label={`Remove ${entry.term}`}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            }
          />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}
