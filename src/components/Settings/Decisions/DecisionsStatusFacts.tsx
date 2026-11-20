import { type ReactNode, useEffect, useState } from "react";
import { FactRun } from "@/components/ui/FactSeparator";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { decisionsClient } from "@/clients/decisionsClient";
import { useRemoteHostName } from "@/hooks/useSettingsOwner";
import { pluralize } from "@/lib/pluralize";
import { formatTimeAgo } from "@/utils/timeAgo";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import type { DecisionQuestionListItem } from "@shared/types/decisionsQuestion";
import { useDecisionsAgentSupport } from "./DecisionsAgentsSection";
import { deviceKind } from "./devicesCopy";
import type { UseDecisionsDevicesResult } from "./useDecisionsDevices";
import type { UseDecisionsPolicyResult } from "./useDecisionsPolicy";

export type LatestDecisionQuestion =
  | { state: "reading" }
  | { state: "failed" }
  /** `askedAt` in epoch ms; null when the list holds no question with a readable time. */
  | { state: "read"; empty: boolean; askedAt: number | null };

function newestAskedAt(questions: readonly DecisionQuestionListItem[]): number | null {
  let newest: number | null = null;
  for (const question of questions) {
    const askedAt = Date.parse(question.askedAt);
    if (Number.isFinite(askedAt) && (newest === null || askedAt > newest)) newest = askedAt;
  }
  return newest;
}

/**
 * When the newest question this computer holds was asked, its enrolled
 * Hosts' included, kept current with the list (#17229) while mounted.
 */
export function useLatestDecisionQuestion(): LatestDecisionQuestion {
  const [latest, setLatest] = useState<LatestDecisionQuestion>({ state: "reading" });
  useEffect(
    () =>
      decisionsClient.watchQuestions(
        (list) =>
          setLatest({
            state: "read",
            empty: list.questions.length === 0,
            askedAt: newestAskedAt(list.questions),
          }),
        () => setLatest({ state: "failed" })
      ),
    []
  );
  return latest;
}

function phonesFact({ devices, failure }: UseDecisionsDevicesResult): string {
  if (devices === null) return failure === null ? "Reading phones…" : "Phones couldn't be read";
  const notified = devices.filter(
    (device) => deviceKind(device.role) === "answers" && device.pushEnabled
  );
  if (notified.length === 0) return "No phones with notifications";
  const noun = notified.every((device) => device.role === "phone") ? "phone" : "device";
  return `${pluralize(notified.length, noun)} with notifications`;
}

function agentsFact(
  { policy, loadError }: UseDecisionsPolicyResult,
  supported: readonly string[],
  installedRead: boolean,
  installedError: string | null
): string {
  if (policy === null) return loadError === null ? "Reading agents…" : "Agents couldn't be read";
  if (!installedRead)
    return installedError === null ? "Reading agents…" : "Agents couldn't be read";
  // The switches the Agents section shows: one left on for an agent since removed isn't counted.
  const on = supported.filter((id) => policy.askHumanAgents.includes(id)).length;
  return on === 0 ? "No agents switched on" : `${pluralize(on, "agent")} switched on`;
}

function questionFact(latest: LatestDecisionQuestion): string | number {
  switch (latest.state) {
    case "reading":
      return "Reading questions…";
    case "failed":
      return "Questions couldn't be read";
    case "read":
      if (latest.askedAt !== null) return latest.askedAt;
      return latest.empty ? "No questions yet" : "Last question time unknown";
  }
}

/**
 * One line of what was observed about the rest of Decisions while the relay
 * is connected (#18059): phones the relay can notify, agents switched on to
 * ask, and when the last question came in. Every fact holds its place from
 * the first render, and the line never wraps, so the page doesn't move as
 * the facts arrive; in a narrow window its tail is clipped, and the whole
 * line is its title. A remote window's agents are the Host's, so it names none.
 */
export function DecisionsStatusFacts({
  devices,
  policy,
}: {
  devices: UseDecisionsDevicesResult;
  policy: UseDecisionsPolicyResult;
}) {
  const { supported } = useDecisionsAgentSupport();
  const installedRead = useCliAvailabilityStore((state) => state.hasRealData);
  const installedError = useCliAvailabilityStore((state) => state.error);
  const remote = useRemoteHostName() !== null;
  const latest = useLatestDecisionQuestion();

  const words = [phonesFact(devices)];
  if (!remote) words.push(agentsFact(policy, supported, installedRead, installedError));
  const question = questionFact(latest);
  const facts: ReactNode[] = [...words];
  if (typeof question === "number") {
    words.push(`Last question ${formatTimeAgo(question)}`);
    facts.push(<TimeAgo timestamp={question} prefix="Last question " />);
  } else {
    words.push(question);
    facts.push(question);
  }
  return (
    <span className="block truncate" title={words.join(" · ")} data-testid="decisions-status-facts">
      <FactRun facts={facts} />
    </span>
  );
}
