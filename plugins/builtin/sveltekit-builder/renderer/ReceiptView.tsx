import type { ComponentType } from "react";
import { CircleHelp, Clock, FileCheck, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReceiptState } from "./inspectorController.js";
import { InspectorNotice } from "./InspectorNotice.js";
import { basename, plural } from "./copy.js";

/**
 * What the last write proved, one fact per row. Saved, rendered and styled are
 * separate observations: main proves only the first, a later document proves
 * the second, and nothing in this panel can prove the third — so it says so.
 */
export function ReceiptView({ state, onUndo }: { state: ReceiptState; onUndo: () => void }) {
  const { receipt, previewRefreshed, undo } = state;
  const verb = state.kind === "undo" ? "Undone" : "Saved";
  const headline = previewRefreshed
    ? `${verb} — preview reloaded`
    : `${verb} — preview not yet refreshed`;

  return (
    <section
      aria-label="Last change"
      className="flex flex-col gap-2 rounded-md border border-border-subtle bg-surface-inset px-3 py-2"
    >
      <div role="status" aria-live="polite" className="flex flex-col gap-0.5">
        <p className="text-xs font-medium text-text-primary">{headline}</p>
        <p className="truncate font-mono text-3xs text-text-secondary" title={receipt.file}>
          {receipt.file}
        </p>
      </div>
      <ul className="flex flex-col gap-1 text-xs text-text-secondary">
        <Fact icon={FileCheck}>
          {state.kind === "undo"
            ? `Source restored in ${basename(receipt.file)}`
            : `Source saved to ${basename(receipt.file)}`}
        </Fact>
        <Fact icon={previewRefreshed ? RefreshCw : Clock}>
          {previewRefreshed ? "Preview reloaded since the write" : "Preview not yet refreshed"}
        </Fact>
        {state.surface === "classes" ? (
          <Fact icon={CircleHelp}>
            Styles not verified — a class can reach the page without generating any CSS
          </Fact>
        ) : null}
        {receipt.affectedOccurrences > 1 ? (
          <Fact icon={CircleHelp}>
            {`Affects ${plural(receipt.affectedOccurrences, "rendered copy", "rendered copies")}`}
          </Fact>
        ) : null}
      </ul>
      {undo?.status === "superseded" ? (
        <InspectorNotice tone="warning" title="Can't undo — the file changed since this edit">
          Undoing now would overwrite newer changes. Review {basename(receipt.file)} instead.
        </InspectorNotice>
      ) : null}
      {undo?.status === "failed" ? (
        <InspectorNotice tone="error" title="Undo failed" role="alert">
          {undo.message}
        </InspectorNotice>
      ) : null}
      {undo && undo.status !== "superseded" ? (
        <div>
          <Button variant="subtle" size="xs" loading={undo.status === "pending"} onClick={onUndo}>
            {undo.status === "failed" ? "Retry undo" : "Undo"}
          </Button>
        </div>
      ) : null}
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
