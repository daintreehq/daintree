import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAssistantActionConfirmations } from "@/hooks/useAssistantActionConfirmations";

const SENSITIVE_KEYS = ["password", "token", "apiKey", "secret", "key", "apikey", "api_key"];

function formatActionName(actionId: string, actionName?: string): string {
  if (actionName) return actionName;
  return actionId
    .split(".")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function safeStringify(value: unknown): string {
  try {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactSensitiveValue(key: string, value: unknown): string {
  const lowerKey = key.toLowerCase();
  if (SENSITIVE_KEYS.some((sensitive) => lowerKey.includes(sensitive))) {
    return "[REDACTED]";
  }
  const str = safeStringify(value);
  return str.length > 100 ? `${str.slice(0, 100)}...` : str;
}

function formatArgsPreview(args?: Record<string, unknown>): React.ReactNode {
  if (!args || Object.keys(args).length === 0) {
    return <div className="text-[var(--vscode-descriptionForeground)]">(no parameters)</div>;
  }

  const entries = Object.entries(args);

  return (
    <div className="space-y-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2">
          <span className="text-[var(--vscode-symbolIcon-keyForeground)]">{key}:</span>
          <span className="flex-1 truncate text-[var(--vscode-descriptionForeground)]">
            {redactSensitiveValue(key, value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function AssistantActionConfirmationHost() {
  const { pendingConfirmation, approve, deny } = useAssistantActionConfirmations();

  if (!pendingConfirmation) {
    return null;
  }

  const actionDisplay = formatActionName(
    pendingConfirmation.actionId,
    pendingConfirmation.actionName
  );
  const dangerLabel =
    pendingConfirmation.danger === "confirm" ? "Requires Confirmation" : "Restricted";

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={deny}
      title="Assistant Action Confirmation"
      description={
        <div className="space-y-3">
          <p>The assistant is requesting permission to execute the following action:</p>
          <div className="rounded-md bg-[var(--vscode-editor-background)] p-3 space-y-2">
            <div>
              <div className="font-semibold font-mono text-sm">{actionDisplay}</div>
              <div className="text-xs text-[var(--vscode-descriptionForeground)] mt-0.5">
                {pendingConfirmation.actionId}
              </div>
            </div>
            <div className="border-t border-[var(--vscode-panel-border)] pt-2">
              <div className="text-xs font-semibold mb-1 text-[var(--vscode-descriptionForeground)]">
                Parameters:
              </div>
              <div className="font-mono text-xs">{formatArgsPreview(pendingConfirmation.args)}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-[var(--vscode-badge-background)] text-[var(--vscode-badge-foreground)]">
              {dangerLabel}
            </span>
            <span className="text-[var(--vscode-descriptionForeground)]">
              This action requires your explicit approval
            </span>
          </div>
        </div>
      }
      confirmLabel="Approve"
      cancelLabel="Deny"
      onConfirm={approve}
      variant="info"
    />
  );
}
