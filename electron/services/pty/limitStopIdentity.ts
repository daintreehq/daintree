import { createHash } from "node:crypto";

/**
 * A stop banner's identity as it may leave the pty host (#18193): a digest of
 * what the agent's banner parsed as, so a stop saved before a cold restart can
 * be matched against the restored process's redraw of it without the banner's
 * words being kept anywhere.
 */
export function limitStopIdentity(agentId: "codex" | "claude", bannerKey: string): string {
  return createHash("sha256").update(`${agentId}\u0000${bannerKey}`).digest("hex").slice(0, 32);
}
