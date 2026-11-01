import { cn } from "@/lib/utils";
import { splitHostName } from "./hostModel";

/**
 * A host's name that keeps its distinguishing tail when it has to clip:
 * "build-runner-eu-west-07.ci.internal" loses its domain first, then the
 * middle of its label, before it loses "west-07", so a column of
 * near-identical machine names never clips down to the same prefix. A few
 * characters of a long head always stay — "g…" names nothing.
 *
 * `title` off is for a caller whose own tooltip already says the full name;
 * `headFloor` replaces the 4ch floor for a caller so narrow that the floor
 * would cost the tail.
 */
export function HostNameText({
  name,
  className,
  title = true,
  headFloor = "min-w-[4ch]",
}: {
  name: string;
  className?: string;
  title?: boolean;
  headFloor?: string;
}) {
  const { nameHead, nameTail, nameDomain } = splitHostName(name);
  return (
    <span className={cn("flex min-w-0", className)} title={title ? name : undefined}>
      {nameHead && (
        // The floor only for a head long enough to need it: a short head in a
        // proportional face can be narrower than 4ch, and the floor then
        // opened a gap inside the name ("build -east-02").
        <span
          className={cn(
            "truncate",
            nameHead.length > 7 ? headFloor : nameHead.length > 4 ? "min-w-0" : "shrink-0"
          )}
        >
          {nameHead}
        </span>
      )}
      <span className="shrink-0 whitespace-pre">{nameTail}</span>
      {nameDomain && <span className="min-w-0 shrink-[100] truncate">{nameDomain}</span>}
    </span>
  );
}
