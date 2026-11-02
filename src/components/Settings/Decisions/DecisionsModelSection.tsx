import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsDependents,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsChoicebox } from "@/components/Settings/SettingsChoicebox";
import { SettingsSelect } from "@/components/Settings/SettingsSelect";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { pluralize } from "@/lib/pluralize";
import { DECISIONS_MODEL_ADAPTERS } from "@shared/types/decisions";
import { DecisionsModelConsentDialog } from "./DecisionsModelConsentDialog";
import { DecisionsModelClearDialog } from "./DecisionsModelClearDialog";
import { DecisionsModelReport } from "./DecisionsModelReport";
import {
  MODEL_ADAPTERS,
  NO_ADAPTER,
  adapterChoiceDescription,
  answeringText,
  historyText,
  providerText,
  runText,
  thresholdChoiceText,
  type AdapterChoice,
} from "./decisionModelCopy";
import type { DecisionsModelAction, UseDecisionsModelResult } from "./useDecisionsModel";

const ADAPTER_OPTIONS = [
  { value: NO_ADAPTER, label: "None", description: adapterChoiceDescription(NO_ADAPTER) },
  ...DECISIONS_MODEL_ADAPTERS.map((adapter) => ({
    value: adapter,
    label: MODEL_ADAPTERS[adapter].label,
    description: adapterChoiceDescription(adapter),
  })),
] satisfies { value: AdapterChoice; label: string; description: string }[];

/** The select's value for "answer nothing automatically". */
const NOT_ANSWERING = "off";

const FAILURE_TITLE: Record<DecisionsModelAction, string> = {
  learning: "Couldn't change learning",
  adapter: "Couldn't change the agent CLI",
  evaluate: "Couldn't start the evaluation",
  cancel: "Couldn't cancel the evaluation",
  threshold: "Couldn't change when the model answers",
  clear: "Couldn't clear the history",
};

function clockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function dateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Decision model (#16027): learning, off by default and agreed to on its own
 * the first time; which agent CLI it runs, each saying where it sends; the
 * evaluation report, shown before any threshold can be chosen; and clearing
 * what it learned, confirmed first and last in the section.
 */
export function DecisionsModelSection({
  model: read,
  proxyAllowlisted,
}: {
  model: UseDecisionsModelResult;
  /** Policy's switch, which decides whether questions without a gate can take a proxy answer at all. */
  proxyAllowlisted: boolean;
}) {
  const { model, loadError, pending, pendingPreferences, failure } = read;
  const [consentOpen, setConsentOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const locked = model === null || pending !== null;
  const learning = pendingPreferences?.learning ?? model?.learning ?? false;
  const adapter =
    pendingPreferences !== null ? pendingPreferences.adapter : (model?.adapter ?? null);
  const savedAdapter = model?.adapter ?? null;
  const evaluation = model?.evaluation ?? null;
  const running = model?.running ?? null;
  const history = model?.history ?? null;
  const historyCount = history?.state === "open" ? history.count : null;
  // A history that couldn't be opened may still be stored, and clearing deletes whatever is.
  const stored =
    history !== null &&
    (history.state === "open"
      ? history.count > 0
      : history.state === "unavailable" || history.stored);

  const toggleLearning = () => {
    if (locked || model === null) return;
    if (learning) {
      void read.setPreferences({ learning: false, adapter: savedAdapter }, "learning");
    } else if (model.consentedAt === undefined) {
      setConsentOpen(true);
    } else {
      void read.setPreferences({ learning: true, adapter: savedAdapter }, "learning");
    }
  };

  const chooseAdapter = (choice: AdapterChoice) => {
    if (locked || model === null) return;
    const next = choice === NO_ADAPTER ? null : choice;
    if (next === savedAdapter) return;
    void read.setPreferences({ learning: model.learning, adapter: next }, "adapter");
  };

  const retry = () => {
    if (failure === null) return;
    switch (failure.action) {
      case "learning":
      case "adapter":
        if (failure.payload) void read.setPreferences(failure.payload, failure.action);
        return;
      case "evaluate":
        void read.startEvaluation();
        return;
      case "cancel":
        if (failure.runId) void read.cancelEvaluation(failure.runId);
        return;
      case "threshold":
      case "clear":
        void read.reload();
        return;
    }
  };

  const evaluateDescription =
    savedAdapter === null
      ? "Replays your past answers through the agent CLI you choose, to show how often it would have matched you"
      : `Replays ${historyCount === null ? "your past answers" : pluralize(historyCount, "past answer")} through ${MODEL_ADAPTERS[savedAdapter].label}, one past question at a time, which sends them to ${providerText(savedAdapter)}. It can take many minutes.`;

  const thresholdValue =
    evaluation?.autoAnswerThreshold === null || evaluation === null
      ? NOT_ANSWERING
      : String(evaluation.autoAnswerThreshold);

  return (
    <SettingsSection
      title="Decision model"
      id="decisions-model"
      description="Learns from your own answers, and can answer agents in your place once you've seen how often it would have matched you"
    >
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {running ? "Evaluating the decision model…" : ""}
      </span>
      {model === null && loadError !== null && (
        <SettingsLoadErrorBanner
          title="Couldn't read the decision model's settings"
          message={loadError}
          onRetry={() => void read.reload()}
        />
      )}
      <SettingsGroup>
        <SettingsSwitchCard
          id="decisions-model-learning"
          title="Learn from your answers"
          subtitle="Keeps each question you answer from your phone on this computer, so the model can answer the way you would. Turning it off keeps what it learned."
          isEnabled={learning}
          onChange={toggleLearning}
          disabled={locked}
          isModified={model?.learning === true}
          onReset={() =>
            void read.setPreferences({ learning: false, adapter: savedAdapter }, "learning")
          }
        />
        <SettingsDependents disabled={!learning} reason="Turn on learning to choose an agent CLI">
          <SettingsChoicebox
            id="decisions-model-adapter"
            label="Agent CLI"
            description="Runs only when the model is evaluated or asked a question"
            value={adapter ?? NO_ADAPTER}
            onChange={chooseAdapter}
            options={ADAPTER_OPTIONS}
            disabled={locked}
          />
        </SettingsDependents>
      </SettingsGroup>
      {/* A failed clear says so in its dialog. */}
      {failure && failure.action !== "clear" && (
        <SettingsLoadErrorBanner
          title={FAILURE_TITLE[failure.action]}
          message={failure.message}
          onRetry={retry}
          // The choice is made again from what main holds now.
          retryLabel={failure.action === "threshold" ? "Reload" : undefined}
        />
      )}

      {model !== null && model.learning && (
        <SettingsGroup label="Evaluation" id="decisions-model-evaluation">
          <SettingsRow
            id="decisions-model-evaluate"
            label="Evaluate against your answers"
            description={
              running ? runText(running, clockTime(running.startedAt)) : evaluateDescription
            }
            disabled={savedAdapter === null || history?.state !== "open"}
            disabledReason={savedAdapter === null ? "Choose an agent CLI first" : undefined}
            control={({ descriptionId, disabled }) =>
              running ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending !== null}
                  aria-describedby={descriptionId}
                  onClick={() => void read.cancelEvaluation(running.runId)}
                >
                  Cancel
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled || pending !== null}
                  aria-describedby={descriptionId}
                  onClick={() => void read.startEvaluation()}
                >
                  {evaluation ? "Evaluate again" : "Evaluate"}
                </Button>
              )
            }
          />
          {!running && model.lastRun && (
            <SettingsRow
              id="decisions-model-last-run"
              label={
                model.lastRun.result === "cancelled"
                  ? "The last evaluation was cancelled"
                  : "The last evaluation stopped before it finished"
              }
              description={
                evaluation
                  ? "The report below is from the evaluation before it"
                  : "No report was kept, so the model doesn't answer anything"
              }
            />
          )}
          {evaluation && (
            <SettingsRow
              id="decisions-model-report"
              layout="stacked"
              label={`Report from ${dateTime(evaluation.evaluatedAt)}`}
              description={<DecisionsModelReport report={evaluation.report} />}
            />
          )}
          {evaluation && (
            <SettingsSelect
              id="decisions-model-threshold"
              label="Answer automatically"
              description={
                evaluation.thresholds.length === 0
                  ? "No confidence in this report matched your answers often enough on enough answers, so the model can't answer automatically yet"
                  : "Only from a confidence this report supports. When a new evaluation finishes, its report stops automatic answers until you choose again."
              }
              value={thresholdValue}
              onValueChange={(value) =>
                void read.setThreshold(
                  value === NOT_ANSWERING ? null : Number(value),
                  evaluation.evaluatedAt
                )
              }
              options={[
                { value: NOT_ANSWERING, label: "Don't answer automatically" },
                ...evaluation.thresholds.map((choice) => ({
                  value: String(choice.threshold),
                  label: thresholdChoiceText(choice),
                })),
              ]}
              controlWidth="wide"
              disabled={locked || running !== null || evaluation.thresholds.length === 0}
              isModified={evaluation.autoAnswerThreshold !== null}
              onReset={() => void read.setThreshold(null, evaluation.evaluatedAt)}
            />
          )}
          <SettingsRow
            id="decisions-model-answering"
            label={model.answeringFrom === null ? "Not answering" : "Answering in your place"}
            description={answeringText(model, proxyAllowlisted)}
          />
        </SettingsGroup>
      )}

      <SettingsGroup>
        <SettingsRow
          id="decisions-model-history"
          label="Clear history"
          description={
            history === null ? "What the model learned on this computer" : historyText(history)
          }
          disabled={locked || !stored}
          control={({ descriptionId, disabled }) => (
            <Button
              variant="ghost-danger"
              size="sm"
              disabled={disabled}
              aria-describedby={descriptionId}
              onClick={() => setClearOpen(true)}
            >
              Clear history
            </Button>
          )}
        />
      </SettingsGroup>

      <DecisionsModelConsentDialog
        isOpen={consentOpen}
        onCancel={() => setConsentOpen(false)}
        onAccept={() => {
          setConsentOpen(false);
          void read.setPreferences(
            { learning: true, adapter: savedAdapter, consent: true },
            "learning"
          );
        }}
      />
      <DecisionsModelClearDialog
        isOpen={clearOpen}
        count={historyCount}
        learning={model?.learning ?? false}
        clearing={pending === "clear"}
        error={failure?.action === "clear" ? failure.message : null}
        onCancel={() => {
          if (pending !== "clear") setClearOpen(false);
        }}
        onConfirm={() => {
          void read.clearHistory().then((done) => {
            if (done) setClearOpen(false);
          });
        }}
      />
    </SettingsSection>
  );
}
