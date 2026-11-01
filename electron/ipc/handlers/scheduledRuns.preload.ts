import type { IpcInvokeMap } from "../../types/index.js";

export const SCHEDULED_RUNS_METHOD_CHANNELS = {
  listByProject: "scheduled-runs:list-by-project",
  listBySchedule: "scheduled-runs:list-by-schedule",
  takeInbox: "scheduled-runs:take-inbox",
  ackInbox: "scheduled-runs:ack-inbox",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof SCHEDULED_RUNS_METHOD_CHANNELS;

export type ScheduledRunsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildScheduledRunsPreloadBindings(invoke: Invoker): ScheduledRunsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(SCHEDULED_RUNS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = SCHEDULED_RUNS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ScheduledRunsPreloadBindings;
}
