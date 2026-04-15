import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { AgentInstallBlock } from "@shared/config/agentRegistry";

export function InstallBlock({ block }: { block: AgentInstallBlock }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/50 p-3">
      {block.label && (
        <div className="text-xs font-medium text-daintree-text/60 mb-2">{block.label}</div>
      )}
      {block.steps && block.steps.length > 0 && (
        <ol className="list-decimal list-inside text-xs text-daintree-text/60 space-y-1 mb-2">
          {block.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
      {block.commands && block.commands.length > 0 && (
        <div className="space-y-1.5">
          {block.commands.map((cmd, i) => (
            <CopyableCommand key={i} command={cmd} />
          ))}
        </div>
      )}
      {block.notes && block.notes.length > 0 && (
        <div className="mt-2 text-[11px] text-daintree-text/40 space-y-0.5">
          {block.notes.map((note, i) => (
            <p key={i}>{note}</p>
          ))}
        </div>
      )}
    </div>
  );
}

export function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setCopied(true);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [command]);

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] bg-daintree-bg border border-daintree-border">
      <code className="flex-1 text-xs text-daintree-text font-mono select-all">{command}</code>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 p-1 text-daintree-text/40 hover:text-daintree-text transition-colors rounded"
        title="Copy to clipboard"
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 text-status-success" />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  );
}
