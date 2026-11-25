import { InstallCommandRows } from "@/components/Setup/InstallCommandRows";
import type { InstallTarget } from "@/services/terminal/installCommandLine";
import type { CloudSshTunnelCommand } from "@shared/types/cloudHosts";

// Nothing here can tell when a tunnel's sign-in has worked: the surface's own Check again does.
const MANUAL: InstallTarget = { kind: "manual" };

/** Whether the provider declared a line for what `from` covers. */
export function hasTunnelSetupCommands(
  tunnel: CloudSshTunnelCommand,
  from: "install" | "sign-in"
): boolean {
  return Boolean(tunnel.signInCommand || (from === "install" && tunnel.installCommand));
}

/**
 * The lines a provider declares for setting its tunnel command up on this
 * device, each with Copy and, where this window has a grid, Open in a
 * terminal, which types it there without running it. From `install`, the
 * install line and then the sign-in line; from `sign-in`, the sign-in line
 * alone. Each opens on its own: a sign-in asks questions, and an install may
 * need the person's own sudo.
 */
export function TunnelSetupCommands({
  tunnel,
  from,
}: {
  tunnel: CloudSshTunnelCommand;
  from: "install" | "sign-in";
}) {
  const install = from === "install" ? (tunnel.installCommand ?? null) : null;
  const signIn = tunnel.signInCommand ?? null;
  if (!install && !signIn) return null;
  return (
    <div className="space-y-2" data-testid="tunnel-setup-commands">
      {install && (
        <div className="grid gap-1.5" data-testid="tunnel-install-command">
          <p className="text-xs text-text-secondary">{`Install ${tunnel.command} on this device`}</p>
          <InstallCommandRows commands={[install]} target={MANUAL} wrap />
        </div>
      )}
      {signIn && (
        <div className="grid gap-1.5" data-testid="tunnel-sign-in-command">
          <p className="text-xs text-text-secondary">
            {install
              ? `Then sign in to ${tunnel.command} on this device`
              : `Sign in to ${tunnel.command} on this device`}
          </p>
          <InstallCommandRows commands={[signIn]} target={MANUAL} wrap />
        </div>
      )}
    </div>
  );
}
