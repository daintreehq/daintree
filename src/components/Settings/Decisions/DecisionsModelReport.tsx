import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import type { DecisionsModelReport as Report } from "@shared/types/decisionsModel";
import {
  abstainReasonText,
  bucketRangeText,
  confidenceText,
  matchedText,
  reportSummary,
} from "./decisionModelCopy";

const TH = "py-1.5 font-medium text-text-secondary";
const TD_NUM = "py-1.5 text-right tabular-nums";

/**
 * The evaluation report (#16027): how often the replay matched the person's
 * own answers, by the model's confidence, then the rest of what it counted
 * behind a disclosure. Counts only; no question is named.
 */
export function DecisionsModelReport({ report }: { report: Report }) {
  const kinds = Object.entries(report.byKind);
  const reasons = Object.entries(report.abstainReasons).sort((a, b) => b[1] - a[1]);
  const last = report.buckets.length - 1;
  return (
    <div className="mt-2 space-y-3 select-text">
      <p>{reportSummary(report)}</p>
      {report.buckets.length > 0 && (
        <table className="w-full table-fixed text-xs">
          <caption className="sr-only">Matches with your answers, by the model's confidence</caption>
          <thead>
            <tr className="border-b border-border-subtle">
              <th scope="col" className={cn(TH, "text-left pr-2")}>
                Model&apos;s confidence
              </th>
              <th scope="col" className={cn(TH, "text-right px-2 w-24")}>
                Answered
              </th>
              <th scope="col" className={cn(TH, "text-right pl-2 w-36")}>
                Matched you
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {report.buckets.map((bucket, index) => (
              <tr key={bucket.lo}>
                <th
                  scope="row"
                  className="py-1.5 pr-2 text-left font-normal tabular-nums text-text-primary"
                >
                  {bucketRangeText(bucket, index === last)}
                </th>
                <td className={cn(TD_NUM, "px-2 text-text-primary")}>{bucket.answered}</td>
                <td className={cn(TD_NUM, "pl-2 text-text-primary")}>
                  {bucket.answered === 0 ? "—" : matchedText(bucket.matched, bucket.answered)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details className="group">
        <summary className="flex w-fit cursor-pointer select-none items-center gap-1 rounded-[var(--radius-xs)] text-xs text-text-secondary transition-colors duration-150 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary">
          <ChevronRight
            className="size-3.5 transition-transform duration-150 group-open:rotate-90"
            aria-hidden="true"
          />
          More from this evaluation
        </summary>
        <ul className="mt-2 space-y-1">
          <li>
            Read {pluralize(report.total, "past answer")}, {report.total - report.scored} with no
            choice among options to compare. It gave no answer for {report.abstained} of the rest.
          </li>
          {kinds.map(([kind, value]) => (
            <li key={kind}>
              <span className="font-mono">{kind}</span>: matched{" "}
              {matchedText(value.matched, value.answered)}
            </li>
          ))}
          {reasons.map(([code, value]) => (
            <li key={code}>
              No answer, {abstainReasonText(code)}: {value}
            </li>
          ))}
          <li>
            A confidence can answer automatically only when at least {report.minSamples} replayed
            answers reached it and {Math.round(report.targetAccuracy * 100)}% of them matched yours.
            {report.recommendedThreshold === null
              ? " No confidence met that."
              : ` The lowest that did was ${confidenceText(report.recommendedThreshold)}.`}
          </li>
        </ul>
      </details>
    </div>
  );
}
