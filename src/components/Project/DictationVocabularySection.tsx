import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { MAX_DICTIONARY_TERM_LENGTH } from "@shared/utils/voiceDictionary";
import type { VoiceDictionaryEntry } from "@shared/types/ipc/api";
import { pluralize } from "@/lib/pluralize";
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
  const termInputRef = useRef<HTMLInputElement>(null);
  // Results for a project the page has since left are dropped.
  const currentProjectRef = useRef(projectId);
  // One change at a time, so each starts from what the last one saved.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    currentProjectRef.current = projectId;
    setEntries([]);
    setFailure(null);
    const load = () => {
      window.electron.voiceDictionary.getProject({ projectId }).then(
        (next) => {
          if (currentProjectRef.current !== projectId) return;
          setEntries(next);
          setFailure(null);
        },
        (error: unknown) => {
          if (currentProjectRef.current !== projectId) return;
          logWarn("Failed to read the project vocabulary", voiceErrorLogFields(error));
          setFailure({
            title: "Couldn't load the vocabulary",
            message: "The project's terms couldn't be read.",
            retry: load,
          });
        }
      );
    };
    load();
  }, [projectId]);

  const change = (run: () => Promise<VoiceDictionaryEntry[]>, onSaved?: () => void) => {
    const forProject = projectId;
    queueRef.current = queueRef.current.then(async () => {
      try {
        const next = await run();
        if (currentProjectRef.current !== forProject) return;
        setEntries(next);
        setFailure(null);
        onSaved?.();
      } catch (error) {
        if (currentProjectRef.current !== forProject) return;
        logWarn("Failed to change the project vocabulary", voiceErrorLogFields(error));
        setFailure({
          title: "Couldn't save that change",
          message: "The vocabulary is as it was.",
          retry: () => change(run, onSaved),
        });
      }
    });
  };

  const add = () => {
    const nextTerm = term.trim();
    if (!nextTerm) return;
    const nextHeardAs = parseHeardAs(heardAs);
    termInputRef.current?.focus();
    change(
      () =>
        window.electron.voiceDictionary.addToProject({
          projectId,
          term: nextTerm,
          ...(nextHeardAs.length > 0 ? { heardAs: nextHeardAs } : {}),
        }),
      () => {
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
              <Button onClick={add} disabled={!term.trim()} size="sm" variant="outline">
                <Plus aria-hidden="true" />
                Add
              </Button>
            </div>
          )}
        />
        {entries.map((entry) => (
          <SettingsRow
            key={entry.term}
            label={entry.term}
            description={
              entry.heardAs.length > 0
                ? `Heard as ${entry.heardAs.map((phrase) => `“${phrase}”`).join(", ")}`
                : undefined
            }
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
