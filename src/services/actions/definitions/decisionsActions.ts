import type { ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { decisionsClient } from "@/clients/decisionsClient";
import {
  failToOpen,
  openDecisionsInbox,
  requireHostInbox,
  type DecisionsOpenCaller,
} from "@/components/Decisions/decisionsHostInbox";
import { inboxGroupOf } from "@/components/Decisions/decisionsInboxModel";
import { readDecisionsSwitch } from "@/hooks/useDecisionsOn";
import { isWaitingOnPerson } from "@shared/utils/decisionWaiting";
import { actionService } from "@/services/ActionService";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";

const OFF_REASON = "Decisions is off. Turn it on in Settings > Decisions.";
const UNKNOWN_REASON = "Decisions hasn't said whether it's on yet.";

/**
 * Listed unless Decisions is known to be off, in a Remote Host's window too:
 * this computer's inbox lists the questions of every Host it enrolled (#18049).
 */
function listed(): boolean {
  return readDecisionsSwitch() !== "off";
}

/**
 * Run only once the view's switch says on, the same switch the inbox and the
 * question view read before they read any question.
 */
function runnable(): boolean {
  return readDecisionsSwitch() === "on";
}

/** An agent reads the dispatch's result, and a caller that shows the failure itself needs no toast. */
function callerOf(ctx: ActionContext): DecisionsOpenCaller {
  return { quiet: ctx.dispatchSource === "agent" || ctx.callerReportsFailure === true };
}

function notRunnableReason(): string | undefined {
  switch (readDecisionsSwitch()) {
    case "on":
      return undefined;
    case "off":
      return OFF_REASON;
    case "unknown":
      return UNKNOWN_REASON;
  }
}

/**
 * Opens the oldest question in Needs you, from which the others there can be
 * stepped through, once the inbox is known to hold this window's questions:
 * asked after the list is read, so the answer is the latest before it opens.
 */
async function openNextQuestion(): Promise<void> {
  const list = await decisionsClient.listQuestions();
  await requireHostInbox();
  // Every question still in Needs you, opened at the oldest the person hasn't seen yet (#17895):
  // one they've seen and left is still theirs to answer, one they cleared isn't stepped to.
  // One whose deadline passed by this computer's clock can't be answered any more (#17943).
  const now = Date.now();
  const waiting = list.questions.filter((item) => inboxGroupOf(item, now) === "needs-you");
  const next = waiting.find((item) => isWaitingOnPerson(item, now)) ?? waiting[0];
  // Switched off while the list was read: nothing it held is still asked.
  if (next === undefined || !runnable()) return;
  useDecisionsQuestionViewStore.getState().openReference(
    waiting.map((item) => item.reference),
    next.reference,
    // An answered question back in Needs you opens at the follow-up asking for a reply.
    next.replyRequest ?? undefined
  );
}

/**
 * The Decisions views (#17236). Both only open a view: answering, declining
 * and cancelling stay with the person's own clicks inside it. In a Remote
 * Host's window each first settles that this computer's inbox lists its
 * Host's questions, and says plainly when it doesn't (#18049).
 */
export function registerDecisionsActions(actions: ActionRegistry): void {
  actions.set("decisions.openInbox", () => ({
    id: "decisions.openInbox",
    title: "Open Decisions inbox",
    description:
      "Open the Decisions inbox: every question agents asked through Decisions on this computer or a Remote Host it enrolled, those waiting on the user first, then answers being delivered and past decisions. Only opens the view",
    paletteDescription: "Every question your agents asked through Decisions",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    isVisible: listed,
    isEnabled: runnable,
    disabledReason: notRunnableReason,
    keywords: ["decisions", "inbox", "questions", "waiting", "asked", "answers"],
    selfNotifiesOnExecutionError: true,
    run: async (_args, ctx) => {
      await openDecisionsInbox(undefined, callerOf(ctx));
    },
  }));

  actions.set("decisions.openNextQuestion", () => ({
    id: "decisions.openNextQuestion",
    title: "Open next Decisions question",
    description:
      "Open the oldest Decisions question waiting on the user, from which the others waiting can be stepped through in order. Does nothing when none is waiting. Only opens the view",
    paletteDescription: "Open the oldest question waiting on you",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    isVisible: listed,
    isEnabled: runnable,
    disabledReason: notRunnableReason,
    keywords: ["decisions", "question", "next", "waiting", "answer", "reply"],
    selfNotifiesOnExecutionError: true,
    run: async (_args, ctx) => {
      // Every failure, read or refusal, is reported here once.
      try {
        await openNextQuestion();
      } catch (error) {
        failToOpen(error, "Couldn't open Decisions question", callerOf(ctx), {
          label: "Try again",
          actionId: "decisions.openNextQuestion",
          onClick: () => {
            void actionService.dispatch("decisions.openNextQuestion", undefined, {
              source: "user",
            });
          },
        });
      }
    },
  }));
}
