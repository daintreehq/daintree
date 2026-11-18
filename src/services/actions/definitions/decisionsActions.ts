import type { ActionRegistry } from "../actionTypes";
import { decisionsClient } from "@/clients/decisionsClient";
import { readDecisionsSwitch } from "@/hooks/useDecisionsOn";
import { isWaitingOnPerson } from "@/hooks/useDecisionsWaitingCount";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";

const REMOTE_REASON =
  "Decisions questions belong to this computer, not a Remote Host. Open them from one of its own windows.";
const OFF_REASON = "Decisions is off. Turn it on in Settings > Decisions.";

/**
 * Offered in this computer's windows unless Decisions is known to be off:
 * the inbox lists this computer's questions, which a Remote Host window's
 * panes never asked. Before the view has heard, `run` asks main.
 */
function offered(): boolean {
  return !isRemoteWindow() && readDecisionsSwitch() !== "off";
}

function notOfferedReason(): string | undefined {
  if (isRemoteWindow()) return REMOTE_REASON;
  return readDecisionsSwitch() === "off" ? OFF_REASON : undefined;
}

/** Whether Decisions is on, asking main when the view hasn't heard yet. */
async function confirmOn(): Promise<boolean> {
  const known = readDecisionsSwitch();
  if (known !== "unknown") return known === "on";
  return (await decisionsClient.getStatus()).state !== "off";
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
      "Open the Decisions inbox: every question agents asked on this computer, those waiting on the user first, then answers being delivered and past decisions. Only opens the view",
    paletteDescription: "Every question your agents asked through Decisions",
    category: "navigation",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    isVisible: offered,
    isEnabled: offered,
    disabledReason: notOfferedReason,
    keywords: ["decisions", "inbox", "questions", "waiting", "asked", "answers"],
    run: async () => {
      if (!(await confirmOn())) throw new Error(OFF_REASON);
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
    isVisible: offered,
    isEnabled: offered,
    disabledReason: notOfferedReason,
    keywords: ["decisions", "question", "next", "waiting", "answer", "reply"],
    run: async () => {
      if (!(await confirmOn())) throw new Error(OFF_REASON);
      const list = await decisionsClient.listQuestions();
      const waiting = list.questions.filter(isWaitingOnPerson);
      const next = waiting[0];
      // Switched off while the list was read: nothing it held is still asked.
      if (next === undefined || !offered()) return;
      useDecisionsQuestionViewStore.getState().openReference(
        waiting.map((item) => item.reference),
        next.reference,
        // An answered question back in Needs you opens at the follow-up asking for a reply.
        next.replyRequest ?? undefined
      );
    },
  }));
}
