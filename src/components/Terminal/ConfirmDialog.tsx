import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    cancelButtonRef.current?.focus();
  }, [isOpen]);

  return (
    <AppDialog isOpen={isOpen} onClose={onCancel} size="sm">
      <AppDialog.Body>
        <AppDialog.Title>{title}</AppDialog.Title>
        <AppDialog.Description className="mt-2 mb-6">{description}</AppDialog.Description>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button
          variant="ghost"
          onClick={onCancel}
          className="text-canopy-text/70 hover:text-canopy-text"
          ref={cancelButtonRef}
        >
          {cancelLabel}
        </Button>
        <Button onClick={onConfirm} variant={destructive ? "destructive" : "default"}>
          {confirmLabel}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
