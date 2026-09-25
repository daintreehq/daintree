import { defineIpcNamespace, op } from "../define.js";
import { pendingRemoteHostsHandler } from "../../remote/pendingHandler.js";
import { HOST_FILES_METHOD_CHANNELS } from "./hostFiles.preload.js";
import type {
  HostDirectoryListing,
  HostPickerRoots,
  ListHostDirectoryPayload,
} from "../../../shared/types/ipc/hostFiles.js";

export const hostFilesNamespace = defineIpcNamespace({
  name: "hostFiles",
  ops: {
    listDirectory: op(
      HOST_FILES_METHOD_CHANNELS.listDirectory,
      async (_payload: ListHostDirectoryPayload): Promise<HostDirectoryListing> =>
        pendingRemoteHostsHandler(HOST_FILES_METHOD_CHANNELS.listDirectory)
    ),
    getPickerRoots: op(
      HOST_FILES_METHOD_CHANNELS.getPickerRoots,
      async (): Promise<HostPickerRoots> =>
        pendingRemoteHostsHandler(HOST_FILES_METHOD_CHANNELS.getPickerRoots)
    ),
  },
});

export function registerHostFilesHandlers(): () => void {
  return hostFilesNamespace.register();
}
