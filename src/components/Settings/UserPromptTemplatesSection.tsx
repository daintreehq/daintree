import { useEffect, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { useUserPromptTemplateStore } from "@/store/userPromptTemplateStore";
import { deviceOwnerPhrase, useRemoteHostName } from "@/hooks/useSettingsOwner";
import { logError } from "@/utils/logger";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSection } from "./SettingsSection";

/**
 * Where a person's prompt templates live and which of their files were left out.
 * Read again on opening and each time the window comes back, since the fix for
 * a bad file is made in another app.
 */
export function UserPromptTemplatesSection() {
  const directory = useUserPromptTemplateStore((s) => s.directory);
  const problems = useUserPromptTemplateStore((s) => s.problems);
  const remoteHostName = useRemoteHostName();
  const [openFailed, setOpenFailed] = useState(false);

  useEffect(() => {
    const refresh = () => useUserPromptTemplateStore.getState().refresh();
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const handleOpenFolder = () => {
    void window.electron.userPromptTemplates.openFolder().then(
      (result) => {
        setOpenFailed(!result.opened);
        useUserPromptTemplateStore.getState().refresh();
      },
      (err) => {
        logError("Failed to open the prompt templates folder", err);
        setOpenFailed(true);
      }
    );
  };

  return (
    <SettingsSection id="agents-prompt-templates" title="Prompt templates">
      <SettingsGroup>
        <SettingsRow
          label="Templates folder"
          description={
            <>
              Markdown files here join the <code className="font-mono">/</code> menu of every agent,
              in every project.
              {remoteHostName &&
                ` They're read from ${deviceOwnerPhrase()}, including while you work on ${remoteHostName}.`}
              {directory && <code className="mt-1 block font-mono break-all">{directory}</code>}
            </>
          }
          control={
            <Button variant="outline" size="sm" onClick={handleOpenFolder}>
              <FolderOpen />
              {remoteHostName ? `Open folder on ${deviceOwnerPhrase()}` : "Open folder"}
            </Button>
          }
          error={openFailed ? "Couldn't open the folder. It's at the path above" : undefined}
        />
      </SettingsGroup>
      {problems.length > 0 && (
        <Callout
          severity="warning"
          title="Some templates weren't loaded"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => useUserPromptTemplateStore.getState().refresh()}
            >
              <RefreshCw />
              Retry
            </Button>
          }
        >
          <ul className="space-y-1">
            {problems.map((problem) => (
              <li key={problem.fileName ?? problem.reason} className="break-words">
                {problem.fileName && <code className="font-mono">{problem.fileName}</code>}
                {problem.fileName && ": "}
                {problem.reason}
              </li>
            ))}
          </ul>
        </Callout>
      )}
    </SettingsSection>
  );
}
