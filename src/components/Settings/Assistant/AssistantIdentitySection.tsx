import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { PersonaEmojiButton } from "@/components/Persona/PersonaEmojiButton";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import {
  useAssistantIdentityStore,
  useGlobalAssistantIdentity,
  useProjectAssistantIdentity,
} from "@/store/assistantIdentityStore";
import type { AssistantIdentityScope, DisplayIdentity } from "@shared/types/displayIdentity";
import {
  DISPLAY_NAME_MAX,
  isEmptyDisplayIdentity,
  normalizeDisplayName,
} from "@shared/utils/displayIdentity";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import { SettingsSection } from "../SettingsSection";
import { SettingsGroup, SettingsRow } from "../SettingsGroup";

async function saveIdentity(
  scope: AssistantIdentityScope,
  identity: DisplayIdentity
): Promise<string | null> {
  try {
    const identities = await window.electron.helpAssistant.setIdentity({ scope, identity });
    useAssistantIdentityStore.getState().apply(identities);
    return null;
  } catch (error) {
    logError("Failed to save the assistant's name and emoji", error);
    return formatErrorMessage(error, "Couldn't save the name and emoji");
  }
}

interface IdentityRowProps {
  scope: AssistantIdentityScope;
  label: string;
  description: string;
  /** What the assistant is called while it has no name. */
  fallback: string;
  identity: DisplayIdentity;
}

function IdentityRow({ scope, label, description, fallback, identity }: IdentityRowProps) {
  // null shows the saved name; a string is an edit not yet saved.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shownName = draft ?? identity.name ?? "";

  const save = async (next: DisplayIdentity) => {
    const failure = await saveIdentity(scope, next);
    setError(failure);
    return failure === null;
  };

  const commitName = async () => {
    if (draft === null) return;
    const name = normalizeDisplayName(draft);
    if (name === identity.name) {
      setDraft(null);
      return;
    }
    if (await save({ ...(name && { name }), ...(identity.emoji && { emoji: identity.emoji }) })) {
      setDraft(null);
    }
  };

  // A name typed and left without a blur (the dialog closed on Escape) still
  // saves. The row is keyed by its scope, so it never outlives the one it saves.
  const pendingRef = useRef({ scope, draft, identity });
  useEffect(() => {
    pendingRef.current = { scope, draft, identity };
  });
  useEffect(() => {
    const pending = pendingRef;
    return () => {
      const { scope: lastScope, draft: lastDraft, identity: saved } = pending.current;
      if (lastDraft === null) return;
      const name = normalizeDisplayName(lastDraft);
      if (name === saved.name) return;
      void saveIdentity(lastScope, {
        ...(name && { name }),
        ...(saved.emoji && { emoji: saved.emoji }),
      });
    };
  }, []);

  return (
    <SettingsRow
      label={label}
      description={description}
      isModified={!isEmptyDisplayIdentity(identity)}
      onReset={() => {
        setDraft(null);
        void save({});
      }}
      resetAriaLabel={`Reset ${label.toLowerCase()} name and emoji`}
      error={error ?? undefined}
      control={({ labelId, descriptionId, disabled }) => (
        <div className="flex items-center gap-2">
          <PersonaEmojiButton
            emoji={identity.emoji}
            ariaLabel={`${label} emoji`}
            disabled={disabled}
            onEmojiChange={(emoji) => {
              const name = normalizeDisplayName(draft ?? identity.name);
              void save({ ...(name && { name }), ...(emoji && { emoji }) }).then((saved) => {
                if (saved) setDraft(null);
              });
            }}
          />
          <Input
            className="w-60"
            value={shownName}
            placeholder={fallback}
            maxLength={DISPLAY_NAME_MAX * 4}
            disabled={disabled}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitName();
              } else if (event.key === "Escape" && draft !== null) {
                // Escape backs out of the edit; a second one closes the dialog.
                event.preventDefault();
                event.stopPropagation();
                setDraft(null);
              }
            }}
          />
        </div>
      )}
    />
  );
}

/**
 * The names and emoji the assistants go by (#16213). Display only: a named
 * assistant is the same assistant, with the same context and permissions.
 */
export function AssistantIdentitySection() {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const scratchId = useScratchStore((s) => s.currentScratch?.id ?? null);
  const workspaceId = projectId ?? scratchId;
  const projectIdentity = useProjectAssistantIdentity(workspaceId);
  const globalIdentity = useGlobalAssistantIdentity();
  return (
    <SettingsSection
      title="Name and emoji"
      description="Shown in the assistant panel, Canopy and the assistant picker. Without a name, each keeps its scope's label."
    >
      <SettingsGroup>
        {workspaceId && (
          <IdentityRow
            key={`project:${workspaceId}`}
            scope={{ kind: "project", projectId: workspaceId }}
            label="This project's assistant"
            description="Every session in this project goes by it"
            fallback="Project"
            identity={projectIdentity}
          />
        )}
        <IdentityRow
          key="global"
          scope={{ kind: "global" }}
          label="Global assistant"
          description="The one assistant for every project and window"
          fallback="Global"
          identity={globalIdentity}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
