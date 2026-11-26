import { z } from "zod";

/**
 * What a Host reads of the SSH host public keys its machine's sshd listeners
 * serve (#18257), shared so the Shell's own readers and the assistant tool
 * (#18258) describe the same answer the link carries.
 */

export const MAX_SSH_LISTENERS = 32;
export const MAX_SSH_HOST_KEYS_PER_LISTENER = 32;
export const MAX_SSH_LISTEN_ADDRESSES = 64;
export const MAX_SSH_LISTEN_ADDRESS_LENGTH = 512;
export const MAX_SSH_PATH_LENGTH = 4096;
/** Key text and paths across a whole answer, well inside one link frame. */
export const MAX_SSH_ANSWER_KEY_BYTES = 1024 * 1024;
const sshPath = z.string().min(1).max(MAX_SSH_PATH_LENGTH);

/** Why one configured host key's public file gave no key. */
export const SshHostKeyGapSchema = z.enum([
  "missing",
  "permission-denied",
  /** Not a regular file, a symlink, or the private key itself under another name. */
  "not-a-public-file",
  /** Read, but not an OpenSSH public key line. */
  "invalid",
  /** A relative `HostKey` is the daemon's to resolve, not this Host's. */
  "relative-path",
  "unreadable",
]);
export type SshHostKeyGap = z.infer<typeof SshHostKeyGapSchema>;

export const SshHostKeyFileSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("read"),
    /** The `HostKey` as configured: the private key, never opened. */
    hostKeyPath: sshPath,
    publicKeyPath: sshPath,
    type: z.string().min(1).max(64),
    /** `type base64`, as the public file holds it now, not as sshd loaded it. */
    publicKey: z
      .string()
      .min(1)
      .max(16 * 1024 + 80),
    fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  }),
  z.object({
    outcome: SshHostKeyGapSchema,
    hostKeyPath: sshPath,
    publicKeyPath: sshPath,
  }),
]);
export type SshHostKeyFile = z.infer<typeof SshHostKeyFileSchema>;

/** Why a listener's keys are missing or incomplete, beyond its own key files. */
export const SshListenerGapSchema = z.enum([
  /** Its command line couldn't be read, or its retitled command line couldn't be parsed. */
  "command-line-unreadable",
  /** Another container's or chroot's daemon: its paths aren't this Host's. */
  "other-namespace",
  /** What the daemon sees as `/` couldn't be read, so its paths may not be this Host's. */
  "namespace-unknown",
  /** No daemon binary this Host would run: unknown, or writable by someone else. */
  "untrusted-binary",
  /** A relative `-f` or `-h`, resolved against a directory this Host can't see. */
  "relative-path",
  /** `sshd -G` couldn't read its configuration. */
  "config-unreadable",
  /** An sshd from before `-G` (OpenSSH 9.3): only the command line's own keys are known. */
  "config-dump-unavailable",
  "config-dump-failed",
  "timed-out",
  /** The process went away, or its pid was reused, while it was being read. */
  "exited",
  /** More keys, addresses or path than an answer carries. */
  "truncated",
]);
export type SshListenerGap = z.infer<typeof SshListenerGapSchema>;

export const SshListenerReadingSchema = z
  .object({
    /**
     * The same listener across restarts on this Host: its config file and the
     * addresses it binds. Null when that can't be known, or another listener
     * shares it; such a reading is never a baseline.
     */
    listenerId: z.string().min(1).max(128).nullable(),
    /** Diagnostic only: a restart changes it. */
    pid: z.number().int().positive(),
    /** Every configured key was read, and nothing else is missing. */
    complete: z.boolean(),
    gaps: z.array(SshListenerGapSchema).max(SshListenerGapSchema.options.length),
    /** `-f` as given, or null for the daemon's built-in default. */
    configFile: sshPath.nullable(),
    listenAddresses: z
      .array(z.string().min(1).max(MAX_SSH_LISTEN_ADDRESS_LENGTH))
      .max(MAX_SSH_LISTEN_ADDRESSES),
    keys: z.array(SshHostKeyFileSchema).max(MAX_SSH_HOST_KEYS_PER_LISTENER),
  })
  // A reading may only call itself complete on the evidence it carries.
  .refine(
    (reading) =>
      !reading.complete ||
      (reading.gaps.length === 0 &&
        reading.keys.length > 0 &&
        reading.keys.every((key) => key.outcome === "read")),
    { message: "A complete listener reading has every key and no gaps" }
  );
export type SshListenerReading = z.infer<typeof SshListenerReadingSchema>;

/**
 * The Host's answer to {@link LinkMethod.SSH_HOST_KEYS}. "Couldn't read" is
 * an ordinary answer here: a Host that runs without root sees only what its
 * user may read.
 */
export const SshHostKeysAnswerSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("reading"),
      /** Every listener is complete, and none was left out. */
      complete: z.boolean(),
      /** More listeners than an answer carries were seen. */
      truncated: z.boolean(),
      listeners: z.array(SshListenerReadingSchema).min(1).max(MAX_SSH_LISTENERS),
    })
    .refine(
      (answer) =>
        !answer.complete ||
        (!answer.truncated && answer.listeners.every((listener) => listener.complete)),
      { message: "A complete reading has every listener complete" }
    ),
  /** The process table was readable and showed no sshd listener this Host's user can see. */
  z.object({ status: z.literal("no-sshd-visible") }),
  /** The process table itself couldn't be read. */
  z.object({ status: z.literal("discovery-failed") }),
  /** The read didn't finish in time; a later call may. */
  z.object({ status: z.literal("timed-out") }),
  z.object({ status: z.literal("unsupported-platform"), platform: z.string().min(1).max(64) }),
]);
export type SshHostKeysAnswer = z.infer<typeof SshHostKeysAnswerSchema>;
