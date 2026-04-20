import { appClient } from "@/clients";

export const fleetDeckController = {
  persistOpen: (isOpen: boolean): Promise<void> =>
    appClient.setState({ fleetDeckOpen: isOpen }).catch((error) => {
      console.error("Failed to persist fleet deck open state:", error);
    }),

  persistAlwaysPreview: (value: boolean): Promise<void> =>
    appClient.setState({ fleetDeckAlwaysPreview: value }).catch((error) => {
      console.error("Failed to persist fleet deck alwaysPreview:", error);
    }),

  persistQuorumThreshold: (value: number): Promise<void> =>
    appClient.setState({ fleetDeckQuorumThreshold: value }).catch((error) => {
      console.error("Failed to persist fleet deck quorumThreshold:", error);
    }),
};
