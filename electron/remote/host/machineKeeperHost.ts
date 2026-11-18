import path from "node:path";
import { app } from "electron";
import { BoatClient, resolveBoatApiUrl } from "../cloud/boat/BoatClient.js";
import { boatMachineDriver } from "../cloud/boat/boatMachineDriver.js";
import { BOAT_SANDBOX_ID } from "../cloud/boat/boatSchemas.js";
import {
  GUEST_POWER_OFF_METHOD,
  GuestPowerOffRequestSchema,
  MachineKeeperArmSchema,
  MachineKeeperLinkMethod,
  MachineKeeperStatusRequestSchema,
} from "../cloud/machineKeeperLink.js";
import type { LinkSession } from "../link/session.js";
import { getRemoteService, registerRemoteService } from "../runtime.js";
import { GuestPowerOffKeeper } from "./GuestPowerOffKeeper.js";
import { createGuestPowerOffSystem, type GuestPowerOffSystem } from "./guestPowerOffSystem.js";
import { MachineKeeper } from "./MachineKeeper.js";

declare module "../runtime.js" {
  interface RemoteServices {
    machineKeeper: MachineKeeper;
    guestPowerOff: GuestPowerOffKeeper;
  }
}

export interface MachineKeeperHostServer {
  onSession(listener: (ctx: { session: LinkSession }) => void): () => void;
}

/**
 * Host mode: take the key a Shell hands this cloud machine and keep it
 * running, or stop it, by this host's idle clock (#17361); or, on EC2 and
 * Compute Engine, the permission to power it off once idle (#17362). Nothing
 * runs and no request is made until a Shell hands one over, or one was handed
 * over earlier in this boot.
 */
export function installMachineKeeperHost(
  server: MachineKeeperHostServer,
  options: { guestSystem?: GuestPowerOffSystem } = {}
): () => void {
  const idle = getRemoteService("hostIdle");
  if (!idle) return () => {};
  // Only the API this build itself would use: a CALL never chooses where a key is sent.
  const boatUrl = resolveBoatApiUrl(app.isPackaged);
  let boatClient: BoatClient | null = null;
  const keeper = new MachineKeeper({
    idle,
    driverFor: (request) => {
      if (request.provider !== "boat") return "This host can't keep that provider's machines.";
      if (request.apiUrl !== boatUrl) {
        return "This host reaches another Boat than the one the key was made on.";
      }
      if (!BOAT_SANDBOX_ID.test(request.resourceId)) return "That isn't a Boat machine.";
      boatClient ??= new BoatClient({ baseUrl: boatUrl });
      return boatMachineDriver(request, boatClient);
    },
  });
  const unregister = registerRemoteService("machineKeeper", keeper);
  const guest = new GuestPowerOffKeeper({
    idle,
    system:
      options.guestSystem ??
      createGuestPowerOffSystem({
        armFile: path.join(app.getPath("userData"), "guest-power-off.json"),
      }),
  });
  const unregisterGuest = registerRemoteService("guestPowerOff", guest);
  void guest.restore().catch(() => {});
  const off = server.onSession(({ session }) => {
    const handlers = [
      session.registerCallHandler(
        MachineKeeperLinkMethod.STATUS,
        MachineKeeperStatusRequestSchema,
        () => keeper.settledStatus()
      ),
      session.registerCallHandler(MachineKeeperLinkMethod.ARM, MachineKeeperArmSchema, (request) =>
        keeper.arm(request)
      ),
      session.registerCallHandler(GUEST_POWER_OFF_METHOD, GuestPowerOffRequestSchema, (request) =>
        guest.set(request)
      ),
    ];
    session.onClose(() => {
      for (const dispose of handlers) dispose();
    });
  });
  return () => {
    off();
    unregisterGuest();
    guest.dispose();
    unregister();
    keeper.dispose();
  };
}
