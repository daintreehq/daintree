import { useCallback, useEffect, useRef } from "react";
import { useAssistantStore } from "@/store/assistantStore";
import type { AssistantHostEvent } from "@shared/types/ipc/assistantHost";
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
  /** Ask the engine for a fresh operations reading. */
  requestOperations: () => void;
}

/**
 * How many frames the adoption gap will hold.
 *
 * The gap is milliseconds wide in practice, so this is a backstop rather than a
 * budget: a start that never resolves must not let a chatty engine grow this without
 * limit. Dropping the tail of an over-long boot burst is better than holding it all,
 * and the sequence numbers make the loss visible rather than silent.
 */
const MAX_PRE_ADOPTION_FRAMES = 500;

/**
 * Whether `text` should be run as a command rather than sent to the model.
 *
 * Matched against the engine's ADVERTISED CATALOG, not against "starts with a slash".
 * A shape test alone swallows ordinary text — "/tmp/foo is missing" and "/review this
 * diff" both begin with a slash and a letter, and neither is a command.
 */
function isCommandInput(text: string): boolean {
  // `/?` is the help alias; it has no letter, so it is matched before the word form.
  if (text.trim() === "/?") return true;
  const match = /^\/([a-zA-Z][\w-]*)(?:\s|$)/.exec(text);
  if (!match) return false;
  const name = (match[1] ?? "").toLowerCase();
  // Aliases the engine's parser accepts but the registry does not list.
  if (name === "q" || name === "exit") return true;
  // The catalog spells names WITH the leading slash. Normalising both sides here is
  // what makes a command with arguments — "/tools git" — reach the command path;
  // comparing a bare word against "/tools" never matched, so every command that takes
  // an argument was being sent to the model instead.
  if (
    useAssistantStore
      .getState()
      .commands.some((c) => c.name.replace(/^\//, "").toLowerCase() === name)
  ) {
    return true;
  }
  // Not a command we know — but a BARE slash word with nothing after it is not prose
  // either, it is a typo, and answering "/stauts" with a paragraph about the word is
  // worse than saying it is not a command. Anything with arguments ("/review this
  // diff") or a path shape ("/tmp/foo is missing") goes to the model as written.
  return /^\/[a-zA-Z][\w-]*$/.test(text);
}

export function useAssistantSession(opts: AssistantSessionOptions): AssistantSessionActions {
  const sessionIdRef = useRef<string | null>(null);
  /** Non-null while a start is in flight, so stray frames can be told apart from noise. */
  const pendingSessionRef = useRef<number | null>(null);
  /** Frames that arrived before this hook learned its session id. */
  const preAdoptionRef = useRef<AssistantHostEvent[]>([]);
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

  const send = useCallback((command: Parameters<typeof window.electron.assistantHost.send>[0]) => {
    safeFireAndForget(window.electron.assistantHost.send(command));
  }, []);

  // Subscribe once; the listeners live as long as the component.
  useEffect(() => {
    const offEvent = window.electron.assistantHost.onEvent((event) => {
      if (event.sessionId !== sessionIdRef.current) {
        // Not ours — OR ours before we were told our own id. `start()` resolving is
        // what adopts the session, and the engine keeps talking in the meantime; main
        // buffers what it can, but anything emitted after that hand-off and before
        // this ref is set would fall through the gap between them. Held here and
        // applied on adoption, so the boundary needs no acknowledgement protocol.
        if (
          sessionIdRef.current === null &&
          pendingSessionRef.current !== null &&
          preAdoptionRef.current.length < MAX_PRE_ADOPTION_FRAMES
        ) {
          preAdoptionRef.current.push(event);
        }
        return;
      }
      if (event.type === "turn:token") {
        const prior = pendingTokens.current.get(event.turnId);
        pendingTokens.current.set(event.turnId, {
          sessionId: event.sessionId,
          chunk: (prior?.sessionId === event.sessionId ? prior.chunk : "") + event.chunk,
        });
        scheduleFlush();
        return;
      }
      // A standing grant answers before the card is ever built. Decided HERE rather
      // than after applying, so a granted approval never flashes a sheet the user did
      // not need to see.
      if (event.type === "approval:requested") {
        const covered = useAssistantStore.getState().consumeGrant({
          grantKey: event.toolKey ?? event.toolId,
          rememberable: event.rememberable ?? false,
          needsTypedConfirm: event.needsTypedConfirm,
        });
        if (covered) {
          send({
            type: "approval:decide",
            sessionId: event.sessionId,
            approvalId: event.approvalId,
            decision: "approved",
          });
          return;
        }
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
      // Everything the engine left mid-flight is settled too. Without this the phase
      // line kept reading "Working" and an approval card kept waiting for an answer
      // that nothing was left to receive.
      s.endLiveState();
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
  }, [flushTokens, scheduleFlush, send]);

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
    pendingSessionRef.current = Date.now();
    preAdoptionRef.current = [];

    safeFireAndForget(
      window.electron.assistantHost
        .start({ projectId, cwd })
        .then(({ sessionId, ready, replay, mcpUnavailableReason }) => {
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
          // PROVISIONING's reading first — what main knew when it spawned the engine.
          // Said up front rather than at first use: without the control plane the
          // assistant can still talk but cannot spawn an agent, and the engine only
          // reports that when a tool call fails, by which point it reads as the
          // assistant being broken rather than not connected to Daintree.
          useAssistantStore.getState().setMcpUnavailable(mcpUnavailableReason ?? null);
          // Then whatever the engine said while nobody could hear it, in order. This
          // comes SECOND deliberately: it is the engine's own verdict on its control
          // plane, and it supersedes what main inferred at spawn time.
          //
          // Main's buffer first, then anything this hook caught in the hand-off gap,
          // de-duplicated by sequence: the two windows abut but a frame can appear in
          // both, and applying one twice would double a token or re-open a card.
          const seen = new Set<number>();
          // The ready frame counts as already applied: it is handed back separately
          // AND can appear in the hook's own buffer, and applying it twice would reset
          // the session's masthead and connection state on top of itself.
          if (ready) seen.add(ready.seq);
          for (const event of replay ?? []) {
            seen.add(event.seq);
            useAssistantStore.getState().applyEvent(event);
          }
          for (const event of preAdoptionRef.current) {
            if (event.sessionId !== sessionId || seen.has(event.seq)) continue;
            useAssistantStore.getState().applyEvent(event);
          }
          preAdoptionRef.current = [];
          pendingSessionRef.current = null;
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
      pendingSessionRef.current = null;
      preAdoptionRef.current = [];
      const current = sessionIdRef.current;
      sessionIdRef.current = null;
      buffer.clear();
      if (current) safeFireAndForget(window.electron.assistantHost.stop(current));
    };
    // `opts` is destructured above, so the effect depends on the four VALUES rather
    // than on the options object — which callers rebuild every render.
  }, [projectId, cwd, enabled, restartNonce]);

  const submit = useCallback((text: string): boolean => {
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
    // Matched against the engine's ADVERTISED CATALOG, not against "starts with a
    // slash". A shape test swallows ordinary text: "/tmp/foo is missing" and
    // "/review this diff" both begin with a slash and a letter, and neither is a
    // command — they would vanish into an unknown-command reply instead of reaching
    // the model.
    if (isCommandInput(text)) {
      const commandTurnId = useAssistantStore.getState().appendUserTurn(text);
      // Standing approvals live HERE, not in the engine — the engine asks each time
      // and this surface answers from its own list. So "/approvals clear" has to be
      // honoured locally as well as forwarded, or the command reports success while
      // every grant it claimed to revoke is still in force.
      if (/^\/approvals\s+clear\b/i.test(text)) {
        useAssistantStore.getState().clearGrants();
      }
      // Delivery is checked here as it is for a prompt. The engine can exit between
      // the local checks and main receiving this, and a command shown as run while
      // nothing received it is the same lie in a different place.
      safeFireAndForget(
        window.electron.assistantHost
          .send({ type: "command", sessionId, line: text })
          .then(({ delivered }) => {
            if (delivered) return;
            const store = useAssistantStore.getState();
            // Either an appended turn or a QUEUED steer, depending on whether a turn
            // was running when it was typed. Both have to be taken back, or a message
            // nothing received is later promoted into a user turn.
            if (commandTurnId) store.dropLocalTurn(commandTurnId);
            else store.dropUndeliveredText(text);
            store.pushNotice("error", "That command didn't reach the assistant — it has stopped.");
          })
      );
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
          // a turn of its own. That entry has to be taken back too, or it is promoted
          // into a user turn at turn:end for a message that never arrived.
          if (localTurnId) store.dropLocalTurn(localTurnId);
          else store.dropUndeliveredText(text);
          store.pushNotice("error", "That message didn't reach the assistant — it has stopped.");
        })
    );
    return true;
  }, []);

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

  const requestOperations = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId) send({ type: "operations", sessionId });
  }, [send]);

  return { submit, interrupt, decideApproval, answerQuestion, requestOperations };
}
