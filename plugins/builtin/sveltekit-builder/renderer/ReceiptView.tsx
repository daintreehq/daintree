import type { ComponentType } from "react";
import { CircleHelp, Clock, Copy, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReceiptState } from "./inspectorController.js";
import { InspectorNotice } from "./InspectorNotice.js";
import { SectionHeader } from "./InspectorSection.js";
import { basename, middleTruncate, plural } from "./copy.js";

const SURFACE_NOUN: Record<ReceiptState["surface"], string> = {
  text: "Text",
  classes: "Classes",
};

/**
 * What the last write proved.
 *
 * Saved, rendered and styled stay three separate observations — main proves only
 * the first, a later document proves the second, and nothing in this panel can
 * prove the third. That distinction is the point of the block and does not move.
 *
 * What changed is the shape. The headline used to be `Saved — preview not yet
 * refreshed` above a fact list that then said `Source saved to +page.svelte` and
 * `Preview not yet refreshed` again: the same two facts twice, in a card the
 * user had to scroll past the whole composer to reach, with Undo at the bottom
 * of it. Now the header names the operation and carries Undo on its own row, and
 * the facts below say only what the header has not.
 *
 * The fact list carries only what the headline has not: the headline already
 * says the write landed and where, so "Source saved on disk" underneath it was
 * the third statement of one fact.
 *
 * It says which surface was written, never what the new value is: the receipt
 * carries a range and revisions, not the text, and inventing a diff from them
 * would be reporting a conclusion the panel cannot support.
 */
export function ReceiptView({ state, onUndo }: { state: ReceiptState; onUndo: () => void }) {
  const { receipt, previewRefreshed, undo } = state;
  const verb = state.kind === "undo" ? "restored" : "saved";
  const headline = `${SURFACE_NOUN[state.surface]} ${verb} in ${basename(receipt.file)}`;
  const undoable = undo && undo.status !== "superseded";

  return (
    <section aria-label="Last change" className="flex flex-col">
      <SectionHeader
        title="Last change"
        action={
          undoable ? (
            <Button variant="subtle" size="xs" loading={undo.status === "pending"} onClick={onUndo}>
              {undo.status === "failed" ? "Retry undo" : "Undo"}
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-surface-inset px-3 py-2">
        <div role="status" aria-live="polite" className="flex flex-col gap-0.5">
          <p className="text-xs font-medium text-text-primary">{headline}</p>
          <p className="truncate font-mono text-3xs text-text-secondary" title={receipt.file}>
            {middleTruncate(receipt.file)}
          </p>
        </div>
        <ul className="flex flex-col gap-1 text-xs text-text-secondary">
          <Fact icon={previewRefreshed ? RefreshCw : Clock}>
            {previewRefreshed ? "Preview reloaded since the write" : "Preview not yet refreshed"}
          </Fact>
          {state.surface === "classes" ? (
            <Fact icon={CircleHelp}>
              Styles not verified — a class can reach the page without generating any CSS
            </Fact>
          ) : null}
          {receipt.affectedOccurrences > 1 ? (
            // A distinct glyph: this and the styles caveat were both a
            // question-mark circle, so two unrelated facts read as one repeated.
            <Fact icon={Copy}>
              {`Affects ${plural(receipt.affectedOccurrences, "rendered copy", "rendered copies")}`}
            </Fact>
          ) : null}
        </ul>
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

function Fact({
  icon: Icon,
  children,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  children: string;
}) {
  return (
    <li className="flex items-start gap-1.5">
      <Icon className="mt-px h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}
