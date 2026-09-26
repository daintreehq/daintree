import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { HostModeObservation } from "../../../shared/types/ipc/remoteHosts.js";

/**
 * `host-mode.json`, beside the host socket: Host mode as this process last
 * recorded it (the saved setting, start at login, the keychain check). Setup
 * on another machine reads it over SSH to confirm that turning Host mode on
 * really saved the setting and installed start at login, whatever build is
 * running and without a link. It holds nothing secret.
 */

export const HOST_MODE_STATUS_NAME = "host-mode.json";

const MAX_TEXT = 512;

const ObservationSchema = z.object({
  daintreeHostMode: z.literal(1),
  pid: z.number().int().min(0),
  enabled: z.boolean(),
  startAtLogin: z.boolean(),
  startAtLoginInstalled: z.boolean().nullable(),
  startAtLoginError: z.string().max(MAX_TEXT).nullable(),
  keychain: z.object({
    state: z.enum(["ok", "warning", "unavailable", "unknown"]),
    detail: z.string().max(MAX_TEXT),
    checked: z.boolean(),
  }),
});

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

export function formatHostModeStatus(observation: HostModeObservation): string {
  return JSON.stringify({
    daintreeHostMode: 1,
    ...observation,
    startAtLoginError:
      observation.startAtLoginError === null ? null : clip(observation.startAtLoginError),
    keychain: { ...observation.keychain, detail: clip(observation.keychain.detail) },
  });
}

/** Null for anything that is not a well-formed status file. */
export function parseHostModeStatus(text: string): HostModeObservation | null {
  if (!text || text.length > 8 * 1024) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ObservationSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { daintreeHostMode: _marker, ...observation } = parsed.data;
  return observation;
}

export async function writeHostModeStatusFile(
  dir: string,
  observation: HostModeObservation
): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, HOST_MODE_STATUS_NAME);
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmp, formatHostModeStatus(observation), { mode: 0o600, flag: "wx" });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
