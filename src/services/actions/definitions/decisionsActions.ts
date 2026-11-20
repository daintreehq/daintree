import type { ActionRegistry } from "../actionTypes";
import { decisionsClient } from "@/clients/decisionsClient";
import { inboxGroupOf } from "@/components/Decisions/decisionsInboxModel";
import { readDecisionsSwitch } from "@/hooks/useDecisionsOn";
import { isWaitingOnPerson } from "@/hooks/useDecisionsWaitingCount";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";

const REMOTE_REASON =
  "Decisions questions belong to this computer, not a Remote Host. Open them from one of its own windows.";
const OFF_REASON = "Decisions is off. Turn it on in Settings > Decisions.";
const UNKNOWN_REASON = "Decisions hasn't said whether it's on yet.";

/**
 * Listed in this computer's windows unless Decisions is known to be off: the
 * inbox lists this computer's questions, which a Remote Host window's panes
 * never asked.
 */
function listed(): boolean {
  return !isRemoteWindow() && readDecisionsSwitch() !== "off";
}

/**
 * Run only once the view's switch says on, the same switch the inbox and the
 * question view read before they read any question.
 */
function runnable(): boolean {
  return !isRemoteWindow() && readDecisionsSwitch() === "on";
}

function notRunnableReason(): string | undefined {
  if (isRemoteWindow()) return REMOTE_REASON;
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
 * The Decisions views (#17236). Both only open a view: answering, declining
 * and cancelling stay with the person's own clicks inside it.
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
    run: async () => {
      useDecisionsInboxStore.getState().open();
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
    run: async () => {
      const list = await decisionsClient.listQuestions();
      // Every question still in Needs you, opened at the oldest the person hasn't seen yet (#17895):
      // one they've seen and left is still theirs to answer, one they cleared isn't stepped to.
      const waiting = list.questions.filter((item) => inboxGroupOf(item) === "needs-you");
      const next = waiting.find(isWaitingOnPerson) ?? waiting[0];
      // Switched off while the list was read: nothing it held is still asked.
      if (next === undefined || !runnable()) return;
      useDecisionsQuestionViewStore.getState().openReference(
        waiting.map((item) => item.reference),
        next.reference,
        // An answered question back in Needs you opens at the follow-up asking for a reply.
        next.replyRequest ?? undefined
      );
    },
  }));
}
