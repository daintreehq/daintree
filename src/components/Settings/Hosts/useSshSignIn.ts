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
  const attemptRef = useRef<string | null>(null);

  useEffect(() => {
    const off = remoteHostsClient.onSshSignInEvent((event) => {
      if (event.attemptId !== attemptRef.current) return;
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
    return () => {
      off();
      const attemptId = attemptRef.current;
      attemptRef.current = null;
      if (attemptId) void remoteHostsClient.cancelSshSignIn(attemptId).catch(() => {});
    };
  }, []);

  const start = (connection: HostConnection) => {
    const previous = attemptRef.current;
    if (previous) void remoteHostsClient.cancelSshSignIn(previous).catch(() => {});
    const attemptId = crypto.randomUUID();
    attemptRef.current = attemptId;
    setState({ phase: "signing-in", connection, prompt: null });
    const settle = (next: SshSignInState, signedIn = false) => {
      if (attemptRef.current !== attemptId) return;
      attemptRef.current = null;
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
    const attemptId = attemptRef.current;
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
    const attemptId = attemptRef.current;
    attemptRef.current = null;
    if (attemptId) void remoteHostsClient.cancelSshSignIn(attemptId).catch(() => {});
    setState({ phase: "idle" });
  };

  /** After a failure: the same sign-in again. */
  const retry = () => {
    if (state.phase === "failed") start(state.connection);
  };

  return { state, start, answer, retry, close };
}
