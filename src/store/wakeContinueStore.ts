import { create } from "zustand";
import type { DeliveryState } from "@/services/agentRequests/deliveryState";
import type { WakeCandidate } from "@/services/wakeContinue/wakeCandidate";

export interface WakeContinueEntry extends WakeCandidate {
  /** Where its note got to, once sending started; absent while it waits its turn. */
  delivery?: DeliveryState;
}

export interface WakeContinueOffer {
  /** One per restore that brought agents back; a newer one replaces it. */
  id: string;
  projectId: string;
  entries: WakeContinueEntry[];
  phase: "offered" | "sending" | "done";
}

interface WakeContinueState {
  offer: WakeContinueOffer | null;
  dialogOpen: boolean;
  setOffer: (offer: WakeContinueOffer | null) => void;
  setDialogOpen: (open: boolean) => void;
  setPhase: (offerId: string, phase: WakeContinueOffer["phase"]) => void;
  setDelivery: (offerId: string, terminalId: string, delivery: DeliveryState) => void;
}

/**
 * The continue-note offer for agents a restore resumed (#17883). Ephemeral and
 * per project view: the offer belongs to the wake that made it, and nothing
 * about it survives the view.
 */
export const useWakeContinueStore = create<WakeContinueState>((set) => ({
  offer: null,
  dialogOpen: false,
  setOffer: (offer) => set({ offer, dialogOpen: false }),
  setDialogOpen: (dialogOpen) => set({ dialogOpen }),
  setPhase: (offerId, phase) =>
    set((state) => (state.offer?.id === offerId ? { offer: { ...state.offer, phase } } : state)),
  setDelivery: (offerId, terminalId, delivery) =>
    set((state) => {
      if (state.offer?.id !== offerId) return state;
      return {
        offer: {
          ...state.offer,
          entries: state.offer.entries.map((entry) =>
            entry.terminalId === terminalId ? { ...entry, delivery } : entry
          ),
        },
      };
    }),
}));
