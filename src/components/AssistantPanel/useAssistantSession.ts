import { useCallback, useEffect, useRef } from "react";
import { useAssistantStore } from "@/store/assistantStore";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";

/**
 * Binds one assistant engine session to the store, and hands back the actions the
 * panel needs.
 *
 * ## Frame coalescing
 *
 * `turn:token` arrives many times a second and each one is a store write. Applying
 * them individually would re-render the transcript per token, which is the classic
 * streaming-chat jank: fine on a two-line answer, very visible on a long one. Tokens
 * are therefore buffered and flushed once per animation frame, while everything else
 * — approvals, tool state, turn boundaries — applies immediately, because those are
 * the events a user is waiting on and a frame of latency on them is a frame too many.
 *
 * ## Ordering
 *
 * The buffer preserves order within a turn because tokens for one turn arrive on one
 * pipe, in sequence. A non-token event flushes the buffer first, so a token can never
 * be applied after the `turn:end` that supersedes it.
 */

export interface AssistantSessionOptions {
  projectId: string | null;
  /** Project root — the engine's working directory. */
  cwd: string | null;
  /** When false the engine is not started (and a running one is stopped). */
  enabled: boolean;
  /** Bump to restart: it is a dependency of the start effect, so a change re-runs it. */
  restartNonce?: number;
}

export interface AssistantSessionActions {
  /** Returns false when there is no live session to accept the prompt. */
  submit: (text: string) => boolean;
  interrupt: () => void;
  decideApproval: (approvalId: string, decision: "approved" | "rejected") => void;
  /** Answer an outstanding question; `index` of -1 dismisses. */
  answerQuestion: (questionId: string, index: number) => void;
}

