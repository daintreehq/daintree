import { useState } from "react";
import { Button } from "@/components/ui/button";

/** A command the user runs themselves on the host, with a copy button. Daintree never runs sudo. */
export function HostCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-text-secondary">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-[var(--radius-md)] border border-border-default bg-surface-input px-2.5 py-1.5 font-mono text-xs text-text-primary select-text">
          {command}
        </code>
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
