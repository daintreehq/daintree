import type {
  DeviceAnswerEvent,
  DeviceAnswerStatus,
  SetDeviceAnswerPayload,
} from "@shared/types/ipc/deviceAnswer";

/** Answering this machine's agents from another device. Always answered by this machine. */
export const deviceAnswerClient = {
  getStatus: (): Promise<DeviceAnswerStatus> => {
    return window.electron.deviceAnswer.getStatus();
  },

  setEnabled: (payload: SetDeviceAnswerPayload): Promise<DeviceAnswerStatus> => {
    return window.electron.deviceAnswer.setEnabled(payload);
  },

  createPairingCode: (): Promise<DeviceAnswerStatus> => {
    return window.electron.deviceAnswer.createPairingCode();
  },

  cancelPairingCode: (): Promise<DeviceAnswerStatus> => {
    return window.electron.deviceAnswer.cancelPairingCode();
  },

  revokeDevice: (deviceId: string): Promise<DeviceAnswerStatus> => {
    return window.electron.deviceAnswer.revokeDevice(deviceId);
  },

  onEvent: (callback: (event: DeviceAnswerEvent) => void): (() => void) => {
    return window.electron.deviceAnswer.onEvent(callback);
  },
} as const;
