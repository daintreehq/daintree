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
  /** What the link reports; null for this machine and the window's own. */
  connection: HostConnectionState | null;
}

/** A host's link in a word or two, for a menu row: what it reports, never a guess. */
export function hostLinkNote(state: HostConnectionState): string | null {
  switch (state.status) {
    case "local":
    case "connected":
      return null;
    case "disconnected":
      return "Not connected";
    case "connecting":
      return state.restarting ? "Restarting…" : "Connecting…";
    case "unreachable":
      if (state.restarting) return "Restarting…";
      return state.hostModeOff ? "Daintree isn't listening" : "Unreachable";
    case "version-mismatch":
      return "Needs a compatible build";
    case "driven-elsewhere":
      return `Driven from ${state.driver.clientName}`;
  }
}

/**
 * A machine's name in a tight spot. Fleet machines are told apart by their
 * ends (studio-01, …-eu-02.internal), so when it doesn't fit, the middle goes
 * and the end stays, at whatever width there is. The whole name is the title.
 */
export function HostNameText({ name, className }: { name: string; className?: string }) {
  const tailLength = name.length > 16 ? Math.min(12, Math.floor(name.length / 2)) : 0;
  if (tailLength === 0) {
    return <span className={cn("min-w-0 truncate", className)}>{name}</span>;
  }
  return (
    <span className={cn("flex min-w-0", className)} title={name}>
      <span className="min-w-0 truncate">{name.slice(0, -tailLength)}</span>
      <span className="shrink-0 whitespace-pre">{name.slice(-tailLength)}</span>
    </span>
  );
}

/**
 * Every machine Settings can edit from this window: its own first, then this
 * machine when the window works on a host, then each other paired host.
 */
export function settingsMachineOptions(
  hosts: readonly {
    descriptor: { id: HostId; name: string };
    connection: HostConnectionState;
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
      connection: null,
    },
  ];
  if (remoteWindow) {
    options.push({
      hostId: LOCAL_HOST_ID,
      name: deviceOwnerLabel(),
      note: null,
      connected: true,
      connection: null,
    });
  }
  for (const host of hosts) {
    const id = host.descriptor.id;
    if (id === ownHostId || id === LOCAL_HOST_ID) continue;
    options.push({
      hostId: id,
      name: host.descriptor.name || id,
      note: hostLinkNote(host.connection),
      connected: host.connection.status === "connected",
      connection: host.connection,
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
  const currentName = current?.name ?? "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-label={`On ${currentName}`}
          data-settings-machine-trigger=""
          className={cn(
            "settings-scope-trigger group flex items-center gap-1 h-7 max-w-full px-3 rounded-[var(--radius-md)]",
            "text-xs text-text-secondary transition-[background-color] duration-150 ease-out",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
            "disabled:cursor-not-allowed"
          )}
        >
          <span className="shrink-0">On</span>
          <HostNameText name={currentName} className="font-medium text-text-primary" />
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
                {/* Whole, never truncated: fleet machines differ at their ends. */}
                <span className="[overflow-wrap:anywhere]">{option.name}</span>
                {option.note && <span className="text-2xs text-text-secondary">{option.note}</span>}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
