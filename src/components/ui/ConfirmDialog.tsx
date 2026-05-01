import type React from "react";
import { AppDialog, type DialogZIndex } from "@/components/ui/AppDialog";

const DESTRUCTIVE_CONFIRM_LABEL_RE =
  /^\s*(delete|remove|destroy|erase|wipe|purge|abort|reset|revoke|terminate|uninstall)\b/i;

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose?: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  isConfirmLoading?: boolean;
  variant: "default" | "destructive" | "info";
  zIndex?: DialogZIndex;
}

export function ConfirmDialog({
  isOpen,
  onClose,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  isConfirmLoading = false,
  variant,
  zIndex,
}: ConfirmDialogProps) {
  const handleClose = onClose ?? (() => {});

  if (
    import.meta.env.DEV &&
    variant !== "destructive" &&
    DESTRUCTIVE_CONFIRM_LABEL_RE.test(confirmLabel)
  ) {
    // eslint-disable-next-line no-console
    console.error(
      `[ConfirmDialog] Destructive confirmLabel "${confirmLabel}" rendered with variant="${variant}". Use variant="destructive" so the primary button gets the destructive styling.`
    );
  }

  return (
    <AppDialog isOpen={isOpen} onClose={handleClose} size="sm" variant={variant} zIndex={zIndex}>
      <AppDialog.Header>
        <AppDialog.Title>{title}</AppDialog.Title>
        {onClose && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body className="space-y-3">
        {description && <AppDialog.Description>{description}</AppDialog.Description>}
        {children}
      </AppDialog.Body>

      <AppDialog.Footer
        secondaryAction={{
          label: cancelLabel,
          onClick: handleClose,
          disabled: isConfirmLoading || !onClose,
        }}
        primaryAction={{
          label: confirmLabel,
          onClick: onConfirm,
          loading: isConfirmLoading,
          intent: variant === "destructive" ? "destructive" : "default",
        }}
      />
    </AppDialog>
  );
}
