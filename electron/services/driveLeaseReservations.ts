// eager-import-allow: restores remote drive reservations via sync fs during lease-service construction, before competing drive requests can be admitted
import { readFileSync } from "node:fs";
import path from "node:path";
import { OWNER_RW_FILE_MODE, resilientAtomicWriteFileSync } from "../utils/fs.js";
import type { DriveLeaseReservation, DriveLeaseReservationStore } from "./DriveLeaseService.js";

/** More than any Host has projects; a file past it is not one this app wrote. */
const MAX_RESERVATIONS = 512;
const MAX_FIELD_LENGTH = 512;
/** The longest tenure the link carries to a Shell; anything longer starts afresh. */
const MAX_TENURE_LENGTH = 256;

function isField(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_FIELD_LENGTH;
}

/** Only well-formed entries survive; anything else in the file is ignored. */
export function parseReservations(raw: string): Record<string, DriveLeaseReservation> {
  const out: Record<string, DriveLeaseReservation> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  let count = 0;
  for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (count >= MAX_RESERVATIONS) break;
    if (!isField(projectId) || !value || typeof value !== "object") continue;
    const { clientId, clientName, deviceId, tenureId, vacant } = value as Record<string, unknown>;
    if (!isField(clientId) || !isField(clientName)) continue;
    // One saved before installs were recorded, or with a damaged install or
    // tenure, still holds the project for its client.
    const tenure = isField(tenureId) && tenureId.length <= MAX_TENURE_LENGTH ? tenureId : null;
    // A project nobody held keeps only its tenure, so without one there is nothing to keep.
    if (vacant === true && tenure === null) continue;
    out[projectId] = {
      clientId,
      clientName,
      ...(isField(deviceId) ? { deviceId } : {}),
      ...(tenure !== null ? { tenureId: tenure } : {}),
      ...(vacant === true ? { vacant: true as const } : {}),
    };
    count++;
  }
  return out;
}

/** The remote holders, in one small file under this app's userData. */
export function createFileReservationStore(userDataDir: string): DriveLeaseReservationStore {
  const filePath = path.join(userDataDir, "drive-lease-reservations.json");
  return {
    load() {
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
      }
      return parseReservations(raw);
    },
    save(reservations) {
      resilientAtomicWriteFileSync(filePath, JSON.stringify(reservations), "utf-8", {
        mode: OWNER_RW_FILE_MODE,
      });
    },
  };
}
