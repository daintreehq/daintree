import { cn } from "@/lib/utils";
import type { AccountHeadroom } from "@/utils/agentAccountHeadroom";

/**
 * The second line of an account choice (#16407): the tightest window known for
 * it. Wraps rather than truncates, because the reset time and the "observed"
 * age are the parts a truncation would take. Nothing without a reading.
 */
export function AccountHeadroomHint({
  headroom,
  className,
}: {
  headroom: AccountHeadroom | undefined;
  className?: string;
}) {
  if (!headroom) return null;
  return (
    <span className={cn("block max-w-64 text-xs text-text-secondary", className)}>
      {headroom.text}
    </span>
  );
}

/** A choice's name with its headroom beneath it, for a menu row. */
export function AccountChoiceText({
  name,
  headroom,
}: {
  name: string;
  headroom: AccountHeadroom | undefined;
}) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">{name}</span>
      <AccountHeadroomHint headroom={headroom} />
    </span>
  );
}
