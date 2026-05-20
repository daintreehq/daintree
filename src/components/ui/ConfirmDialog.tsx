import type React from "react";
import { useEffect, useState } from "react";
import { AppDialog, type DialogInitialFocus, type DialogZIndex } from "@/components/ui/AppDialog";
import { TypedNameConfirmInput } from "@/components/ui/TypedNameConfirmInput";

const DESTRUCTIVE_CONFIRM_LABEL_RE =
  /^\s*(delete|remove|destroy|erase|wipe|purge|abort|reset|revoke|terminate|uninstall)\b/i;

const GENERIC_CONFIRM_LABEL_RE =
  /^\s*(ok|confirm|yes|save|continue|proceed|done|got it|accept|apply|submit)\s*$/i;

const ARE_YOU_SURE_TITLE_RE = /^\s*are\s+you\s+sure/i;

const CANNOT_BE_UNDONE_BODY_RE = /cannot be undone|can['’]t be undone/i;

const devWarnedKeys = new Set<string>();

export const __devWarnedKeys = devWarnedKeys;

function warnOnce(key: string, message: string) {
  if (!import.meta.env.DEV) return;
  if (devWarnedKeys.has(key)) return;
  devWarnedKeys.add(key);
  // eslint-disable-next-line no-console
  console.error(message);
}

function getNodeText(node: React.ReactNode): string {
  return typeof node === "string" ? node : "";
}

type ConfirmDialogBaseProps = {
  isOpen: boolean;
  onClose?: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  isConfirmLoading?: boolean;
  /**
   * Disable the primary action while the dialog stays open — for gates
   * that depend on the body's own state (e.g. all options excluded).
   * Stacks with the typed-name gate; the button stays disabled if
   * either gate fails.
   */
  confirmDisabled?: boolean;
  zIndex?: DialogZIndex;
  initialFocus?: DialogInitialFocus;
};

export type ConfirmDialogProps =
  | (ConfirmDialogBaseProps & {
      variant: "destructive";
      typedNameTarget?: string;
    })
  | (ConfirmDialogBaseProps & {
      variant: "default" | "info";
      typedNameTarget?: never;
    });

export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    isOpen,
    onClose,
    title,
    description,
    children,
    confirmLabel,
    cancelLabel = "Cancel",
    onConfirm,
    isConfirmLoading = false,
    confirmDisabled = false,
    variant,
    zIndex,
    initialFocus,
  } = props;
  const rawTypedNameTarget = (props as { typedNameTarget?: string }).typedNameTarget;
  const typedNameTarget = variant === "destructive" ? rawTypedNameTarget : undefined;

  const handleClose = onClose ?? (() => {});
  const [typedValue, setTypedValue] = useState("");

  useEffect(() => {
    if (!isOpen) setTypedValue("");
  }, [isOpen]);

  if (variant !== "destructive" && DESTRUCTIVE_CONFIRM_LABEL_RE.test(confirmLabel)) {
    warnOnce(
      `forward-label:${variant}:${confirmLabel.trim().toLowerCase()}`,
      `[ConfirmDialog] Destructive confirmLabel "${confirmLabel}" rendered with variant="${variant}". Use variant="destructive" so the primary button gets the destructive styling.`
    );
  }

  if (variant === "destructive" && GENERIC_CONFIRM_LABEL_RE.test(confirmLabel)) {
    warnOnce(
      `inverse-label:${confirmLabel.trim().toLowerCase()}`,
      `[ConfirmDialog] Destructive variant rendered with generic confirmLabel "${confirmLabel}". Use a verb-noun label like "Delete worktree" so the button names the action.`
    );
  }

  if (rawTypedNameTarget && variant !== "destructive") {
    warnOnce(
      `typed-name-variant:${variant}`,
      `[ConfirmDialog] typedNameTarget="${rawTypedNameTarget}" was set with variant="${variant}". The typed-name gate is intended for destructive actions; use variant="destructive".`
    );
  }

  const titleText = getNodeText(title);
  if (titleText && ARE_YOU_SURE_TITLE_RE.test(titleText)) {
    warnOnce(
      "title-are-you-sure",
      `[ConfirmDialog] title="${titleText}" starts with "Are you sure". Per the Daintree microcopy rule, title should be a sentence-case question naming the entity (e.g., "Delete 'foo'?") — never a generic "Are you sure?".`
    );
  }

  const bodyText = `${getNodeText(description)} ${getNodeText(children)}`;
  if (CANNOT_BE_UNDONE_BODY_RE.test(bodyText)) {
    warnOnce(
      "body-cannot-be-undone",
      `[ConfirmDialog] body contains "cannot be undone". Per the Daintree microcopy rule, the body must state the specific consequence (what gets deleted, where it lives, what recovery exists) — generic irreversibility copy adds no information.`
    );
  }

  const hasTypedNameGate = !!typedNameTarget;
  const isTypedMatched = !hasTypedNameGate || typedValue === typedNameTarget;

  const handleConfirm = () => {
    if (hasTypedNameGate && !isTypedMatched) return;
    if (confirmDisabled) return;
    return onConfirm();
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={handleClose}
      size="sm"
      variant={variant}
      zIndex={zIndex}
      initialFocus={initialFocus}
    >
      <AppDialog.Header>
        <AppDialog.Title>{title}</AppDialog.Title>
        {onClose && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body className="space-y-3">
        {description && <AppDialog.Description>{description}</AppDialog.Description>}
        {children}
        {hasTypedNameGate && (
          <TypedNameConfirmInput
            target={typedNameTarget}
            value={typedValue}
            onChange={setTypedValue}
            onMatchSubmit={() => {
              void handleConfirm();
            }}
          />
        )}
      </AppDialog.Body>

      <AppDialog.Footer
        secondaryAction={{
          label: cancelLabel,
          onClick: handleClose,
          disabled: isConfirmLoading || !onClose,
        }}
        primaryAction={{
          label: confirmLabel,
          onClick: handleConfirm,
          loading: isConfirmLoading,
          disabled: (hasTypedNameGate && !isTypedMatched) || confirmDisabled,
          intent: variant === "destructive" ? "destructive" : "default",
        }}
      />
    </AppDialog>
  );
}
