import { useState, useEffect, useRef, useCallback, useMemo, useId } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { Check, AlertCircle } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { SkeletonHint } from "@/components/ui/Skeleton";
import { FolderGit2 } from "@/components/icons";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { CopyableCommand } from "@/components/Setup/CopyableCommand";
import { projectClient } from "@/clients";
import { useDohertyGate } from "@/hooks";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { basename } from "@shared/utils/path";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";
import { ProjectEmojiButton } from "./ProjectEmojiButton";
import {
  FIELD_LABEL_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_CHECKBOX_CLASS,
  FIELD_EMOJI_ROW_INDENT,
  PathCaption,
} from "./projectDialogFields";
import {
  GITIGNORE_TEMPLATE_OPTIONS,
  DEFAULT_GITIGNORE_TEMPLATE_ID,
  isGitignoreTemplateId,
} from "@shared/config/gitignoreTemplates";
import type { GitInitProgressEvent, GitInitStepType } from "@shared/types/ipc/gitInit";
import type { ProjectCreationIdentity } from "@shared/types";

interface GitInitDialogProps {
  isOpen: boolean;
  directoryPath: string;
  /**
   * Identity chosen one dialog earlier in the create-project flow. Present
   * means "don't ask again, just show what they picked"; absent means this
   * dialog was reached directly by opening a non-repo folder, so it derives a
   * fresh suggestion from the folder name.
   */
  initialIdentity?: ProjectCreationIdentity | null;
  onSuccess: (identity: ProjectCreationIdentity) => void;
  onCancel: () => void;
}

const AUTO_CLOSE_DELAY_MS = 2000;

/**
 * House rule for a wait with nothing to show is reassurance past five seconds;
 * `SkeletonHint`'s own default is eight, which suits a skeleton that at least
 * has shape. Only the first threshold moves — the later escalations keep the
 * shared cadence. Matches `CloneRepoDialog`.
 */
const STILL_WORKING_AFTER_MS = 5000;

/** The steps the main process reports. `complete` and `error` are outcomes, not steps. */
type WorkStep = Extract<GitInitStepType, "init" | "gitignore" | "add" | "commit">;

const WORK_STEPS: readonly WorkStep[] = ["init", "gitignore", "add", "commit"];

function isWorkStep(step: GitInitStepType): step is WorkStep {
  return (WORK_STEPS as readonly GitInitStepType[]).includes(step);
}

/**
 * The steps a run with these options will actually take.
 *
 * Pinned when the run is launched rather than read live: a failure hands the
 * form back editable, and deriving the denominator from the current fields
 * would retitle a finished run's progress after the fact.
 */
function planSteps(createGitignore: boolean, createInitialCommit: boolean): WorkStep[] {
  const steps: WorkStep[] = ["init"];
  if (createGitignore) steps.push("gitignore");
  if (createInitialCommit) steps.push("add", "commit");
  return steps;
}

/**
 * The main process narrates a start as `"Staging files for initial commit..."`.
 * The trailing dots are its own progress punctuation and this surface supplies
 * its own, so strip them rather than rendering an ellipsis followed by three more dots.
 */
function liveLabel(message: string): string {
  return message.replace(/\.{3}$/, "").trim();
}

interface PhaseState {
  step: WorkStep;
  /** Present once the step has reported success — this is what the quiet list shows. */
  done?: string;
  /** The start message, kept for the live readout while `done` is absent. */
  live?: string;
}

/**
 * Collapse the raw event stream into one row per step.
 *
 * The stream carries a `start` and then a `success` for every step, so
 * rendering it verbatim states each step twice and — because a start event's
 * status never changes — leaves its spinner turning forever underneath its own
 * completion line. Four steps became nine rows and four live spinners on a run
 * that had already finished.
 */
function collapsePhases(events: GitInitProgressEvent[]): PhaseState[] {
  const byStep = new Map<WorkStep, PhaseState>();
  for (const event of events) {
    if (!isWorkStep(event.step)) continue;
    const phase = byStep.get(event.step) ?? { step: event.step };
    if (event.status === "start") phase.live = liveLabel(event.message);
    if (event.status === "success") phase.done = event.message;
    byStep.set(event.step, phase);
  }
  return [...byStep.values()];
}

/**
 * The two `git config` lines out of the main process's identity help.
 *
 * Extracted rather than reformatted: these exact strings are the recovery, and
 * they are what goes on the clipboard. Anything that is not a command line
 * falls back to the whole block so a reworded help message degrades to the
 * old verbatim rendering instead of vanishing.
 */
