import type {
  DeviceAnswerAuditEntry,
  DeviceAnswerSettings,
  PairedDeviceRecord,
} from "../../../shared/types/ipc/deviceAnswer.js";
import { normalizeTailnetHost } from "./deviceAuth.js";

export const DEFAULT_DEVICE_ANSWER_PORT = 7421;
export const MAX_PAIRED_DEVICES = 10;
export const MAX_AUDIT_ENTRIES = 50;

export function defaultDeviceAnswerSettings(): DeviceAnswerSettings {
  return {
    enabled: false,
    port: DEFAULT_DEVICE_ANSWER_PORT,
    tailnetHost: null,
    devices: [],
    answers: [],
  };
}

export function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/** What was on disk, with anything malformed dropped rather than trusted. */
export function sanitizeDeviceAnswerSettings(raw: unknown): DeviceAnswerSettings {
  const fallback = defaultDeviceAnswerSettings();
  if (typeof raw !== "object" || raw === null) return fallback;
  const value = raw as Partial<DeviceAnswerSettings>;
  const devices = Array.isArray(value.devices)
    ? value.devices.filter(
        (d): d is PairedDeviceRecord =>
          typeof d === "object" &&
          d !== null &&
          typeof d.id === "string" &&
          typeof d.name === "string" &&
          typeof d.tokenHash === "string" &&
          /^[0-9a-f]{64}$/.test(d.tokenHash) &&
          typeof d.pairedAt === "number" &&
          (d.lastSeenAt === null || typeof d.lastSeenAt === "number")
      )
    : [];
  const answers = Array.isArray(value.answers)
    ? value.answers
        .filter(
          (a): a is DeviceAnswerAuditEntry =>
            typeof a === "object" &&
            a !== null &&
            typeof a.at === "number" &&
            typeof a.deviceId === "string" &&
            typeof a.deviceName === "string" &&
            typeof a.runId === "string" &&
            typeof a.label === "string" &&
            (a.outcome === "answered" || a.outcome === "refused")
        )
        .slice(0, MAX_AUDIT_ENTRIES)
    : [];
  return {
    enabled: value.enabled === true,
    port: isValidPort(value.port) ? value.port : fallback.port,
    tailnetHost: normalizeTailnetHost(value.tailnetHost),
    devices: devices.slice(0, MAX_PAIRED_DEVICES),
    answers,
  };
}
