import { ChevronDown } from "lucide-react";
import { LOCAL_HOST_ID, type HostConnectionState, type HostId } from "@shared/types/remoteHosts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deviceOwnerLabel } from "@/hooks/useSettingsOwner";
import { cn } from "@/lib/utils";

/** The window's own machine, whichever that is: its ordinary pages edit it. */
const OWN = "__own__";

export interface SettingsMachineOption {
  /** Null for the window's own machine. */
  hostId: HostId | null;
  name: string;
  note: string | null;
  /** Whether its settings can be read now: this machine always, a host while its link is up. */
  connected: boolean;
}

/**
 * Every machine Settings can edit from this window: its own first, then this
 * machine when the window works on a host, then each other paired host.
 */
export function settingsMachineOptions(
  hosts: readonly {
    descriptor: { id: HostId; name: string };
    connection: { status: HostConnectionState["status"] };
  }[],
  ownHostId: HostId,
  ownHostName: string | null
): SettingsMachineOption[] {
  const remoteWindow = ownHostId !== LOCAL_HOST_ID;
  const options: SettingsMachineOption[] = [
    {
      hostId: null,
      name: remoteWindow ? (ownHostName ?? ownHostId) : deviceOwnerLabel(),
      note: remoteWindow ? "This window's host" : null,
      connected: true,
    },
  ];
  if (remoteWindow)
    options.push({ hostId: LOCAL_HOST_ID, name: deviceOwnerLabel(), note: null, connected: true });
  for (const host of hosts) {
    const id = host.descriptor.id;
    if (id === ownHostId || id === LOCAL_HOST_ID) continue;
    const connected = host.connection.status === "connected";
    options.push({
      hostId: id,
      name: host.descriptor.name || id,
      note: connected ? null : "Not connected",
      connected,
    });
  }
  return options;
}

/**
 * Which machine's work settings the dialog shows (#14706). Only rendered once
 * there is another machine to pick, so Settings without hosts is unchanged.
 * Neutral like the scope menu above it: it answers "whose", it isn't a CTA.
 */
export function SettingsMachinePicker({
  options,
  value,
  onChange,
  disabled,
}: {
  options: SettingsMachineOption[];
  value: HostId | null;
  onChange: (hostId: HostId | null) => void;
  disabled?: boolean;
}) {
  const current = options.find((option) => option.hostId === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-haspopup="menu"
          data-settings-machine-trigger=""
          className={cn(
            "settings-scope-trigger group flex items-center gap-1 h-7 max-w-full px-3 rounded-[var(--radius-md)]",
            "text-xs text-text-secondary transition-[background-color] duration-150 ease-out",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
            "disabled:cursor-not-allowed"
          )}
        >
          <span className="shrink-0">On</span>
          <span className="truncate font-medium text-text-primary">{current?.name}</span>
          <ChevronDown
            data-animated-chevron
            className="w-3.5 h-3.5 shrink-0 text-text-secondary transition-transform duration-150 ease-out group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 font-normal">
        <DropdownMenuRadioGroup
          value={value ?? OWN}
          onValueChange={(next) => onChange(next === OWN ? null : next)}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.hostId ?? OWN} value={option.hostId ?? OWN}>
              <span className="flex flex-col min-w-0">
                <span className="truncate">{option.name}</span>
                {option.note && (
                  <span className="text-2xs text-text-secondary truncate">{option.note}</span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
