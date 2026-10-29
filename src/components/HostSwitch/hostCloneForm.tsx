import { useId, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { DestinationCheck, HostCloneDepth } from "@shared/types/ipc/projectMatch";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { Spinner } from "@/components/ui/Spinner";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import {
  CLONE_DEPTHS,
  cloneDepthDescription,
  cloneDepthLabel,
  cloneOptionsSummary,
} from "./hostSwitchModel";

/**
 * One row of the clone forms' label grid. Everything that belongs to a field —
 * its control, its help and its problems — sits in the value column, so the
 * labels read down one edge in the order the person decides.
 */
export function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3">
      <span className="text-xs text-text-secondary">{label}</span>
      <div className="flex min-w-0 flex-col gap-2 text-sm text-text-primary">{children}</div>
    </div>
  );
}

/** Help under a field: what it means, never what is wrong with it. */
export function FieldHelp({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <p id={id} className="text-xs text-text-secondary [text-wrap:pretty]">
      {children}
    </p>
  );
}

/** Where a folder on the host stands, as the form shows it. */
export type FolderState =
  | { kind: "empty" }
  | { kind: "checking" }
  | { kind: "free" }
  | { kind: "occupied"; detail: string; suggestion: string | null }
  | { kind: "same-repository"; detail: string }
  | { kind: "invalid"; detail: string }
  | { kind: "failed"; message: string };

/**
 * The folder as the form shows it, from the host's last answer: an answer for
 * an earlier input is still checking, never free.
 */
export function folderStateOf(input: {
  value: string;
  check: DestinationCheck | null;
  checkedInput: string | null;
  checkError: string | null;
}): FolderState {
  const target = input.value.trim();
  if (target.length === 0) return { kind: "empty" };
  if (input.checkError) return { kind: "failed", message: input.checkError };
  const check = input.check;
  if (!check || input.checkedInput !== target) return { kind: "checking" };
  if (check.status === "free") return { kind: "free" };
  if (check.status === "same-repository") {
    return {
      kind: "same-repository",
      detail: check.detail ?? "This folder is already a clone of the repository.",
    };
  }
  if (check.status === "occupied") {
    return {
      kind: "occupied",
      detail: check.detail ?? "Something else is already in this folder.",
      suggestion: check.suggestion,
    };
  }
  return { kind: "invalid", detail: check.detail ?? "This folder can't take a clone." };
}

/** Why the primary can't run yet, for the footer, while the folder is what's missing. */
export function folderHint(state: FolderState, hostName: string): string | null {
  switch (state.kind) {
    case "empty":
      return `Choose a folder on ${hostName}`;
    case "checking":
      return `Waiting for ${hostName} to check the folder`;
    case "occupied":
      return state.suggestion
        ? "That folder is taken: use the suggested one or choose another"
        : "That folder is taken: choose another";
    case "same-repository":
      return "That folder already has this repository: use it or choose another";
    case "invalid":
      return "Choose a folder that can take the clone";
    case "failed":
      return `Couldn't check the folder on ${hostName}`;
    case "free":
      return null;
  }
}

/**
 * The folder a clone goes into on the host, checked there: typing it or
 * picking it with Change…, the check in flight, and each answer with the one
 * control that settles it. Every answer is a polite status on the field.
 */
export function DestinationField({
  hostName,
  value,
  state,
  disabled,
  placeholder,
  onChange,
  onPick,
  onUseSuggestion,
  sameRepository,
  onRetry,
  children,
}: {
  hostName: string;
  value: string;
  state: FolderState;
  disabled: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  onPick: () => void;
  onUseSuggestion: (path: string) => void;
  /** The folder already holds this repository: the way to use it as it is. */
  sameRepository?: { label: string; onUse: () => void };
  onRetry: () => void;
  /** An alternative under the field, such as using a folder already there. */
  children?: React.ReactNode;
}) {
  const statusId = useId();
  const failedId = useId();
  const checking = state.kind === "checking";
  const showChecking = useDeferredLoading(checking, UI_INLINE_LOADING_GATE_MS);
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          density="compact"
          className="h-7"
          aria-label={`Folder on ${hostName}`}
          aria-describedby={state.kind === "failed" ? failedId : statusId}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          invalid={state.kind === "occupied" || state.kind === "invalid"}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={disabled}
          onClick={onPick}
          aria-label={`Choose a folder on ${hostName}`}
        >
          Change…
        </Button>
      </div>
      <div
        id={statusId}
        aria-live="polite"
        aria-busy={checking || undefined}
        className="empty:hidden"
      >
        {showChecking && (
          <p className="flex items-center gap-1.5 text-xs text-text-secondary">
            <Spinner size="xs" />
            Checking the folder on {hostName}…
          </p>
        )}
        {state.kind === "occupied" && (
          <Callout severity="warning">
            <p>{state.detail}</p>
            {state.suggestion && (
              <>
                <p className="mt-0.5 text-text-secondary [overflow-wrap:anywhere]">
                  Suggested: {state.suggestion}
                </p>
                <CalloutControl>
                  <SuggestionButton
                    path={state.suggestion}
                    disabled={disabled}
                    onUse={onUseSuggestion}
                  />
                </CalloutControl>
              </>
            )}
          </Callout>
        )}
        {state.kind === "same-repository" && (
          <Callout severity="info">
            <p>{state.detail}</p>
            {sameRepository && (
              <CalloutControl>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={disabled}
                  onClick={sameRepository.onUse}
                >
                  {sameRepository.label}
                </Button>
              </CalloutControl>
            )}
          </Callout>
        )}
        {state.kind === "invalid" && <Callout severity="error">{state.detail}</Callout>}
      </div>
      {/* The host couldn't be asked: an alert, outside the polite answers above. */}
      {state.kind === "failed" && (
        <Callout
          id={failedId}
          role="alert"
          severity="error"
          action={
            <Button variant="outline" size="xs" disabled={disabled} onClick={onRetry}>
              <RefreshCw aria-hidden="true" />
              Retry
            </Button>
          }
        >
          Couldn't check this folder on {hostName}. {state.message}
        </Callout>
      )}
      {children}
    </>
  );
}

