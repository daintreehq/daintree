import { Globe, Search } from "lucide-react";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { BrandMark } from "@/components/icons";

interface PortalIconProps {
  icon: string;
  size?: "tab" | "launchpad";
}

export function PortalIcon({ icon, size = "launchpad" }: PortalIconProps) {
  const iconClass = size === "launchpad" ? "w-8 h-8" : "w-3 h-3";

  if (icon === "globe") {
    return <Globe className={iconClass} />;
  }

  if (icon === "search") {
    return <Search className={iconClass} />;
  }

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

  // User-defined links render Globe — never fetch favicons from third-party services
  // (e.g. google.com/s2/favicons) since that would leak hostnames the user opened.
  return <Globe className={iconClass} />;
}