export function useAssistantSession(opts: AssistantSessionOptions): AssistantSessionActions {
  const sessionIdRef = useRef<string | null>(null);
  // Keyed by turn, TAGGED with the session the tokens arrived on. A flush is a frame
  // late by construction, so without the tag a session that turns over mid-frame would
  // have the outgoing engine's buffered text stamped with the incoming session's id
  // and appended to its transcript.
  const pendingTokens = useRef<Map<string, { sessionId: string; chunk: string }>>(new Map());
  const frameRef = useRef<number | null>(null);

  const flushTokens = useCallback(() => {
    frameRef.current = null;
    if (pendingTokens.current.size === 0) return;
    const store = useAssistantStore.getState();
    for (const [turnId, { sessionId, chunk }] of pendingTokens.current) {
      if (sessionId !== sessionIdRef.current) continue; // outlived its session
      store.applyEvent({
        type: "turn:token",
        sessionId,
        // Coalesced writes carry no meaningful sequence of their own; the transport
        // already validated ordering upstream. 1 is the "not applicable" value here.
        seq: 1,
        turnId,
        chunk,
      });
    }
    pendingTokens.current.clear();
  }, []);

  const scheduleFlush = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(flushTokens);
  }, [flushTokens]);

  // Subscribe once; the listeners live as long as the component.
  useEffect(() => {
    const offEvent = window.electron.assistantHost.onEvent((event) => {
      if (event.sessionId !== sessionIdRef.current) return; // a displaced session
      if (event.type === "turn:token") {
        const prior = pendingTokens.current.get(event.turnId);
        pendingTokens.current.set(event.turnId, {
          sessionId: event.sessionId,
          chunk: (prior?.sessionId === event.sessionId ? prior.chunk : "") + event.chunk,
        });
        scheduleFlush();
        return;
      }
      // Anything else flushes first, so a buffered token can never land after the
      // event that supersedes it (most importantly `turn:end`).
      flushTokens();
      useAssistantStore.getState().applyEvent(event);
    });

    const offGap = window.electron.assistantHost.onSequenceGap((payload) => {
      if (payload.sessionId !== sessionIdRef.current) return;
      useAssistantStore.getState().recordGap(payload.missing);
    });

    const offExit = window.electron.assistantHost.onExit((payload) => {
      if (payload.sessionId !== sessionIdRef.current) return;
      flushTokens();
      // The engine is gone, so the id no longer addresses anything. Clearing it is
      // what makes `submit` refuse: the Send button is already disabled, but Enter
      // still reaches submit, and a submit that "succeeds" against a dead session
      // eats the draft and paints a user turn that nothing will ever answer.
      sessionIdRef.current = null;
      const s = useAssistantStore.getState();
      s.setConnection("stopped");
      if (payload.code !== 0 && payload.code !== null) {
        s.pushNotice("error", `The assistant engine stopped unexpectedly (code ${payload.code}).`);
      }
    });

    return () => {
      offEvent();
      offGap();
      offExit();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [flushTokens, scheduleFlush]);

  const { projectId, cwd, enabled, restartNonce = 0 } = opts;

  // Start / stop the engine as the panel opens and the project changes.
  useEffect(() => {
    // Scoped to THIS effect run rather than a shared counter. Cleanup runs on a
    // dependency change and on unmount alike, so one flag covers both — where a
    // counter bumped on the way IN covers only the first, silently leaving a start
    // that is still in flight at unmount free to adopt a session for a component that
    // no longer exists and can no longer stop it.
    let cancelled = false;
    // The buffer identity is stable for the life of the hook; captured here so cleanup
    // clears the same Map this run wrote to, without reading a ref during teardown.
    const buffer = pendingTokens.current;

    if (!enabled || !projectId || !cwd) {
      const current = sessionIdRef.current;
      sessionIdRef.current = null;
      if (current) safeFireAndForget(window.electron.assistantHost.stop(current));
      return;
    }

    const store = useAssistantStore.getState();
    store.reset(null);
    store.setConnection("starting", null);

    safeFireAndForget(
      window.electron.assistantHost
        .start({ projectId, cwd })
        .then(({ sessionId, ready, mcpUnavailableReason }) => {
          // A newer start superseded this one while it was in flight; stop the engine we
          // just created rather than leaving it orphaned holding the project's lease.
          if (cancelled) {
            safeFireAndForget(window.electron.assistantHost.stop(sessionId));
            return;
          }
          sessionIdRef.current = sessionId;
          useAssistantStore.getState().reset(sessionId);
          // Prefer the engine's own readiness frame over a synthesized one: it is what
          // carries the engine version and `autoApprove`, and it was emitted before
          // this promise resolved, so the subscriber above dropped it for not yet
          // matching a known session. Synthesizing readiness instead would silently
          // clear the auto-approve indicator on exactly the sessions that have it.
          if (ready) useAssistantStore.getState().applyEvent(ready);
          else useAssistantStore.getState().setConnection("ready", null);
          // Said UP FRONT rather than at first use. Without the control plane the
          // assistant can still talk but cannot spawn an agent or drive the IDE, and
          // the engine only reports that when a tool call fails — by which point it
          // reads as the assistant being broken rather than not connected to Daintree.
          useAssistantStore.getState().setMcpUnavailable(mcpUnavailableReason ?? null);
          if (mcpUnavailableReason) {
            useAssistantStore
              .getState()
              .pushNotice(
                "warning",
                `Daintree tools are unavailable, so the assistant can't spawn agents or change the IDE. ${mcpUnavailableReason}`
              );
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message = formatErrorMessage(error, "The assistant engine could not start.");
          logError("assistant-host start failed", error);
          const store2 = useAssistantStore.getState();
          store2.setConnection("error", message);
          store2.pushNotice("error", message);
        })
    );

    return () => {
      // Marked FIRST: a start still awaiting readiness resolves after this, and the
      // flag is what makes it stop the engine it created instead of adopting it.
      cancelled = true;
      const current = sessionIdRef.current;
      sessionIdRef.current = null;
      buffer.clear();
      if (current) safeFireAndForget(window.electron.assistantHost.stop(current));
    };
    // `opts` is destructured above, so the effect depends on the four VALUES rather
    // than on the options object — which callers rebuild every render.
  }, [projectId, cwd, enabled, restartNonce]);

  const send = useCallback((command: Parameters<typeof window.electron.assistantHost.send>[0]) => {
    safeFireAndForget(window.electron.assistantHost.send(command));
  }, []);

  const submit = useCallback(
    (text: string): boolean => {
      const sessionId = sessionIdRef.current;
      // No session yet (still starting) or it has stopped. Report the refusal so the
      // composer keeps the draft instead of eating it. `connection` is checked as well
      // as the id because Enter bypasses the disabled Send button, and the window
      // between "engine exited" and the store settling is exactly when someone who
      // just typed hits it.
      if (!sessionId) return false;
      if (useAssistantStore.getState().connection !== "ready") return false;
      // A slash line is a COMMAND, not conversation. Sending it as a prompt makes the
      // model answer a question about the word — "/clear" produces prose about clearing
      // while the conversation stays exactly as it was — and spends a turn doing it. The
      // engine routes it through the same handler the CLI's REPL uses, so an embedded
      // session cannot support a different command set from the one the CLI documents.
      //
      // The slash must be followed by a letter: "/" alone, or "/tmp/foo" pasted as a
      // path, is ordinary text someone is typing at the assistant.
      if (/^\/[a-zA-Z]/.test(text)) {
        useAssistantStore.getState().appendUserTurn(text);
        send({ type: "command", sessionId, line: text });
        return true;
      }

      // Appended locally because the engine does not echo the prompt back — and a
      // prompt sent mid-turn is folded into the RUNNING turn as an interjection, so
      // the store's own turn list is the only place a user turn exists.
      const localTurnId = useAssistantStore.getState().appendUserTurn(text);
      // The local checks above can only see what the renderer knows. The engine can
      // exit between them and main receiving this command, in which case main answers
      // `delivered: false` — and taking that as success leaves a user turn in the
      // transcript that nothing will ever answer. Take it back out and say so.
      safeFireAndForget(
        window.electron.assistantHost
          .send({ type: "prompt", sessionId, text })
          .then(({ delivered }) => {
            if (delivered) return;
            const store = useAssistantStore.getState();
            // Null when the text was QUEUED as an interjection rather than appended as
            // a turn of its own — there is nothing to take back in that case.
            if (localTurnId) store.dropLocalTurn(localTurnId);
            store.pushNotice("error", "That message didn't reach the assistant — it has stopped.");
          })
      );
      return true;
    },
    [send]
  );

  const interrupt = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId) send({ type: "interrupt", sessionId });
  }, [send]);

  const decideApproval = useCallback(
    (approvalId: string, decision: "approved" | "rejected") => {
      const sessionId = sessionIdRef.current;
      if (sessionId) send({ type: "approval:decide", sessionId, approvalId, decision });
    },
    [send]
  );

  const answerQuestion = useCallback(
    (questionId: string, index: number) => {
      const sessionId = sessionIdRef.current;
      if (sessionId) send({ type: "question:answer", sessionId, questionId, index });
    },
    [send]
  );

  return { submit, interrupt, decideApproval, answerQuestion };
}
