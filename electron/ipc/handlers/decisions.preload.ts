import type { IpcInvokeMap } from "../../types/index.js";

export const DECISIONS_METHOD_CHANNELS = {
  getStatus: "decisions:get-status",
  getPaneState: "decisions:get-pane-state",
  setEnabled: "decisions:set-enabled",
  checkRelay: "decisions:check-relay",
  claimRelay: "decisions:claim-relay",
  restoreIdentity: "decisions:restore-identity",
  disconnectRelay: "decisions:disconnect-relay",
  listDevices: "decisions:list-devices",
  startPairing: "decisions:start-pairing",
  getPairing: "decisions:get-pairing",
  approvePairing: "decisions:approve-pairing",
  declinePairing: "decisions:decline-pairing",
  exportData: "decisions:export-data",
  deleteRelayData: "decisions:delete-relay-data",
  deleteLocalData: "decisions:delete-local-data",
  getPolicy: "decisions:get-policy",
  setProxyAllowlisted: "decisions:set-proxy-allowlisted",
  exportRecoveryKit: "decisions:export-recovery-kit",
  verifyRecoveryKit: "decisions:verify-recovery-kit",
  revokeDevice: "decisions:revoke-device",
  rotateKeys: "decisions:rotate-keys",
  listHosts: "decisions:list-hosts",
  enrollHost: "decisions:enroll-host",
  setAutoEnrollHosts: "decisions:set-auto-enroll-hosts",
  startSetupCheck: "decisions:start-setup-check",
  getSetupCheck: "decisions:get-setup-check",
  cancelSetupCheck: "decisions:cancel-setup-check",
  listAttention: "decisions:list-attention",
  copyAnswer: "decisions:copy-answer",
  resumeAnswer: "decisions:resume-answer",
  listAnswerDestinations: "decisions:list-answer-destinations",
  reassignAnswer: "decisions:reassign-answer",
  markAnswerHandled: "decisions:mark-answer-handled",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof DECISIONS_METHOD_CHANNELS;

export type DecisionsPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildDecisionsPreloadBindings(invoke: Invoker): DecisionsPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(DECISIONS_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = DECISIONS_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as DecisionsPreloadBindings;
}
