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
