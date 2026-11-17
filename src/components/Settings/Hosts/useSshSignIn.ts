import { useEffect, useRef, useState } from "react";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { clientErrorText } from "@/utils/clientAppError";
import type { HostConnection } from "@shared/types/remoteHosts";
import type { SshSignInPromptKind } from "@shared/types/ipc/remoteHosts";

export interface SshSignInPrompt {
  id: string;
  kind: SshSignInPromptKind;
  text: string;
}

export type SshSignInState =
  | { phase: "idle" }
  /** ssh is running; `prompt` is what it asks right now, if anything. */
  | { phase: "signing-in"; connection: HostConnection; prompt: SshSignInPrompt | null }
  | { phase: "failed"; connection: HostConnection; detail: string };

/**
 * One Sign in at a time for the surface that offers it: ssh's prompts as they
 * arrive, the answer handed straight on, and Cancel. Leaving the surface
 * cancels a sign-in still running. Nothing typed is kept here: the field
 * that holds it goes as soon as it is answered.
 */
export function useSshSignIn(onSignedIn: () => void) {
  const [state, setState] = useState<SshSignInState>({ phase: "idle" });
  // The running sign-in and its event subscription: nothing listens while none runs.
  const runningRef = useRef<{ attemptId: string; off: () => void } | null>(null);

  /** Lets go of the running sign-in, cancelling it in main when asked to. */
  const release = (cancel: boolean) => {
    const running = runningRef.current;
    runningRef.current = null;
    if (!running) return;
    running.off();
    if (cancel) void remoteHostsClient.cancelSshSignIn(running.attemptId).catch(() => {});
  };

  // Leaving the surface stops a sign-in still running.
  useEffect(
    () => () => {
      const running = runningRef.current;
      runningRef.current = null;
      if (!running) return;
      running.off();
      void remoteHostsClient.cancelSshSignIn(running.attemptId).catch(() => {});
    },
    []
  );

  const start = (connection: HostConnection) => {
    release(true);
    const attemptId = crypto.randomUUID();
    // Listening before asking: the first prompt can arrive before anything else.
    const off = remoteHostsClient.onSshSignInEvent((event) => {
      if (event.attemptId !== attemptId) return;
      if (event.type === "prompt") {
        const prompt = { id: event.promptId, kind: event.kind, text: event.text };
        setState((current) => (current.phase === "signing-in" ? { ...current, prompt } : current));
        return;
      }
      setState((current) =>
        current.phase === "signing-in" && current.prompt?.id === event.promptId
          ? { ...current, prompt: null }
          : current
      );
    });
    runningRef.current = { attemptId, off };
    setState({ phase: "signing-in", connection, prompt: null });
    const settle = (next: SshSignInState, signedIn = false) => {
      if (runningRef.current?.attemptId !== attemptId) return;
      release(false);
      setState(next);
      if (signedIn) onSignedIn();
    };
    remoteHostsClient.startSshSignIn({ attemptId, connection }).then(
      (result) => {
        if (result.status === "signed-in") settle({ phase: "idle" }, true);
        else if (result.status === "cancelled") settle({ phase: "idle" });
        else {
          settle({
            phase: "failed",
            connection,
            detail: result.detail ?? "ssh didn't say why it couldn't log in",
          });
        }
      },
      (error: unknown) =>
        settle({
          phase: "failed",
          connection,
          detail: clientErrorText(error, "The sign-in couldn't start"),
        })
    );
  };

  const answer = (promptId: string, text: string) => {
    const attemptId = runningRef.current?.attemptId;
    if (!attemptId) return;
    setState((current) =>
      current.phase === "signing-in" && current.prompt?.id === promptId
        ? { ...current, prompt: null }
        : current
    );
    remoteHostsClient.answerSshSignIn({ attemptId, promptId, answer: text }).catch(() => {
      // ssh never got it: the sign-in can't go on.
      void remoteHostsClient.cancelSshSignIn(attemptId).catch(() => {});
    });
  };

  /** Stops a running sign-in (ssh is killed) or puts away a failed one. */
  const close = () => {
    release(true);
    setState({ phase: "idle" });
  };

  /** After a failure: the same sign-in again. */
  const retry = () => {
    if (state.phase === "failed") start(state.connection);
  };

  return { state, start, answer, retry, close };
}
