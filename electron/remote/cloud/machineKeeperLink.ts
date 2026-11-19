import { z } from "zod";

/**
 * Session CALLs a Shell uses to hand a cloud machine's host the key it acts
 * on itself with (#17361): renewing its lifetime while it sees work, and
 * stopping it once idle. Session-level, like settings control. A host too old
 * to know them answers `UNSUPPORTED`, and the Shell's own keeper carries on
 * as before.
 */
export const MachineKeeperLinkMethod = {
  /** What the host holds now. Never the secret. */
  STATUS: "machine-keeper.status",
  /** Hold this key instead of any other, for the machine it names. */
  ARM: "machine-keeper.arm",
} as const;

export const MachineKeeperStatusRequestSchema = z.union([
  z.null(),
  z.undefined(),
  z.object({}).strict(),
]);

export const MachineKeeperArmSchema = z
  .object({
    /** The Shell's record of this key, which the host reports back. */
    grantId: z.string().min(1).max(64),
    /** The provider the key is for; a host refuses one it has no keeper for. */
    provider: z.string().min(1).max(64),
    /** Must be the API origin the host itself would use for the provider. */
    apiUrl: z.string().min(1).max(512),
    /** The billing scope every request names. */
    scope: z.string().min(1).max(128),
    resourceId: z.string().min(1).max(128),
    secret: z.string().min(8).max(1024),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type MachineKeeperArmRequest = z.infer<typeof MachineKeeperArmSchema>;

/** What a host's keeper holds and can do, as it says. */
export const MachineKeeperStatusSchema = z.object({
  /** The Shell record of the key it holds; null when it holds none. */
  grantId: z.string().max(64).nullable(),
  resourceId: z.string().max(128).nullable(),
  expiresAt: z.number().nullable(),
  /** Why it holds no usable key, in a sentence; null while it holds one or was never given one. */
  problem: z.string().max(500).nullable(),
});
export type MachineKeeperStatus = z.infer<typeof MachineKeeperStatusSchema>;

/**
 * Session CALL a Shell uses to let a cloud machine's host power itself off
 * once idle, for a provider where a guest power-off is a normal stop that
 * keeps the disk (EC2, Compute Engine; #17362). Nothing in it is a secret:
 * the host acts with no cloud API at all. A host too old to know it answers
 * `UNSUPPORTED`.
 */
export const GUEST_POWER_OFF_METHOD = "machine-keeper.guest-power-off";

/** The machine, as the host's own cloud metadata server must name it before it powers off. */
export const GuestPowerOffTargetSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("aws"),
      accountId: z.string().regex(/^\d{12}$/),
      region: z
        .string()
        .max(32)
        .regex(/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/),
      instanceId: z.string().regex(/^i-[0-9a-f]{8,17}$/),
    })
    .strict(),
  z
    .object({
      provider: z.literal("gce"),
      project: z
        .string()
        .max(128)
        .regex(/^(?:[a-z][a-z0-9.-]{0,62}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
      zone: z.string().regex(/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/),
      instanceId: z.string().regex(/^\d{1,20}$/),
    })
    .strict(),
]);
export type GuestPowerOffTarget = z.infer<typeof GuestPowerOffTargetSchema>;

export const GuestPowerOffRequestSchema = z
  .object({
    target: GuestPowerOffTargetSchema,
    /** False takes the permission back: the Shell found a stop would no longer keep the disk. */
    enabled: z.boolean(),
  })
  .strict();
export type GuestPowerOffRequest = z.infer<typeof GuestPowerOffRequestSchema>;

/** What the host's power-off keeper holds, as it says. */
export const GuestPowerOffStatusSchema = z.object({
  /** It will power its machine off once its idle time ends. */
  armed: z.boolean(),
  /** Why it won't, in a sentence; null while armed or never asked. */
  problem: z.string().max(500).nullable(),
  /**
   * Set only on the answer to a grant whose machine the metadata server
   * confirmed and whose OS then wouldn't let it power off (sudo wanting a
   * password, no systemctl): the machine is the one asked about and only the
   * power-off stands in the way, so a stop from the provider's API still fits
   * (#17924). Absent from hosts from before it, which counts as not confirmed.
   */
  powerOffProbeRefused: z.boolean().optional(),
});
export type GuestPowerOffStatus = z.infer<typeof GuestPowerOffStatusSchema>;

/** Two targets name the same machine. */
export function sameGuestPowerOffTarget(a: GuestPowerOffTarget, b: GuestPowerOffTarget): boolean {
  if (a.provider === "aws" && b.provider === "aws") {
    return a.accountId === b.accountId && a.region === b.region && a.instanceId === b.instanceId;
  }
  if (a.provider === "gce" && b.provider === "gce") {
    return a.project === b.project && a.zone === b.zone && a.instanceId === b.instanceId;
  }
  return false;
}
