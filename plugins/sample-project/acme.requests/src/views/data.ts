import { useCachedHostChannel } from "@daintreehq/plugin-sdk/react";
import {
  CHANNELS,
  EVENTS,
  type ConnectionStatus,
  type ReportSummary,
  type RequestRecord,
} from "../contracts";

/** The list channel's page: the worker answers with at most this many, newest first. */
export const MAX_LISTED = 100;

/**
 * Reads the views share. Each is cached across mounts and refetched only when
 * the worker pushes the matching event, so switching between Home, the
 * sidebar and the grid never re-asks for what is already on screen, and no
 * view polls.
 */
export function useRequests(pluginId: string) {
  return useCachedHostChannel<Record<string, never>, RequestRecord[]>(
    pluginId,
    CHANNELS.list,
    {},
    {
      invalidateOn: EVENTS.requestsChanged,
    }
  );
}

export function useReports(pluginId: string) {
  return useCachedHostChannel<Record<string, never>, ReportSummary[]>(
    pluginId,
    CHANNELS.reports,
    {},
    { invalidateOn: EVENTS.reportsChanged }
  );
}

export function useConnection(pluginId: string) {
  return useCachedHostChannel<Record<string, never>, ConnectionStatus>(
    pluginId,
    CHANNELS.connection,
    {},
    { invalidateOn: EVENTS.connectionChanged }
  );
}

export function call<T>(pluginId: string, channel: string, args?: unknown): Promise<T> {
  return window.electron.plugin.invoke(pluginId, channel, args) as Promise<T>;
}
