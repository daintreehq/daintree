import type { ComponentType } from "react";
import { GitBranch, Settings2 } from "lucide-react";
import { GitHubIcon, GitLabIcon } from "@/components/icons/brands";
import {
  BUILTIN_GITHUB_PROVIDER_ID,
  BUILTIN_GITLAB_PROVIDER_ID,
} from "@shared/utils/forgeProviderIds";
import { SettingsSubjectPicker } from "./SettingsSubjectPicker";

export interface ForgeProviderOption {
  /** Canonical `{pluginId}.{contributionId}` forge provider id. */
  id: string;
  name: string;
  pluginId: string;
}

type ProviderIcon = ComponentType<{ size?: number; className?: string }>;

const BRAND_ICONS: Record<string, ProviderIcon> = {
  [BUILTIN_GITHUB_PROVIDER_ID]: GitHubIcon,
  [BUILTIN_GITLAB_PROVIDER_ID]: GitLabIcon,
};

/** A forge's own mark where we have one; a generic branch for third-party providers. */
function getProviderIcon(id: string): ProviderIcon {
  return BRAND_ICONS[id] ?? GitBranch;
}

interface ForgeProviderSelectorDropdownProps {
  providerOptions: ForgeProviderOption[];
  activeSubtab: string;
  onSubtabChange: (id: string) => void;
}

type PickerItem =
  { kind: "general"; id: typeof GENERAL_ID } | (ForgeProviderOption & { kind: "provider" });

const GENERAL_ID = "general";
const GENERAL_ITEM: PickerItem = { kind: "general", id: GENERAL_ID };

export function ForgeProviderSelectorDropdown({
  providerOptions,
  activeSubtab,
  onSubtabChange,
}: ForgeProviderSelectorDropdownProps) {
  const entries: PickerItem[] = providerOptions.map((p) => ({ ...p, kind: "provider" }));
  const selectedProvider =
    activeSubtab !== GENERAL_ID ? providerOptions.find((p) => p.id === activeSubtab) : null;
  const SelectedIcon = selectedProvider ? getProviderIcon(selectedProvider.id) : Settings2;

  return (
    <SettingsSubjectPicker<PickerItem>
      idPrefix="forge-provider-selector"
      overview={GENERAL_ITEM}
      entries={entries}
      matches={(item, q) => item.kind === "provider" && item.name.toLowerCase().includes(q)}
      activeId={selectedProvider ? selectedProvider.id : GENERAL_ID}
      onChange={onSubtabChange}
      listLabel="Forge providers"
      filterLabel="Filter providers"
      placeholder="Filter providers…"
      noMatches={(q) => <>No providers match &ldquo;{q}&rdquo;</>}
      current={
        <>
          <SelectedIcon size={18} className="shrink-0 text-text-secondary" />
          <span className="min-w-0 truncate text-base font-semibold">
            {selectedProvider ? selectedProvider.name : "General"}
          </span>
        </>
      }
      renderRow={(item) => {
        if (item.kind === "general") {
          return (
            <>
              <Settings2 size={16} className="shrink-0 text-text-secondary" />
              <div className="flex-1 min-w-0">
                <div className="truncate">General</div>
                <div className="text-xs text-text-secondary truncate">Global forge settings</div>
              </div>
            </>
          );
        }
        const Icon = getProviderIcon(item.id);
        return (
          <>
            <Icon size={16} className="shrink-0 text-text-secondary" />
            <span className="flex-1 min-w-0 truncate">{item.name}</span>
          </>
        );
      }}
    />
  );
}
