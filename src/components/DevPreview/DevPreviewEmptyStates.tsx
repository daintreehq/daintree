import { useLayoutEffect, useRef, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  Play,
  RotateCw,
  Settings,
  SquareTerminal,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { InlineStatusBanner } from "../Terminal/InlineStatusBanner";
import { DevPreviewLoadingState } from "./DevPreviewLoadingState";
import type { DevPreviewStatus } from "@/hooks/useDevServer";
import type { DevServerError } from "@shared/utils/devServerErrors";
import type { RunCommand } from "@shared/types";

interface DevPreviewEmptyStatesProps {
  isRestarting: boolean;
  status: DevPreviewStatus;
  isProxyUrlPending: boolean;
  phaseLabel?: "Compiling";
  error: DevServerError | null;
  /** Starts the dev server; also the error state's Retry. */
  handleRetry: () => void;
  setDevPreviewConsoleOpen: (id: string, open: boolean) => void;
  id: string;
  currentUrl: string;
  handleOpenExternal: () => void;
  isUnconfigured: boolean;
  primaryCandidate: RunCommand | undefined;
  isAutoDetecting: boolean;
  attemptingCommand: string | null;
  isSettingsLoading: boolean;
  handleAutoDetect: (candidateCommand?: string) => Promise<boolean>;
  autoDetectFailedCommand: string | null;
  candidates: RunCommand[];
  handlePickCandidate: (candidate: { command: string }) => void;
  handleOpenSettings: () => void;
  commandInput: string;
  setCommandInput: (value: string) => void;
  handleSaveCommand: () => Promise<void>;
  commandInputError: string | null;
  isSavingCommand: boolean;
  saveCommandFailed: boolean;
  devCommand: string;
  handleStartFromRestored: () => void;
  hasBeenVisible: boolean;
  isEvicted: boolean;
}

const ERROR_TITLES: Record<DevServerError["type"], string> = {
  "port-conflict": "Port conflict",
  "missing-dependencies": "Missing dependencies",
  permission: "Permission denied",
  "compile-error": "Dev server error",
  oom: "Dev server error",
  "process-crash": "Dev server error",
  unknown: "Dev server error",
};

/**
 * The pane-filling frame every state shares. Scrolls rather than clips in a
 * short pane, and keeps the title and description in one polite status region
 * so a change of state is announced without the actions being read out again.
 */
function PaneState({
  icon,
  title,
  description,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="absolute inset-0 overflow-y-auto bg-surface-canvas">
      <div className="flex min-h-full flex-col items-center justify-center gap-5 p-6">
        <div role="status" aria-live="polite" className="w-full">
          <EmptyState
            variant="zero-data"
            scale="canvas"
            icon={icon}
            title={title}
            description={description}
            className="p-0"
          />
        </div>
        {children}
      </div>
    </div>
  );
}

/** A command exactly as it will run, with an optional quieter label before it. */
// Wraps rather than truncates: the point of showing the command is that all of
// it can be read before it runs.
function CommandChip({ label, command }: { label?: string; command: string }) {
  return (
    <div className="inline-flex min-w-0 max-w-full items-baseline gap-2 rounded-[var(--radius-md)] border border-border-default bg-surface-panel px-3 py-1.5 text-left">
      {label && <span className="shrink-0 text-xs text-text-secondary">{label}</span>}
      <code className="min-w-0 font-mono text-xs text-text-primary break-words">{command}</code>
    </div>
  );
}

/**
 * Holds a control that gets swapped for another in place (Run for a failure's
 * Retry, and back). Unmounting the focused control drops focus on the body, so
 * when the slot held focus before the swap, the replacement takes it over.
 */
function FocusSlot({ swapKey, children }: { swapKey: string; children: ReactNode }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const hadFocusRef = useRef(false);

  useLayoutEffect(() => {
    if (!hadFocusRef.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    slotRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  }, [swapKey]);

  return (
    <div
      ref={slotRef}
      className="contents"
      onFocus={() => {
        hadFocusRef.current = true;
      }}
      onBlur={(e) => {
        // A null relatedTarget is the focused control being unmounted (or the
        // window losing focus) — keep the claim so the swap can restore it.
        if (e.relatedTarget instanceof Node) {
          hadFocusRef.current = slotRef.current?.contains(e.relatedTarget) ?? false;
        }
      }}
    >
      {children}
    </div>
  );
}

function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick} variant="ghost" size="sm">
      <Settings />
      Open project settings
    </Button>
  );
}

