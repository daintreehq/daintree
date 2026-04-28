import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type EmptyStateBaseProps = {
  title: string;
  description?: ReactNode;
  className?: string;
};

export type EmptyStateProps =
  | (EmptyStateBaseProps & {
      variant: "zero-data";
      icon?: ReactNode;
      action?: ReactNode;
    })
  | (EmptyStateBaseProps & {
      variant: "filtered-empty";
      action?: ReactNode;
    })
  | (EmptyStateBaseProps & {
      variant: "user-cleared";
      icon?: ReactNode;
    });

export function EmptyState(props: EmptyStateProps) {
  const { variant, title, description, className } = props;
  const descriptionId = useId();
  const hasDescription =
    description !== undefined &&
    description !== null &&
    description !== false &&
    description !== "";

  const icon = variant === "filtered-empty" ? null : props.icon;
  const action = variant === "user-cleared" ? null : props.action;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-describedby={hasDescription ? descriptionId : undefined}
      className={cn("flex flex-col items-center justify-center text-center px-4 py-8", className)}
    >
      <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150 flex flex-col items-center gap-2">
        {icon ? (
          <div className="text-daintree-text/30 [&_svg]:h-6 [&_svg]:w-6" aria-hidden="true">
            {icon}
          </div>
        ) : null}
        <p className="text-sm font-medium text-daintree-text/70">{title}</p>
        {hasDescription ? (
          <p id={descriptionId} className="text-xs text-daintree-text/50 max-w-xs">
            {description}
          </p>
        ) : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}
