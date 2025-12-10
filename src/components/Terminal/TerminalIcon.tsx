import { Terminal } from "lucide-react";
import { ClaudeIcon, GeminiIcon, CodexIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { TerminalType } from "@/types";

export interface TerminalIconProps {
  type: TerminalType;
  className?: string;
  brandColor?: string;
}

export function TerminalIcon({ type, className, brandColor }: TerminalIconProps) {
  const finalProps = {
    className: cn("w-4 h-4", className),
    "aria-hidden": "true" as const,
  };

  switch (type) {
    case "claude":
      return <ClaudeIcon {...finalProps} brandColor={brandColor} />;
    case "gemini":
      return <GeminiIcon {...finalProps} brandColor={brandColor} />;
    case "codex":
      return <CodexIcon {...finalProps} brandColor={brandColor} />;
    case "terminal":
    default:
      return <Terminal {...finalProps} />;
  }
}
