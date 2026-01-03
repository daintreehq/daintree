import type React from "react";
import { AppDialog } from "@/components/ui/AppDialog";

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  isConfirmLoading?: boolean;
  variant?: "default" | "destructive" | "info";
}

export function ConfirmDialog({
  isOpen,
  onClose,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  isConfirmLoading = false,
  variant = "destructive",
}: ConfirmDialogProps) {
  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="sm" variant={variant}>
      <AppDialog.Header>
        <AppDialog.Title>{title}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body className="space-y-3">
        {description && <AppDialog.Description>{description}</AppDialog.Description>}
      </AppDialog.Body>

      <AppDialog.Footer
        secondaryAction={{
          label: cancelLabel,
          onClick: onClose,
          disabled: isConfirmLoading,
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