/**
 * A callout's way forward, always under its words and ahead of anything
 * diagnostic after them, such as git's output, where the trailing action slot
 * would put it beside the message or after the disclosure.
 */
export function CalloutControl({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 flex flex-wrap gap-2">{children}</div>;
}

function SuggestionButton({
  path,
  disabled,
  onUse,
}: {
  path: string;
  disabled: boolean;
  onUse: (path: string) => void;
}) {
  return (
    <Button variant="outline" size="xs" disabled={disabled} onClick={() => onUse(path)}>
      Use suggested folder
    </Button>
  );
}

/**
 * History and submodules, behind a disclosure that names the current choice
 * while it is closed, so a shallow or partial clone is never a hidden setting.
 * `submodules` is null when the option doesn't apply to this repository.
 */
export function CloneOptions({
  name,
  hostName,
  depth,
  onDepth,
  submodules,
  disabled,
}: {
  /** The radio group's name, which specs select on. */
  name: string;
  hostName: string;
  depth: HostCloneDepth;
  onDepth: (depth: HostCloneDepth) => void;
  submodules: { checked: boolean; label: string; onChange: (checked: boolean) => void } | null;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const submodulesId = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className="-ml-0.5 inline-flex items-center gap-1 self-start rounded-[var(--radius-sm)] text-left text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ChevronRight
          aria-hidden="true"
          data-animated-chevron
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform duration-150 ease-out",
            open && "rotate-90"
          )}
        />
        <span className="sr-only">Clone options: </span>
        {cloneOptionsSummary(depth, submodules ? submodules.checked : null)}
      </button>
      <div id={panelId} hidden={!open} className="space-y-3">
        <RadioChoiceGroup legend="How much history to clone" legendHidden>
          {CLONE_DEPTHS.map((option) => (
            <RadioChoiceRow
              key={option}
              name={name}
              value={option}
              checked={depth === option}
              onChange={() => onDepth(option)}
              label={cloneDepthLabel(option)}
              description={cloneDepthDescription(option, hostName)}
              disabled={disabled}
            />
          ))}
        </RadioChoiceGroup>
        {submodules && (
          <label
            htmlFor={submodulesId}
            className={cn(
              "flex items-center gap-2 text-sm text-text-primary",
              disabled && "cursor-not-allowed opacity-50"
            )}
          >
            <Checkbox
              id={submodulesId}
              size="sm"
              checked={submodules.checked}
              disabled={disabled}
              onCheckedChange={(checked) => submodules.onChange(checked === true)}
            />
            {submodules.label}
          </label>
        )}
      </div>
    </>
  );
}

/**
 * Every operation the primary runs, in order, on which machine and with whose
 * credentials: the one statement a bundled push, clone and switch owes before
 * it starts. Rendered twice by the dialogs: a `band` pinned over the footer
 * while the window is roomy, and an `inline` block at the end of the form when
 * it is short or narrow, so the band never squeezes the choices it describes
 * into a sliver. Only one of the two is ever displayed.
 */
export function OperationSteps({
  label,
  steps,
  placement,
}: {
  label: string;
  steps: string[];
  placement: "band" | "inline";
}) {
  const headingId = useId();
  if (steps.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        placement === "band"
          ? "shrink-0 border-t border-border-default bg-overlay-subtle px-6 py-3 max-sm:hidden [@media(max-height:48rem)]:hidden"
          : "hidden rounded-[var(--radius-md)] border border-border-default bg-overlay-subtle px-3 py-2.5 max-sm:block [@media(max-height:48rem)]:block"
      )}
    >
      <h3 id={headingId} className="mb-1.5 text-xs font-medium text-text-secondary">
        {label}
      </h3>
      <ol className="space-y-1 text-xs text-text-primary">
        {steps.map((step, index) => (
          <li key={index} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-1">
            <span aria-hidden="true" className="tabular-nums text-text-secondary">
              {index + 1}
            </span>
            <span className="[overflow-wrap:anywhere] [text-wrap:pretty]">{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
