import { useEffect, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Callout } from "@/components/ui/Callout";
import { Spinner } from "@/components/ui/Spinner";
import { CanopyTerminal } from "@/components/Canopy/CanopyTerminal";
import { canopyHostClient } from "@/clients/canopyHostClient";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";
import type { HostSignInTerminal } from "@shared/types/ipc/canopyHost";
import type { HostId } from "@shared/types/remoteHosts";
import { agentSignInLabels, hostSignInTerminalApi, newSignInConsumer } from "./hostAgentSignIn";
import { holdSignInDialog } from "./signInDialogHold";

type Phase =
  | { kind: "starting" }
  | { kind: "running"; consumer: string; terminal: HostSignInTerminal }
  /** `retryable` is false for a host too old to have sign-ins: updating it is the way on. */
  | { kind: "failed"; message: string; retryable: boolean };

const ENDED_MESSAGE = "This terminal has exited. Close this when you're done.";

function SignInTerminal({
  hostId,
  consumer,
  terminal,
  acknowledge,
}: {
  hostId: HostId;
  consumer: string;
  terminal: HostSignInTerminal;
  /**
   * An assistant's sign-in (#18197): Main hears once its terminal is live on
   * screen here, and nothing else. It doesn't take the keyboard on its own,
   * since the person didn't open it: stray typing never reaches the login.
   */
  acknowledge: boolean;
}) {
  const [api] = useState(() => hostSignInTerminalApi(hostId, consumer));
  const live = useRef(false);
  const tryAcknowledge = useRef<() => void>(() => {});

  useEffect(() => {
    if (!acknowledge) return undefined;
    let disposed = false;
    let sent = false;
    // Main takes it only while this view is on screen showing the assistant;
    // a hidden window or cached view says so again once it is shown.
    const attempt = () => {
      if (disposed || sent || !live.current || document.visibilityState !== "visible") return;
      sent = true;
      canopyHostClient.signInShown(consumer).then(
        (answer) => {
          if (answer === "not_shown") sent = false;
        },
        () => {
          sent = false;
        }
      );
    };
    tryAcknowledge.current = attempt;
    document.addEventListener("visibilitychange", attempt);
    window.addEventListener("focus", attempt);
    // A cached project view made active again hears it from Main, not from visibility.
    const app = window.electron?.app;
    const offRevealed = app?.onViewRevealed?.(attempt);
    const offWarm = app?.onViewWarmActivated?.(attempt);
    attempt();
    return () => {
      disposed = true;
      tryAcknowledge.current = () => {};
      document.removeEventListener("visibilitychange", attempt);
      window.removeEventListener("focus", attempt);
      offRevealed?.();
      offWarm?.();
    };
  }, [acknowledge, consumer]);

  return (
    <CanopyTerminal
      runId={terminal.terminalId}
      spawnedAt={terminal.spawnedAt}
      api={api}
      endedMessage={ENDED_MESSAGE}
      autoFocus={!acknowledge}
      onStreamChange={(stream) => {
        live.current = stream.watchId !== null;
        tryAcknowledge.current();
      }}
    />
  );
}

/**
 * An agent CLI's own sign-in, run in a terminal on a host and shown here to
 * see and type into (#18196). Opening it starts the sign-in; closing it ends
 * it there, finished or not. Nothing here says whether it worked: the CLI's
 * own screen is the only word on that.
 *
 * `offered` is a sign-in Main already started here for an assistant (#18197):
 * the first attempt shows it rather than starting one, and Retry starts the
 * person's own.
 */
export function HostAgentSignInDialog({
  hostId,
  hostName,
  agentId,
  agentName,
  offered,
  onClose,
}: {
  hostId: HostId;
  hostName: string;
  agentId: string;
  agentName: string;
  offered?: { consumer: string; terminal: HostSignInTerminal };
  onClose: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>(() =>
    offered
      ? { kind: "running", consumer: offered.consumer, terminal: offered.terminal }
      : { kind: "starting" }
  );
  // The adopted sign-in is let go a task after unmount, so StrictMode's
  // replayed mount keeps it rather than showing one already ended.
  const adoptedRelease = useRef<ReturnType<typeof setTimeout> | null>(null);

  // While this is open, an assistant's sign-in isn't opened over it.
  useEffect(() => holdSignInDialog(), []);

  useEffect(() => {
    if (attempt === 0 && offered) {
      const adopted = offered.consumer;
      if (adoptedRelease.current !== null) {
        clearTimeout(adoptedRelease.current);
        adoptedRelease.current = null;
      }
      return () => {
        adoptedRelease.current = setTimeout(() => {
          adoptedRelease.current = null;
          void canopyHostClient.releaseSignIn(adopted).catch(() => {});
        }, 0);
      };
    }
    const consumer = newSignInConsumer();
    let current = true;
    canopyHostClient.startSignIn(consumer, hostId, agentId).then(
      (terminal) => {
        if (current) setPhase({ kind: "running", consumer, terminal });
      },
      (error: unknown) => {
        if (current) {
          setPhase({
            kind: "failed",
            message: clientErrorText(error, "It didn't start."),
            retryable: clientErrorCode(error) !== "UNSUPPORTED",
          });
        }
      }
    );
    return () => {
      current = false;
      // Ends it on the host, a start still in flight included.
      void canopyHostClient.releaseSignIn(consumer).catch(() => {});
    };
  }, [hostId, agentId, attempt, offered]);

  const retry = () => {
    setPhase({ kind: "starting" });
    setAttempt((n) => n + 1);
  };

  const labels = agentSignInLabels(agentId);

  return (
    <AppDialog
      isOpen
      onClose={onClose}
      size="4xl"
      zIndex="nested"
      initialFocus="cancel"
      data-testid="host-agent-sign-in-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>
          Sign in to {agentName} on {hostName}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <div className="space-y-3">
          <p className="text-xs text-text-secondary">
            {labels ? (
              <>
                Runs <code className="select-text">{labels.command}</code> on {hostName}.
              </>
            ) : (
              <>
                Runs {agentName}&apos;s own sign-in on {hostName}.
              </>
            )}{" "}
            {labels?.prompt && (
              <>
                If {agentName} opens without asking you to sign in, type{" "}
                <code className="select-text">{labels.prompt}</code> in it.{" "}
              </>
            )}
            Links it prints open in this computer&apos;s browser. Closing this ends it.
          </p>
          {phase.kind === "failed" ? (
            <Callout severity="error" title="Sign-in didn't start" role="alert">
              <p className="select-text">{phase.message}</p>
            </Callout>
          ) : (
            <div
              className="flex h-96 min-h-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-border-default"
              data-testid="host-agent-sign-in-terminal"
            >
              {phase.kind === "running" ? (
                <SignInTerminal
                  key={phase.consumer}
                  hostId={hostId}
                  consumer={phase.consumer}
                  terminal={phase.terminal}
                  acknowledge={phase.consumer === offered?.consumer}
                />
              ) : (
                <p
                  className="flex flex-1 items-center justify-center gap-2 text-sm text-text-secondary"
                  role="status"
                >
                  <Spinner size="sm" />
                  Starting on {hostName}…
                </p>
              )}
            </div>
          )}
        </div>
      </AppDialog.Body>
      <AppDialog.Footer
        primaryAction={
          phase.kind === "failed" && phase.retryable
            ? { label: "Retry", onClick: retry }
            : undefined
        }
        secondaryAction={{ label: "Close", onClick: onClose }}
      />
    </AppDialog>
  );
}
