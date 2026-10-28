import type { IpcInvokeMap } from "../../types/index.js";

export const REVIEW_MARKS_METHOD_CHANNELS = {
  hydrate: "review-marks:hydrate",
  mark: "review-marks:mark",
  markCaptured: "review-marks:mark-captured",
  clear: "review-marks:clear",
  capture: "review-marks:capture",
  compare: "review-marks:compare",
  fileSince: "review-marks:file-since",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof REVIEW_MARKS_METHOD_CHANNELS;

export type ReviewMarksPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildReviewMarksPreloadBindings(invoke: Invoker): ReviewMarksPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(REVIEW_MARKS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = REVIEW_MARKS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ReviewMarksPreloadBindings;
}
