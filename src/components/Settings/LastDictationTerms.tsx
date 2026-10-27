import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { Button } from "@/components/ui/button";
import { logWarn } from "@/utils/logger";
import { voiceErrorLogFields } from "@shared/utils/voiceLogFields";
import { transcriptionProviderName } from "@shared/config/voiceProviders";
import type { LastDictationTerms, VoiceKeytermSource } from "@shared/types";
import { SettingsSection } from "./SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "./SettingsGroup";

const SOURCES: ReadonlyArray<{ source: VoiceKeytermSource; label: string }> = [
  { source: "dictionary", label: "Your dictionary" },
  { source: "projectDictionary", label: "Project dictionary" },
  { source: "project", label: "Project name" },
  { source: "repository", label: "Repository names" },
  { source: "names", label: "Host, project and worktree names" },
  { source: "commands", label: "Agent commands" },
  { source: "branch", label: "Branch name" },
  { source: "terminal", label: "Terminal output" },
];

const ATTEMPT_NOTE = {
  trimmed: "rejected the full list, so it was retried with fewer terms",
  none: "rejected the terms, so it was retried with none",
} as const;

function summarize(last: LastDictationTerms): string {
  if (last.sent === null) return "Waiting for the connection to open";
  if (last.endedBeforeSending) return "The connection closed before any terms were sent";
  const dropped = last.assembledCount - last.sent.length;
  const parts = [`${last.sent.length} of ${pluralize(last.assembledCount, "term")} sent`];
  if (dropped > 0 && last.keytermAttempt && last.keytermAttempt !== "full") {
    parts.push(`${transcriptionProviderName(last.provider)} ${ATTEMPT_NOTE[last.keytermAttempt]}`);
  } else if (dropped > 0) {
    parts.push(
      `${pluralize(dropped, "term")} dropped by ${transcriptionProviderName(last.provider)}'s limits`
    );
  }
  // One sentence goes without a period; several each take one.
  const summary = parts.join(". ");
  return parts.length > 1 ? `${summary}.` : summary;
}

export function LastDictationTermsSection() {
  const [last, setLast] = useState<LastDictationTerms | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const requestSeq = useRef(0);

  const load = useCallback(() => {
    const voice = window.electron?.voiceInput;
    if (!voice) return;
    const seq = ++requestSeq.current;
    voice
      .getLastTerms()
      .then((next) => {
        if (seq !== requestSeq.current) return;
        setLast(next);
        setLoadError(false);
      })
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        setLoadError(true);
        logWarn("Failed to load the last dictation's terms", voiceErrorLogFields(err));
      });
  }, []);

  useEffect(() => {
    const voice = window.electron?.voiceInput;
    // Subscribe first so a change between mount and the first reply isn't missed.
    const unsubscribers = [voice?.onStatus(load), voice?.onSessionEnded(load)];
    load();
    return () => {
      requestSeq.current++;
      for (const unsubscribe of unsubscribers) unsubscribe?.();
    };
  }, [load]);

  const sent = last?.sent ?? [];

  return (
    <SettingsSection
      title="Last dictation"
      description="The recognition hints the most recent dictation actually sent, as the provider received them"
      id="voice-last-dictation"
    >
      <SettingsGroup>
        {loadError ? (
          <SettingsEmptyRow
            action={
              <Button size="sm" variant="outline" onClick={load}>
                Retry
              </Button>
            }
          >
            Couldn&apos;t load the last dictation.
          </SettingsEmptyRow>
        ) : !last ? (
          <SettingsEmptyRow>Dictate once to see which terms were sent.</SettingsEmptyRow>
        ) : (
          <>
            <SettingsRow
              label={`${last.rewrite ? "Rewrite instruction sent" : "Sent"} to ${transcriptionProviderName(last.provider)}`}
              description={summarize(last)}
            />
            {SOURCES.map(({ source, label }) => (
              <SettingsRow
                key={source}
                label={label}
                control={
                  <span className="text-sm tabular-nums text-text-secondary">
                    {last.sent === null ? "—" : sent.filter((t) => t.source === source).length}
                  </span>
                }
              />
            ))}
            {sent.length > 0 && (
              <SettingsRow
                label="Terms"
                layout="stacked"
                control={
                  <div className="space-y-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpanded((v) => !v)}
                      aria-expanded={expanded}
                      aria-controls={listId}
                      className="-ml-3"
                    >
                      <ChevronRight
                        data-animated-chevron
                        aria-hidden="true"
                        className={cn(
                          "transition-transform duration-150 ease-out",
                          expanded && "rotate-90"
                        )}
                      />
                      {expanded ? "Hide terms" : "Show terms"}
                    </Button>
                    {expanded && (
                      <div id={listId} className="space-y-2 select-text">
                        {SOURCES.map(({ source, label }) => {
                          const terms = sent.filter((t) => t.source === source);
                          if (terms.length === 0) return null;
                          return (
                            <div key={source}>
                              <div className="text-xs text-text-secondary">{label}</div>
                              <p className="text-xs font-mono text-text-primary break-words">
                                {terms.map((t) => t.term).join(", ")}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                }
              />
            )}
          </>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
