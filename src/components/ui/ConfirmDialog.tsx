import type React from "react";
import { AppDialog, type DialogZIndex } from "@/components/ui/AppDialog";

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose?: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  isConfirmLoading?: boolean;
  variant?: "default" | "destructive" | "info";
  zIndex?: DialogZIndex;
}

export function ConfirmDialog({
  isOpen,
  onClose,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  isConfirmLoading = false,
  variant = "destructive",
  zIndex,
}: ConfirmDialogProps) {
  const handleClose = onClose ?? (() => {});

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
