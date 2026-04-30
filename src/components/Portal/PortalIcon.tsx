import { useState, useEffect } from "react";
import { Globe, Search } from "lucide-react";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { BrandMark } from "@/components/icons";

interface PortalIconProps {
  icon: string;
  size?: "tab" | "launchpad";
  url?: string;
  type?: "system" | "user";
}

export function PortalIcon({ icon, size = "launchpad", url, type }: PortalIconProps) {
  const [showFallback, setShowFallback] = useState(false);
  const iconClass = size === "launchpad" ? "w-8 h-8" : "w-3 h-3";

  useEffect(() => {
    setShowFallback(false);
  }, [icon, url]);

  if (showFallback || icon === "globe") {
    return <Globe className={iconClass} />;
  }

  // Handle special cases
  if (icon === "search") {
    return <Search className={iconClass} />;
  }

  // Try to get agent config from registry
  if (isRegisteredAgent(icon)) {
    const config = getAgentConfig(icon);
    if (config) {
      const Icon = config.icon;
      const pixelSize = size === "launchpad" ? 32 : 12;
      return (
        <BrandMark brandColor={config.color} size={pixelSize} className={iconClass}>
          <Icon className={iconClass} brandColor={config.color} />
        </BrandMark>
      );
    }
  }

  // Fallback for user-defined links with URL
  if (type === "user" && url) {
    try {
      const domain = new URL(url).hostname;
      const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
      return (
        <img src={faviconUrl} alt="" className={iconClass} onError={() => setShowFallback(true)} />
      );
    } catch {
      return <Globe className={iconClass} />;
    }
  }

  return <Globe className={iconClass} />;
}
