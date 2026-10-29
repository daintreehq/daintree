import type { ReactNode } from "react";
import { Check, ChevronLeft, Minus } from "lucide-react";
import type { DialogAction } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ARIA_DISABLED_CLASSES } from "@/components/ui/ariaDisabled";
import { cn } from "@/lib/utils";

export type WizardStepState = "done" | "current" | "skipped" | "upcoming";

export interface WizardStepView {
  id: string;
  label: string;
  state: WizardStepState;
  /** What a step found or why it was passed over, in a word or two: "Not needed", "Already on". */
  note?: string;
}

const SPOKEN: Record<WizardStepState, string> = {
  done: ", done",
  current: ", current step",
  skipped: ", skipped",
  upcoming: ", not started",
};

/**
 * The plugin kit stepper's marker (PluginKitNavigation): filled and numbered
 * for the current step, a check once done, outlined and numbered to come. A
 * step passed over keeps its place with a dashed ring and a dash, so it never
 * reads as one that ran.
 */
function StepMarker({ state, number }: { state: WizardStepState; number: number }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-medium tabular-nums",
        state === "current" && "bg-text-primary text-text-inverse",
        state === "done" && "border border-border-interactive text-text-primary",
        state === "skipped" && "border border-dashed border-border-strong text-text-secondary",
        state === "upcoming" && "border border-border-strong text-text-secondary"
      )}
    >
      {state === "done" ? (
        <Check className="size-3" />
      ) : state === "skipped" ? (
        <Minus className="size-3" />
      ) : (
        number
      )}
    </span>
  );
}

/**
 * Labels sit under their markers in equal columns, so every connector is the
 * same length and the row fits a narrow dialog without dropping a label or
 * the reason a step was passed over.
 */
export function WizardStepBar({ steps }: { steps: WizardStepView[] }) {
  return (
    <ol
      aria-label="Setup steps"
      className="mb-5 grid"
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
    >
      {steps.map((step, index) => (
        <li
          key={step.id}
          aria-current={step.state === "current" ? "step" : undefined}
          className="relative flex min-w-0 flex-col items-center px-1 text-center"
        >
          {index > 0 && (
            // From the previous marker's edge to this one's, through the column gap.
            <span
              aria-hidden="true"
              className="absolute top-2.5 right-[calc(50%+1rem)] left-[calc(-50%+1rem)] h-px bg-border-strong"
            />
          )}
          <StepMarker state={step.state} number={index + 1} />
          {/* The weight changes on the current step; the medium copy underneath
              holds every label at that width, so nothing shifts between steps. */}
          <span className="mt-1.5 grid max-w-full text-xs leading-4">
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1 truncate font-medium whitespace-nowrap"
            >
              {step.label}
            </span>
            <span
              className={cn(
                "col-start-1 row-start-1 truncate whitespace-nowrap",
                step.state === "current" && "font-medium text-text-primary",
                step.state === "done" && "text-text-primary",
                (step.state === "skipped" || step.state === "upcoming") && "text-text-secondary"
              )}
            >
              {step.label}
              <span className="sr-only">
                {SPOKEN[step.state]}
                {step.note ? `, ${step.note.toLowerCase()}` : ""}
              </span>
            </span>
          </span>
          {/* Every step keeps the note's line, so the page below never moves when one appears. */}
          <span
            aria-hidden="true"
            className="max-w-full truncate whitespace-nowrap text-2xs leading-4 text-text-secondary"
          >
            {step.note ?? "\u00a0"}
          </span>
        </li>
      ))}
    </ol>
  );
}

function FooterButton({
  action,
  variant,
  role,
  icon,
}: {
  action: DialogAction;
  variant: "ghost" | "contrast" | "destructive";
  role: "cancel" | "back" | "confirm";
  icon?: ReactNode;
}) {
  return (
    <Button
      variant={variant}
      onClick={(event) => {
        if (action.disabled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        action.onClick();
      }}
      aria-disabled={action.disabled || undefined}
      loading={action.loading}
      className={action.disabled ? ARIA_DISABLED_CLASSES : undefined}
      data-confirm-role={role}
    >
      {icon ?? action.icon}
      {action.label}
    </Button>
  );
}

/**
 * The wizard's trailing actions, in the order setup assistants use: the way
 * out (Cancel, or Close once the host is saved), Back, then the step's own
 * action. Each keeps its place from step to step, so Back is never where
 * Cancel was a moment ago. A step's alternative ("Skip Host mode", "Continue
 * anyway") rides the footer's leading edge, apart from these.
 */
export function WizardFooterActions({
  dismiss,
  back,
  primary,
}: {
  dismiss?: DialogAction;
  back?: DialogAction;
  primary?: DialogAction;
}) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-3">
      {dismiss && <FooterButton action={dismiss} variant="ghost" role="cancel" />}
      {back && (
        <FooterButton
          action={back}
          variant="ghost"
          role="back"
          icon={<ChevronLeft aria-hidden="true" />}
        />
      )}
      {primary && (
        <FooterButton
          action={primary}
          variant={primary.intent === "destructive" ? "destructive" : "contrast"}
          role="confirm"
        />
      )}
    </div>
  );
}
