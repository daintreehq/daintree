import { useEffect, useRef, useState } from "react";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import type { HostConnection } from "@shared/types/remoteHosts";
import type { SshSignInPromptKind } from "@shared/types/ipc/remoteHosts";

export interface SshSignInPrompt {
  id: string;
  kind: SshSignInPromptKind;
  text: string;
}

export type SshSignInState =
  | { phase: "idle" }
  /**
   * ssh is running; `prompt` is what it asks right now, if anything, and
   * `error` why the last answer didn't reach it.
   */
  | {
      phase: "signing-in";
      connection: HostConnection;
      prompt: SshSignInPrompt | null;
      error?: string;
    }
  | { phase: "failed"; connection: HostConnection; detail: string };

/** ssh reads at most this much of an answer; anything longer would reach it cut short. */
const MAX_ANSWER_BYTES = 1_022;

/**
 * One Sign in at a time for the surface that offers it: ssh's prompts as they
 * arrive, the answer handed straight on, and Cancel. Leaving the surface
 * cancels a sign-in still running. Nothing typed is kept here.
 */
export function useSshSignIn(onSignedIn: () => void) {
  const [state, setState] = useState<SshSignInState>({ phase: "idle" });
  // The running sign-in and its event subscription: nothing listens while none runs.
  const runningRef = useRef<{ attemptId: string; off: () => void } | null>(null);
  // Settles once the last sign-in has ended in main, which holds its host until then.
  const lastRunRef = useRef<Promise<unknown>>(Promise.resolve());

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
        setState((current) =>
          current.phase === "signing-in" ? { ...current, prompt, error: undefined } : current
        );
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
    // A sign-in just cancelled still holds its host in main until ssh is gone.
    const run = lastRunRef.current.then(() =>
      runningRef.current?.attemptId === attemptId
        ? remoteHostsClient.startSshSignIn({ attemptId, connection })
        : ({ status: "cancelled" } as const)
    );
    lastRunRef.current = run.catch(() => {});
    run.then(
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

  const answer = (prompt: SshSignInPrompt, text: string) => {
    const attemptId = runningRef.current?.attemptId;
    if (!attemptId) return;
    const askAgain = (error: string) =>
      setState((current) =>
        current.phase === "signing-in" &&
        (current.prompt === null || current.prompt.id === prompt.id)
          ? { ...current, prompt, error }
          : current
      );
    if (new TextEncoder().encode(text).byteLength > MAX_ANSWER_BYTES) {
      askAgain(`ssh takes up to ${MAX_ANSWER_BYTES} bytes here.`);
      return;
    }
    setState((current) =>
      current.phase === "signing-in" && current.prompt?.id === prompt.id
        ? { ...current, prompt: null, error: undefined }
        : current
    );
    remoteHostsClient.answerSshSignIn({ attemptId, promptId: prompt.id, answer: text }).then(
      () => {},
      (error: unknown) => {
        // ssh never got it and still waits on the same question: ask it again.
        if (runningRef.current?.attemptId !== attemptId) return;
        askAgain(
          isClientAppError(error) && error.userMessage
            ? error.userMessage
            : clientErrorText(error, "ssh didn't get that answer")
        );
      }
    );
  };

  /** Stops a running sign-in (ssh is killed) or puts away a failed one. */
  const close = () => {
    release(true);
    setState({ phase: "idle" });
  };

  return { state, start, answer, close };
}
