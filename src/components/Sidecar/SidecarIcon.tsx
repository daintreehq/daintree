import { useState, useEffect } from "react";
import { Globe, Search } from "lucide-react";
import { ClaudeIcon, GeminiIcon, CodexIcon } from "@/components/icons";
import { getBrandColorHex } from "@/lib/colorUtils";

interface SidecarIconProps {
  icon: string;
  size?: "tab" | "launchpad";
  url?: string;
  type?: "system" | "discovered" | "user";
}

export function SidecarIcon({ icon, size = "launchpad", url, type }: SidecarIconProps) {
  const [showFallback, setShowFallback] = useState(false);
  const iconClass = size === "launchpad" ? "w-8 h-8" : "w-3 h-3";

  useEffect(() => {
    setShowFallback(false);
  }, [icon, url]);

  if (showFallback || icon === "globe") {
    return <Globe className={iconClass} />;
  }

  switch (icon) {
    case "claude":
      return <ClaudeIcon className={iconClass} brandColor={getBrandColorHex("claude")} />;
    case "gemini":
      return <GeminiIcon className={iconClass} brandColor={getBrandColorHex("gemini")} />;
    case "openai":
      return <CodexIcon className={iconClass} brandColor={getBrandColorHex("codex")} />;
    case "search":
      return <Search className={iconClass} />;
    default:
      if (type === "user" && url) {
        try {
          const domain = new URL(url).hostname;
          const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
          return (
            <img
              src={faviconUrl}
              alt=""
              className={iconClass}
              onError={() => setShowFallback(true)}
            />
          );
        } catch {
          return <Globe className={iconClass} />;
        }
      }
      return <Globe className={iconClass} />;
  }
}
