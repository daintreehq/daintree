import { useCallback, useState, type ReactElement } from "react";
import { Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

interface SaveFleetFormProps {
  armedCount: number;
}

export function SaveFleetForm({ armedCount }: SaveFleetFormProps): ReactElement {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"snapshot" | "predicate">("snapshot");
  const [predicateScope, setPredicateScope] = useState<"current" | "all">("all");
  const [predicateState, setPredicateState] = useState<"all" | "working" | "waiting" | "finished">(
    "waiting"
  );

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && (kind !== "snapshot" || armedCount > 0);

  const submit = useCallback(() => {
    if (!canSave) return;
    const args =
      kind === "snapshot"
        ? { kind: "snapshot" as const, name: trimmed }
        : {
            kind: "predicate" as const,
            name: trimmed,
            scope: predicateScope,
            stateFilter: predicateState,
          };
    void actionService.dispatch("fleet.saveNamedFleet", args, { source: "user" });
    setName("");
  }, [canSave, kind, trimmed, predicateScope, predicateState]);

  return (
    <DropdownMenuItem
      // Hosting an inline form inside a Radix DropdownMenuItem requires both
      // preventing the default select (which would close the menu on every
      // click inside) and giving the item an empty `textValue` so Radix's
      // typeahead doesn't intercept characters as the user types the name.
      onSelect={(e) => e.preventDefault()}
      textValue=""
      className="flex flex-col items-stretch gap-1.5 py-2"
      data-testid="fleet-save-form"
    >
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-daintree-text/50">
        <Save className="h-3 w-3" />
        <span>Save current as…</span>
      </div>
      <div className="flex gap-1 text-[11px]" role="radiogroup" aria-label="Save fleet flavor">
        <button
          type="button"
          role="radio"
          aria-checked={kind === "snapshot"}
          onClick={(e) => {
            e.stopPropagation();
            setKind("snapshot");
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            "flex-1 rounded px-2 py-1 transition-colors",
            kind === "snapshot"
              ? "bg-tint/[0.14] text-daintree-text"
              : "bg-tint/[0.04] text-daintree-text/70 hover:bg-tint/[0.08]"
          )}
        >
          Snapshot
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={kind === "predicate"}
          onClick={(e) => {
            e.stopPropagation();
            setKind("predicate");
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            "flex-1 rounded px-2 py-1 transition-colors",
            kind === "predicate"
              ? "bg-tint/[0.14] text-daintree-text"
              : "bg-tint/[0.04] text-daintree-text/70 hover:bg-tint/[0.08]"
          )}
        >
          Live rule
        </button>
      </div>
      {kind === "predicate" ? (
        <div className="flex gap-1 text-[11px]">
          <select
            aria-label="Predicate scope"
            value={predicateScope}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "current" || v === "all") setPredicateScope(v);
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex-1 rounded bg-tint/[0.08] px-1.5 py-1 text-daintree-text"
          >
            <option value="current">This worktree</option>
            <option value="all">All worktrees</option>
          </select>
          <select
            aria-label="Predicate state"
            value={predicateState}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "all" || v === "working" || v === "waiting" || v === "finished") {
                setPredicateState(v);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex-1 rounded bg-tint/[0.08] px-1.5 py-1 text-daintree-text"
          >
            <option value="all">All</option>
            <option value="waiting">Waiting</option>
            <option value="working">Working</option>
            <option value="finished">Finished</option>
          </select>
        </div>
      ) : null}
      <div className="flex gap-1">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          // Without these stop-propagation guards Radix's DropdownMenu eats
          // Space (toggles), arrow keys (navigates), and Enter (commits the
          // focused item) before they reach the input.
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder={
            kind === "snapshot"
              ? armedCount > 0
                ? `Name (${armedCount} pane${armedCount === 1 ? "" : "s"})`
                : "Arm panes first…"
              : "Name…"
          }
          className="flex-1 rounded bg-tint/[0.08] px-2 py-1 text-[11px] text-daintree-text placeholder:text-daintree-text/40 outline-hidden focus:bg-tint/[0.14]"
          data-testid="fleet-save-form-name"
        />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            submit();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={!canSave}
          data-testid="fleet-save-form-submit"
          className="rounded bg-category-amber-subtle border border-category-amber-border px-2 py-1 text-[11px] text-category-amber-text transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </DropdownMenuItem>
  );
}
