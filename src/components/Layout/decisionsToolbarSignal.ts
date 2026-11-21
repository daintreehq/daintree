import { pluralize } from "@/lib/pluralize";

/**
 * What needs the person, in the Decisions inbox button's words, shared by the
 * button and its row in `…`: the questions to answer, then the deliveries
 * stopped on their answers (#18045).
 */
export function decisionsObservations(waiting: number, stopped: number): string[] {
  const observations: string[] = [];
  if (waiting > 0) observations.push(`${pluralize(waiting, "question")} waiting`);
  if (stopped > 0) observations.push(`${pluralize(stopped, "delivery", "deliveries")} stopped`);
  return observations;
}
