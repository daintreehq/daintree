import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * This install's id as hosts know it: minted once into `dir` (inside its own
 * user data) and read back on every launch, so a host can tell two Shells on
 * machines with the same name apart and remember each across restarts.
 */
export function readOrCreateDeviceId(dir: string): string {
  const file = path.join(dir, "device-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (UUID.test(existing)) return existing;
  } catch {
    // Not there yet, or unreadable: a new one below.
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, id, { mode: 0o600 });
  } catch {
    // Kept for this launch only; the next one tries to save it again.
  }
  return id;
}
