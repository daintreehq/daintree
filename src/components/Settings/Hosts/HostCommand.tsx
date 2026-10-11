import { CopyButton } from "@/components/ui/CopyButton";

/** A command the user runs themselves on the host, with a copy button. Daintree never runs sudo. */
export function HostCommand({ label, command }: { label: string; command: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-text-secondary">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-[var(--radius-md)] border border-border-default bg-surface-input px-2.5 py-1.5 font-mono text-xs text-text-primary select-text">
          {command}
        </code>
        <CopyButton label="Copy command" variant="outline" size="sm" text={command} />
      </div>
    </div>
  );
}
