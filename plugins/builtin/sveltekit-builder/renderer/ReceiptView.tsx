import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ReceiptState } from "./inspectorController.js";
import { InspectorNotice } from "./InspectorNotice.js";
import { basename } from "./copy.js";

const SURFACE_NOUN: Record<ReceiptState["surface"], string> = {
  text: "Text",
  classes: "Classes",
};

/**
 * What the last write proved, as a footer the drawer can afford to keep.
 *
 * Saved, rendered and styled stay three separate observations — main proves
 * only the first, a later document proves the second, and nothing in this
 * panel can prove the third. That distinction is the point and does not move.
 *
 * What moved is the footprint. Pinned to the foot of the drawer this block was
 * spending ~180px, and a pinned 180px is 180px the scrolling body loses on
 * every viewport — after a real edit the composer was mostly out of sight. The
 * resting shape is now a 28px operation row carrying Undo, then one line per
 * fact. The explanation of the styles caveat and the full path sit behind a
 * disclosure, because they are the same every time and the user who has read
 * them once does not need them pinned.
 *
 * It says which surface was written, never what the new value is: the receipt
 * carries a range and revisions, not the text, and inventing a diff from them
 * would be reporting a conclusion the panel cannot support.
 */
export function ReceiptView({ state, onUndo }: { state: ReceiptState; onUndo: () => void }) {
  const { receipt, previewRefreshed, undo } = state;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const verb = state.kind === "undo" ? "restored" : "saved";
  const headline = `${SURFACE_NOUN[state.surface]} ${verb} in ${basename(receipt.file)}`;
  const undoable = undo && undo.status !== "superseded";
  const copies = receipt.affectedOccurrences;

  return (
    <section aria-label="Last change" className="flex max-h-[45vh] min-h-0 flex-col gap-1.5">
      <div
        role="status"
        aria-live="polite"
        className="flex h-7 shrink-0 items-center justify-between gap-2"
      >
        <p className="min-w-0 truncate text-xs font-medium text-text-primary" title={headline}>
          {headline}
        </p>
        {undoable ? (
          <Button
            // The footer's one action, for a write to the user's file: the
            // neutral high-contrast CTA, not a chip.
            variant="contrast"
            size="xs"
            loading={undo.status === "pending"}
            onClick={onUndo}
            className="shrink-0"
          >
            {undo.status === "failed" ? "Retry undo" : "Undo"}
          </Button>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
        {/* Label / value rows in the drawer's own grammar, rather than three
          icon-led lines of equal weight that read as a list of disclaimers. Each
          value is an observation: "unconfirmed" until a later document proves the
          reload, "unverified" because nothing here reads computed styles back. */}
        <dl className="flex flex-col gap-0.5 text-xs">
          <Fact label="Preview">{previewRefreshed ? "reloaded" : "refresh unconfirmed"}</Fact>
          {state.surface === "classes" ? <Fact label="Styles">unverified</Fact> : null}
          {copies > 1 ? <Fact label="Copies">{`${copies} rendered, all changed`}</Fact> : null}
        </dl>

        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((open) => !open)}
            className="-ml-1 flex w-fit items-center gap-1 rounded-[var(--radius-sm)] px-1 py-0.5 text-3xs text-text-secondary transition-colors duration-150 ease-out hover:text-text-primary"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3 w-3 transition-transform duration-150 ease-out",
                detailsOpen && "rotate-90"
              )}
            />
            Details
          </button>
          {detailsOpen ? (
            <div
              id={detailsId}
              className="flex flex-col gap-1 rounded-md border border-border-subtle bg-surface-inset px-2.5 py-2 text-3xs text-text-secondary"
            >
              <p className="break-all font-mono" title={receipt.file}>
                {receipt.file}
              </p>
              {state.surface === "classes" ? (
                <p>
                  A class can reach the page without generating any CSS, and nothing here can read
                  the page's computed styles back — so the write is proven, the effect is not.
                </p>
              ) : null}
              {copies > 1 ? (
                <p>{`The same markup draws ${copies} elements; the write changed all of them.`}</p>
              ) : null}
            </div>
          ) : null}
        </div>

        {undo?.status === "superseded" ? (
          <InspectorNotice
            tone="warning"
            title="Can't undo — the file changed since this edit"
            density="compact"
          >
            Undoing now would overwrite newer changes. Review {basename(receipt.file)} instead.
          </InspectorNotice>
        ) : null}
        {undo?.status === "failed" ? (
          <InspectorNotice tone="error" title="Undo failed" role="alert" density="compact">
            {undo.message}
          </InspectorNotice>
        ) : null}
      </div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: string }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 leading-5">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="truncate text-text-primary">{children}</dd>
    </div>
  );
}
