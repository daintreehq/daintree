import { Globe, Search } from "lucide-react";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { BrandMark } from "@/components/icons";

interface PortalIconProps {
  icon: string;
  size?: "tab" | "launchpad";
}

const ICON_CLASS: Record<NonNullable<PortalIconProps["size"]>, string> = {
  tab: "w-3.5 h-3.5",
  launchpad: "w-5 h-5",
};

export function PortalIcon({ icon, size = "launchpad" }: PortalIconProps) {
  const iconClass = ICON_CLASS[size];

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
      return (
        <BrandMark brandColor={config.color} className={iconClass}>
          <Icon className={iconClass} />
        </BrandMark>
      );
    }
  }

  // User-defined links render Globe — never fetch favicons from third-party services
  // (e.g. google.com/s2/favicons) since that would leak hostnames the user opened.
  return <Globe className={iconClass} />;
}