function extractCommands(help: string): string[] {
  const commands = help
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("git "));
  return commands.length > 0 ? commands : [];
}

export function GitInitDialog({
  isOpen,
  directoryPath,
  initialIdentity,
  onSuccess,
  onCancel,
}: GitInitDialogProps) {
  const [projectName, setProjectName] = useState("");
  const [emoji, setEmoji] = useState(DEFAULT_PROJECT_EMOJI);
  const [gitignoreTemplate, setGitignoreTemplate] = useState(DEFAULT_GITIGNORE_TEMPLATE_ID);
  const [createInitialCommit, setCreateInitialCommit] = useState(true);
  const [initialCommitMessage, setInitialCommitMessage] = useState("Initial commit");
  const [progressEvents, setProgressEvents] = useState<GitInitProgressEvent[]>([]);
  const [isInitializing, setIsInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [plannedSteps, setPlannedSteps] = useState<WorkStep[]>(() => planSteps(true, true));
  const hasFinalizedSuccessRef = useRef(false);
  const inFlightRef = useRef(false);
  const sawTerminalEventRef = useRef(false);
  const sawErrorEventRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const footerActionRef = useRef<HTMLButtonElement>(null);
  const previousModeRef = useRef<"configure" | "running" | "failed" | "complete">("configure");
  const nameErrorId = useId();
  const commitMessageErrorId = useId();
  const commitOptionsId = useId();

  const trimmedProjectName = projectName.trim();
  // The name is seeded from the folder, so this only ever fires after the user
  // clears the field — the one state where the start button silently disables.
  const isNameMissing = trimmedProjectName === "";
  // Symmetric with the name: the button goes dead either way, so both should
  // say why. The placeholder repeats the default value, which makes an emptied
  // field otherwise near-indistinguishable from a filled one.
  const isCommitMessageMissing = createInitialCommit && initialCommitMessage.trim() === "";

  const finalizeSuccess = useCallback(() => {
    if (hasFinalizedSuccessRef.current) {
      return;
    }
    hasFinalizedSuccessRef.current = true;
    onSuccess({ name: trimmedProjectName, emoji });
  }, [onSuccess, trimmedProjectName, emoji]);

  // Seed the identity row on open: the create-project flow already asked, so
  // reuse what it carried; reaching this dialog directly (opening a non-repo
  // folder) derives a fresh suggestion from the folder name instead.
  const seededName = initialIdentity?.name ?? basename(directoryPath);
  const seededEmoji = initialIdentity?.emoji ?? suggestProjectEmoji(basename(directoryPath));
  // Keyed on the folder as well as the open transition: a second git-init
  // request arriving while this one is open swaps `directoryPath` under us, and
  // leaving the identity behind would save folder B under folder A's name. The
  // seeds are plain strings, so they only differ when their inputs actually
  // change — depending on them costs no spurious re-seeds and keeps the
  // component eligible for the React Compiler.
  useEffect(() => {
    if (!isOpen) return;
    setProjectName(seededName);
    setEmoji(seededEmoji);
  }, [isOpen, directoryPath, seededName, seededEmoji]);

  useEffect(() => {
    if (!isOpen) {
      setGitignoreTemplate(DEFAULT_GITIGNORE_TEMPLATE_ID);
      setCreateInitialCommit(true);
      setInitialCommitMessage("Initial commit");
      setProgressEvents([]);
      setIsInitializing(false);
      setError(null);
      setIsComplete(false);
      setPlannedSteps(planSteps(true, true));
      hasFinalizedSuccessRef.current = false;
      inFlightRef.current = false;
      sawTerminalEventRef.current = false;
      sawErrorEventRef.current = false;
      return;
    }

    const cleanup = projectClient.onInitGitProgress((event) => {
      setProgressEvents((prev) => [...prev, event]);

      if (event.status === "error") {
        sawTerminalEventRef.current = true;
        sawErrorEventRef.current = true;
        setError(event.error || event.message || "Unknown error");
        setIsComplete(false);
        setIsInitializing(false);
      } else if (event.step === "complete" && event.status === "success") {
        sawTerminalEventRef.current = true;
        // A success event never follows an error event within one run — treat it as stale/foreign
        if (!sawErrorEventRef.current) {
          setError(null);
          setIsComplete(true);
          setIsInitializing(false);
        }
      }
    });

    return cleanup;
  }, [isOpen]);

  const startInitialization = useCallback(async () => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    sawTerminalEventRef.current = false;
    sawErrorEventRef.current = false;

    const createGitignore = gitignoreTemplate !== "none";
    setPlannedSteps(planSteps(createGitignore, createInitialCommit));
    setIsInitializing(true);
    setError(null);
    setIsComplete(false);
    setProgressEvents([]);
    hasFinalizedSuccessRef.current = false;

    try {
      const result = await projectClient.initGitGuided({
        directoryPath,
        createInitialCommit,
        initialCommitMessage: initialCommitMessage.trim(),
        createGitignore,
        gitignoreTemplate,
      });
      if (result.outcome === "success") {
        setError(null);
        setIsComplete(true);
      } else if (!sawTerminalEventRef.current) {
        setError(
          "Initialization finished without a status update — check the repository to confirm the result."
        );
      }
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to initialize git repository"));
    } finally {
      inFlightRef.current = false;
      setIsInitializing(false);
    }
  }, [directoryPath, gitignoreTemplate, initialCommitMessage, createInitialCommit]);

  useEffect(() => {
    if (!isOpen || !isComplete) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      finalizeSuccess();
    }, AUTO_CLOSE_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [isOpen, isComplete, finalizeSuccess]);

  const handleClose = () => {
    if (isInitializing) {
      return;
    }

    if (isComplete) {
      finalizeSuccess();
    } else {
      onCancel();
    }
  };

  // Gated, not raw: a folder that initializes inside 400ms should never flash a
  // progress panel over the form it just replaced.
  const isRunning = useDohertyGate(isInitializing);
  const mode: "configure" | "running" | "failed" | "complete" = isComplete
    ? "complete"
    : error
      ? "failed"
      : isRunning
        ? "running"
        : "configure";

  const phases = useMemo(() => collapsePhases(progressEvents), [progressEvents]);
  const completedPhases = useMemo(() => phases.filter((phase) => phase.done), [phases]);
  // The step that has started and not yet reported. Read from the end so a
  // stream that somehow overlaps two steps reports the most recent one.
  const currentPhase = useMemo(
    () => [...phases].reverse().find((phase) => !phase.done && phase.live),
    [phases]
  );
  const completedCount = Math.min(completedPhases.length, plannedSteps.length);
  const identityCommands = useMemo(() => (error ? extractCommands(error) : []), [error]);

  const configDisabled = isInitializing;
  const canStart = !isNameMissing && !isCommitMessageMissing;

  // AppDialog's default `initialFocus="first"` lands on the header close
  // button, which spends this focus region's one accent signal on the dismiss
  // control while the field the user came here to check sits unmarked.
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => nameInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  // Each mode replaces the controls the previous one owned, so keyboard focus
  // has to follow or it lands on a node that no longer exists — the WCAG 2.4.3
  // failure documented as F85. Running hands it to the disabled Cancel's
  // neighbour, failure to Retry, success to Open project. Configuration is
  // excluded on the way in: the open effect already put focus in the name
  // field, and re-running this on every keystroke would fight it.
  useEffect(() => {
    const previousMode = previousModeRef.current;
    previousModeRef.current = mode;
    if (!isOpen) return;
    const target =
      mode === "configure"
        ? previousMode === "running"
          ? nameInputRef.current
          : null
        : footerActionRef.current;
    if (!target) return;
    const frame = requestAnimationFrame(() => target.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen, mode]);

  const summary = (
    <div className="space-y-2.5 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg px-3 py-3">
      <div className="space-y-1">
        <span className="text-xs font-medium text-daintree-text/60">Repository</span>
        <p className="truncate text-xs text-daintree-text/80">
          <span aria-hidden="true">{emoji} </span>
          {trimmedProjectName}
        </p>
      </div>
      <div className="space-y-1">
        <span className="text-xs font-medium text-daintree-text/60">Folder</span>
        <PathCaption path={directoryPath} className="text-daintree-text/80" />
      </div>
    </div>
  );

  // What the primary action will actually write, in the user's own terms. This
  // dialog is the one place the app touches a folder it does not own yet, and
  // the folder path alone does not say that.
  const consequence = [
    "Creates a Git repository in this folder",
    gitignoreTemplate !== "none" ? "adds a .gitignore" : null,
    createInitialCommit ? "commits everything in it" : null,
  ].filter(Boolean);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={handleClose}
      size="md"
      dismissible={!isInitializing}
      initialFocus="none"
      data-testid="git-init-dialog"
    >
      <AppDialog.Header>
        {/* Neutral, not accent: the header glyph is decoration, and this focus
            region's one load-bearing accent is the keyboard focus ring. */}
        <AppDialog.Title icon={<FolderGit2 className="h-5 w-5 text-text-secondary" />}>
          Set up repository
        </AppDialog.Title>
        {!isInitializing && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body className="space-y-5">
        {mode === "complete" ? (
          <div
            className="flex flex-col items-center gap-4 py-6 text-center"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-status-success/15">
              <Check className="h-6 w-6 text-status-success" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-daintree-text">Repository initialized</h3>
              <p className="text-sm text-daintree-text/60">
                <span aria-hidden="true">{emoji} </span>
                {trimmedProjectName} is ready to open
              </p>
            </div>
            <PathCaption path={directoryPath} className="max-w-full" />
          </div>
        ) : mode === "running" ? (
          <>
            {/* One current phase, the way every other running-operation surface
                in the app reports itself, and first — "what is happening now"
                is the question this mode exists to answer. The transcript this
                replaced answered it with four simultaneous spinners. */}
            <div className="space-y-2">
              {/* Carries the phase and nothing else, so step changes are
                  announced and the step counter ticking is not. */}
              <span className="sr-only" role="status" aria-live="polite">
                {currentPhase?.live ?? "Starting"}
              </span>
              <div className="flex items-center gap-2">
                <Spinner size="sm" className="shrink-0 text-text-secondary" />
                <span aria-hidden="true" className="text-sm text-daintree-text">
                  {currentPhase?.live ?? "Starting…"}
                </span>
                {currentPhase && (
                  <span
                    aria-hidden="true"
                    className="ml-auto text-xs tabular-nums text-daintree-text/60"
                  >
                    {completedCount + 1} of {plannedSteps.length}
                  </span>
                )}
              </div>
              {/* Determinate on purpose: the step list is decided by the options
                  the user submitted, so "2 of 4" is something this surface
                  actually knows. Before the first event there is no step to
                  count, so the track omits `aria-valuenow` and pulses instead. */}
              <div
                role="progressbar"
                aria-label={currentPhase?.live ?? "Starting"}
                {...(currentPhase ? { "aria-valuenow": completedCount } : {})}
                aria-valuemin={0}
                aria-valuemax={plannedSteps.length}
                className={`h-1 w-full overflow-hidden rounded-full bg-daintree-border/50 ${
                  currentPhase ? "" : "animate-pulse-immediate"
                }`}
              >
                {currentPhase && (
                  <div
                    className="h-full rounded-full bg-daintree-text/60 transition-[width] duration-150 ease-out"
                    style={{
                      width: `${(completedCount / Math.max(plannedSteps.length, 1)) * 100}%`,
                    }}
                  />
                )}
              </div>
              {/* Only while nothing has been reported yet — once steps are
                  ticking, "Still working…" would be telling the user something
                  the counter already says. */}
              {!currentPhase && (
                <SkeletonHint message="Still working…" firstThreshold={STILL_WORKING_AFTER_MS} />
              )}
            </div>

            {/* Steps already finished, quieted to a static check. They are what
                makes a long staging step read as "step three of four" rather
                than as the operation having stalled. */}
            {completedPhases.length > 0 && (
              <ul className="space-y-1">
                {completedPhases.map((phase) => (
                  <li
                    key={phase.step}
                    className="flex items-start gap-2 text-xs text-daintree-text/45"
                  >
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{phase.done}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* Subordinate to the live phase: which folder is being written to,
                kept legible now that the form is gone. */}
            {summary}
          </>
        ) : (
          <>
            {/* Outcome first. A failure hands the user back the form with the
                fields they typed intact, so the explanation belongs above the
                inputs it is about — not below them, where the body scrolls it
                out of sight entirely. One banner, whether the failure arrived
                as an event or as a thrown error: the two used to render as two
                unrelated components, and the identity case printed its
                remediation twice. */}
            {error &&
              (identityCommands.length > 0 ? (
                <InlineStatusBanner
                  icon={AlertCircle}
                  severity="error"
                  title="Initial commit skipped"
                  description="The repository was created, but Git needs a name and email before it can commit. Set them, then retry."
                  descriptionExtras={
                    <div className="mt-2 space-y-1.5">
                      {identityCommands.map((command) => (
                        <CopyableCommand key={command} command={command} />
                      ))}
                    </div>
                  }
                  className="rounded-[var(--radius-md)]"
                />
              ) : (
                <InlineStatusBanner
                  icon={AlertCircle}
                  severity="error"
                  title="Initialization failed"
                  description={error}
                  className="rounded-[var(--radius-md)]"
                />
              ))}

            <div className="space-y-1.5">
              <label htmlFor="git-init-project-name" className={FIELD_LABEL_CLASS}>
                Project name
              </label>
              <div className="flex items-center gap-2">
                <ProjectEmojiButton
                  emoji={emoji}
                  onEmojiChange={setEmoji}
                  disabled={configDisabled}
                  ariaLabel="Choose project emoji"
                />
                <input
                  id="git-init-project-name"
                  ref={nameInputRef}
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  disabled={configDisabled}
                  aria-invalid={isNameMissing}
                  aria-describedby={isNameMissing ? nameErrorId : undefined}
                  className={FIELD_INPUT_CLASS}
                  placeholder="My project"
                />
              </div>
              {isNameMissing && (
                <p
                  id={nameErrorId}
                  role="alert"
                  data-testid="git-init-name-error"
                  className={`${FIELD_EMOJI_ROW_INDENT} text-xs text-status-error`}
                >
                  Enter a project name
                </p>
              )}
              <PathCaption path={directoryPath} className={FIELD_EMOJI_ROW_INDENT} />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="git-init-template" className={FIELD_LABEL_CLASS}>
                Gitignore template
              </label>
              <select
                id="git-init-template"
                value={gitignoreTemplate}
                onChange={(e) => {
                  if (isGitignoreTemplateId(e.target.value)) setGitignoreTemplate(e.target.value);
                }}
                disabled={configDisabled}
                className={FIELD_INPUT_CLASS}
              >
                {GITIGNORE_TEMPLATE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label} — {opt.description}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={createInitialCommit}
                  onChange={(e) => setCreateInitialCommit(e.target.checked)}
                  disabled={configDisabled}
                  aria-expanded={createInitialCommit}
                  aria-controls={commitOptionsId}
                  className={FIELD_CHECKBOX_CLASS}
                />
                <span className="text-sm text-daintree-text/80">Create initial commit</span>
              </label>

              {/* Indented behind a rule, the way every other dependent field in
                  Settings is presented. Left flat it sat at the same indent,
                  width and label weight as the gitignore select above it, so
                  the one field that only exists because a box is ticked read as
                  another permanent setting. */}
              {createInitialCommit && (
                <div
                  id={commitOptionsId}
                  className="ml-6 space-y-1.5 border-l border-daintree-border pl-4"
                >
                  <label htmlFor="git-init-commit-message" className={FIELD_LABEL_CLASS}>
                    Initial commit message
                  </label>
                  <input
                    id="git-init-commit-message"
                    type="text"
                    value={initialCommitMessage}
                    onChange={(e) => setInitialCommitMessage(e.target.value)}
                    disabled={configDisabled}
                    aria-invalid={isCommitMessageMissing}
                    aria-describedby={isCommitMessageMissing ? commitMessageErrorId : undefined}
                    placeholder="Initial commit"
                    className={FIELD_INPUT_CLASS}
                  />
                  {isCommitMessageMissing && (
                    <p
                      id={commitMessageErrorId}
                      role="alert"
                      data-testid="git-init-commit-message-error"
                      className="text-xs text-status-error"
                    >
                      Enter a commit message
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* The one thing the path alone does not say: this writes into a
                folder the app does not own yet, and exactly what it writes
                depends on the two controls above. */}
            <p className="text-xs text-daintree-text/50" data-testid="git-init-consequence">
              {consequence.join(", ")}.
            </p>
          </>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        {mode === "complete" ? (
          <Button
            ref={footerActionRef}
            variant="contrast"
            data-testid="git-init-open"
            onClick={handleClose}
            className="gap-2"
          >
            <Check className="h-4 w-4" />
            Open project
          </Button>
        ) : mode === "running" ? (
          // No primary while it runs. There is no safe way to stop a git init
          // part-way, so the only honest footer is the escape hatch, visibly
          // unavailable — rather than a primary button wearing a spinner over
          // its own label.
          <Button variant="outline" data-testid="git-init-cancel" disabled>
            Cancel
          </Button>
        ) : error ? (
          <>
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              ref={footerActionRef}
              variant="contrast"
              data-testid="git-init-retry"
              onClick={() => void startInitialization()}
              disabled={isInitializing || !canStart}
            >
              Retry
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onCancel} disabled={isInitializing}>
              Cancel
            </Button>
            <Button
              variant="contrast"
              data-testid="git-init-start"
              onClick={() => void startInitialization()}
              disabled={isInitializing || !canStart}
            >
              Initialize repository
            </Button>
          </>
        )}
      </AppDialog.Footer>
    </AppDialog>
  );
}
