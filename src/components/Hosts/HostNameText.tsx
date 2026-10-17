import { cn } from "@/lib/utils";
import { splitHostName } from "./hostModel";

/**
 * A host's name that keeps its distinguishing tail when it has to clip:
 * "build-runner-eu-west-07.ci.internal" loses the middle of its label and its
 * domain before it loses "west-07", so a column of near-identical machine
 * names never clips down to the same prefix.
 */
export function HostNameText({ name, className }: { name: string; className?: string }) {
  const { nameHead, nameTail, nameDomain } = splitHostName(name);
  return (
    <span className={cn("flex min-w-0", className)} title={name}>
      {nameHead && <span className="min-w-0 truncate">{nameHead}</span>}
      <span className="shrink-0 whitespace-pre">{nameTail}</span>
      {nameDomain && <span className="min-w-0 truncate">{nameDomain}</span>}
    </span>
  );
}