/**
 * Renders the non-webview states of the dev-preview surface: the full-pane
 * loading spinner, dev-server error, unconfigured/restored-stopped/stopped/
 * waiting placeholders, and the not-yet-visible/evicted placeholders. Callers gate
 * rendering this instead of the live webview via the same condition used
 * internally here, so the branch order below must stay in sync with that gate.
 */
export function DevPreviewEmptyStates({
  isRestarting,
  status,
  isProxyUrlPending,
  phaseLabel,
  error,
  handleRetry,
  setDevPreviewConsoleOpen,
  id,
  currentUrl,
  handleOpenExternal,
  isUnconfigured,
  primaryCandidate,
  isAutoDetecting,
  attemptingCommand,
  isSettingsLoading,
  handleAutoDetect,
  autoDetectFailedCommand,
  candidates,
  handlePickCandidate,
  handleOpenSettings,
  commandInput,
  setCommandInput,
  handleSaveCommand,
  commandInputError,
  isSavingCommand,
  saveCommandFailed,
  devCommand,
  handleStartFromRestored,
  hasBeenVisible,
  isEvicted,
}: DevPreviewEmptyStatesProps) {
  // A freshly mounted pane reports "stopped" until its first state read lands
  // and the auto-start takes over, so the Start prompt waits out the Doherty
  // gate rather than flashing up and vanishing.
  const showStoppedPrompt = useDohertyGate(status === "stopped" && !isUnconfigured);

  if (isRestarting || status === "starting" || status === "installing" || isProxyUrlPending) {
    return (
      <DevPreviewLoadingState
        variant="full"
        isLoading={true}
        phaseLabel={
          isRestarting
            ? "Restarting"
            : status === "installing"
              ? "Installing dependencies"
              : (phaseLabel ?? "Starting dev server")
        }
      />
    );
  }

  if (status === "error" && error) {
    // The terminal holds the output that explains these; for a port conflict
    // the fix is the command's port, which lives in project settings.
    const viewTerminal =
      error.type === "missing-dependencies" ||
      error.type === "permission" ||
      error.type === "compile-error";
    return (
      <PaneState
        icon={<AlertTriangle className="text-status-warning" />}
        title={ERROR_TITLES[error.type]}
        description={error.message}
      >
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={handleRetry} variant="subtle" size="sm">
            <RotateCw />
            {error.type === "missing-dependencies" ? "Retry install" : "Retry"}
          </Button>
          {viewTerminal ? (
            <Button onClick={() => setDevPreviewConsoleOpen(id, true)} variant="ghost" size="sm">
              <SquareTerminal />
              View terminal
            </Button>
          ) : error.type === "port-conflict" ? (
            <SettingsButton onClick={handleOpenSettings} />
          ) : currentUrl ? (
            <Button onClick={handleOpenExternal} variant="ghost" size="sm">
              <ExternalLink />
              Open in browser
            </Button>
          ) : null}
        </div>
      </PaneState>
    );
  }

  if (!currentUrl || status !== "running") {
    if (isUnconfigured && primaryCandidate) {
      const shownCommand = attemptingCommand ?? primaryCandidate.command;
      const failed = autoDetectFailedCommand !== null;
      // Run already offers the shown command; the menu is for the others.
      const otherCandidates = candidates.filter((c) => c.command !== shownCommand);
      return (
        <PaneState
          title="Start the dev server"
          description="This script in package.json looks like your dev server."
        >
          <div className="flex w-full max-w-sm flex-col items-center gap-3">
            <CommandChip
              label="Detected"
              command={failed ? autoDetectFailedCommand || shownCommand : shownCommand}
            />
            <FocusSlot swapKey={failed ? "failed" : "run"}>
              {failed ? (
                <InlineStatusBanner
                  icon={XCircle}
                  severity="error"
                  title="Couldn't save the command"
                  description="Project settings couldn't be updated, so the dev server didn't start."
                  className="w-full rounded-[var(--radius-md)] text-left"
                  action={{
                    id: "dev-preview-auto-detect-retry",
                    label: "Retry",
                    icon: RotateCw,
                    variant: "dangerFilled",
                    onClick: () =>
                      void handleAutoDetect(autoDetectFailedCommand || primaryCandidate.command),
                  }}
                />
              ) : (
                <Button
                  onClick={() => void handleAutoDetect(primaryCandidate.command)}
                  loading={isAutoDetecting}
                  disabled={isSettingsLoading}
                  variant="contrast"
                  aria-label={`Run ${shownCommand}`}
                >
                  <Play />
                  Run
                </Button>
              )}
            </FocusSlot>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1">
            {otherCandidates.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm">
                    Run another script…
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center" sideOffset={4} className="w-72 p-1">
                  {otherCandidates.map((c) => (
                    <DropdownMenuItem key={c.id} onSelect={() => handlePickCandidate(c)}>
                      <code className="min-w-0 flex-1 font-mono text-xs break-words">
                        {c.command}
                      </code>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <SettingsButton onClick={handleOpenSettings} />
          </div>
        </PaneState>
      );
    }

    if (isUnconfigured) {
      const showInputError = commandInput.trim() !== "" && commandInputError !== null;
      return (
        <PaneState
          title="Set a dev command"
          description="Enter the command that starts your local dev server."
        >
          <form
            className="flex w-full max-w-xs flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSaveCommand();
            }}
          >
            <Field>
              <FieldLabel>Dev command</FieldLabel>
              <Input
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                placeholder="npm run dev"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
              {showInputError && <FieldError>{commandInputError}</FieldError>}
            </Field>
            <FocusSlot swapKey={saveCommandFailed ? "failed" : "run"}>
              {saveCommandFailed ? (
                <InlineStatusBanner
                  icon={XCircle}
                  severity="error"
                  title="Couldn't save the command"
                  description="Project settings couldn't be updated, so the dev server didn't start."
                  className="w-full rounded-[var(--radius-md)] text-left"
                  action={{
                    id: "dev-preview-save-command-retry",
                    label: "Retry",
                    icon: RotateCw,
                    variant: "dangerFilled",
                    onClick: () => void handleSaveCommand(),
                  }}
                />
              ) : (
                <Button
                  type="submit"
                  variant="contrast"
                  className="self-center"
                  loading={isSavingCommand}
                  disabled={!commandInput.trim() || commandInputError !== null}
                >
                  <Play />
                  Run
                </Button>
              )}
            </FocusSlot>
          </form>
          <SettingsButton onClick={handleOpenSettings} />
        </PaneState>
      );
    }

    if (status === "restored-stopped") {
      return (
        <PaneState
          title="Restart the dev server"
          description="It was running when Daintree closed, and wasn't reattached."
        >
          {devCommand && <CommandChip command={devCommand} />}
          <Button onClick={handleStartFromRestored} variant="contrast">
            <RotateCw />
            Restart dev server
          </Button>
        </PaneState>
      );
    }

    if (status === "stopped") {
      if (!showStoppedPrompt || !devCommand) {
        return <div className="absolute inset-0 bg-surface-canvas" />;
      }
      return (
        <PaneState
          title="Start the dev server"
          description="It isn't running. Start it to preview your site here."
        >
          <CommandChip command={devCommand} />
          <Button onClick={handleRetry} variant="contrast">
            <Play />
            Start dev server
          </Button>
        </PaneState>
      );
    }

    if (status === "stopping") {
      return <PaneState title="Stopping dev server" />;
    }

    return (
      <PaneState
        title="Waiting for the dev server's address"
        description="It's running, but hasn't printed a local URL yet."
      >
        <Button onClick={() => setDevPreviewConsoleOpen(id, true)} variant="ghost" size="sm">
          <SquareTerminal />
          View terminal
        </Button>
      </PaneState>
    );
  }

  if (!hasBeenVisible) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-canvas text-text-primary">
        <p className="text-xs text-text-secondary">
          Preview will load when this panel is first viewed
        </p>
      </div>
    );
  }

  if (isEvicted) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-canvas text-text-primary p-6">
        <p className="text-xs text-text-secondary">
          Preview paused to save memory — will reload when opened
        </p>
      </div>
    );
  }

  return null;
}
