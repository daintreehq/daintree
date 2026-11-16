import { store } from "../../store.js";
import type { HostModeSettings } from "./HostModeService.js";

export function readHostModeSettings(): HostModeSettings {
  const stored = store.get("hostMode");
  return {
    enabled: stored?.enabled === true,
    startAtLogin: stored?.startAtLogin === true,
    // On unless turned off: discovery is how a new Shell finds this machine.
    advertise: stored?.advertise !== false,
  };
}
