import {
  answerLocalRun,
  listLocalWaitingRuns,
} from "../../services/deviceAnswer/localDeviceAnswer.js";
import { installDeviceAnswerHostWith, type DeviceAnswerSessionSource } from "./host.js";

/** Answer this host's agents for devices paired with the Shells attached to it. */
export function installDeviceAnswerHost(server: DeviceAnswerSessionSource): () => void {
  return installDeviceAnswerHostWith(server, {
    list: listLocalWaitingRuns,
    answer: answerLocalRun,
  });
}
