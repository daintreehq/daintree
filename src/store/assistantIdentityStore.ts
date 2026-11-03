import { create } from "zustand";
import type { AssistantIdentities, DisplayIdentity } from "@shared/types/displayIdentity";
import { EMPTY_ASSISTANT_IDENTITIES } from "@shared/utils/displayIdentity";

interface AssistantIdentityState {
  /**
   * The personas the person gave the assistants (#16213), as the host this
   * view's project lives on stores them. Empty until the first read lands,
   * which every surface shows as today's labels.
   */
  identities: AssistantIdentities;
  apply: (identities: AssistantIdentities) => void;
}

export const useAssistantIdentityStore = create<AssistantIdentityState>()((set) => ({
  identities: EMPTY_ASSISTANT_IDENTITIES,
  apply: (identities) => set({ identities }),
}));

const NO_IDENTITY: DisplayIdentity = {};

export function useGlobalAssistantIdentity(): DisplayIdentity {
  return useAssistantIdentityStore((state) => state.identities.global);
}

/** This project's assistant persona; empty without a project or a persona. */
export function useProjectAssistantIdentity(projectId: string | null | undefined): DisplayIdentity {
  return useAssistantIdentityStore((state) =>
    projectId && Object.hasOwn(state.identities.projects, projectId)
      ? (state.identities.projects[projectId] ?? NO_IDENTITY)
      : NO_IDENTITY
  );
}
