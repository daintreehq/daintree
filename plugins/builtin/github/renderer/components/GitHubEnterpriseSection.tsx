import { useEffect, useState } from "react";
import {
  Button,
  ConfirmDialog,
  Icon,
  Input,
  SettingsActions,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from "@daintreehq/plugin-ui";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { isEnterToSubmit } from "@/lib/enterToSubmit";
import type { ForgeCredentialImportFailureReason } from "@shared/types";
import { GITHUB_REQUIRED_SCOPES } from "../../shared/credentialScopes.js";
import { newClassicTokenUrl } from "../../shared/githubHost.js";
import {
  ENTERPRISE_CHANNELS,
  GITHUB_PLUGIN_ID,
  type EnterpriseImportCommitResult,
  type EnterpriseImportPreviewResult,
  type EnterpriseSetHostResult,
  type EnterpriseStatus,
  type EnterpriseTokenResult,
} from "../../shared/enterprise.js";
import { GitHubCliImportDetails, describeImportFailure } from "./GitHubCliImport";

function invoke<T>(channel: string, args?: unknown): Promise<T> {
  try {
    return window.electron.plugin.invoke(GITHUB_PLUGIN_ID, channel, args) as Promise<T>;
  } catch (error) {
    return Promise.reject(error);
  }
}

type TokenFeedback =
  { kind: "saved" | "tested"; message: string } | { kind: "error"; message: string } | null;

interface ImportPreview {
  host: string;
  account: string;
  scopes: string[];
  missingScopes: string[];
}

interface GitHubEnterpriseSectionProps {
  /** Whether the GitHub CLI is installed, from the tab's own check. */
  isGhAvailable: boolean;
  /** Re-read the GitHub config store after the Enterprise Server token changed. */
  onTokenChanged: () => void;
}

/**
 * The GitHub Enterprise Server host and its own token. github.com's token
 * above is untouched by anything here: each host keeps its own, and neither is
 * ever sent to the other.
 */
export function GitHubEnterpriseSection({
  isGhAvailable,
  onTokenChanged,
}: GitHubEnterpriseSectionProps) {
  const [status, setStatus] = useState<EnterpriseStatus | null>(null);
  const [hostDraft, setHostDraft] = useState("");
  const [hostError, setHostError] = useState<string | null>(null);
  const [isSavingHost, setIsSavingHost] = useState(false);
  const [draft, setDraft] = useState<{ host: string | null; token: string }>({
    host: null,
    token: "",
  });
  const [tokenFeedback, setTokenFeedback] = useState<TokenFeedback>(null);
  const [busy, setBusy] = useState<"test" | "save" | "clear" | "preview" | "commit" | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const refreshStatus = async (): Promise<EnterpriseStatus | null> => {
    try {
      const next = await invoke<EnterpriseStatus>(ENTERPRISE_CHANNELS.status, {
        withAccount: true,
      });
      setStatus(next);
      return next;
    } catch (error) {
      logError("Failed to read GitHub Enterprise Server status", error);
      return null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    void invoke<EnterpriseStatus>(ENTERPRISE_CHANNELS.status, { withAccount: true })
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setHostDraft(next.host ?? "");
      })
      .catch((error: unknown) => {
        logError("Failed to read GitHub Enterprise Server status", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (tokenFeedback?.kind !== "saved" && tokenFeedback?.kind !== "tested") return;
    const timer = setTimeout(() => setTokenFeedback(null), 5000);
    return () => clearTimeout(timer);
  }, [tokenFeedback]);

  const host = status?.host ?? null;
  const hostChanged = hostDraft.trim().toLowerCase() !== (host ?? "");
  // A token draft belongs to the server it was typed for: once the account
  // points somewhere else (here or in another window), the field reads empty.
  const token = draft.host === host ? draft.token : "";
  const setToken = (next: string) => setDraft({ host, token: next });
  const working = busy !== null || isSavingHost;

  const afterTokenChange = () => {
    onTokenChanged();
    void actionService.dispatch("worktree.refresh", undefined, { source: "user" });
  };

  const handleSaveHost = async () => {
    setIsSavingHost(true);
    setHostError(null);
    try {
      const result = await invoke<EnterpriseSetHostResult>(ENTERPRISE_CHANNELS.setHost, {
        host: hostDraft,
      });
      if (!result.ok) {
        setHostError(result.error);
        return;
      }
      setHostDraft(result.host ?? "");
      setToken("");
      setTokenFeedback(null);
      setImportError(null);
      await refreshStatus();
      // Repositories on the new host route to GitHub now; the old host's don't.
      afterTokenChange();
    } catch (error) {
      logError("Failed to save GitHub Enterprise Server host", error);
      setHostError("Couldn't save the host.");
    } finally {
      setIsSavingHost(false);
    }
  };

  const runTokenCheck = async (save: boolean) => {
    if (!token.trim() || !host) return;
    setBusy(save ? "save" : "test");
    setTokenFeedback(null);
    try {
      // The host shown on the field travels with the token: main refuses it if
      // another window has pointed the account at a different server since.
      const result = await invoke<EnterpriseTokenResult>(
        save ? ENTERPRISE_CHANNELS.saveToken : ENTERPRISE_CHANNELS.testToken,
        { token: token.trim(), host }
      );
      if (!result.valid) {
        setTokenFeedback({ kind: "error", message: result.error || "Invalid token" });
        // A refusal can mean the host moved under this form; show where it points now.
        void refreshStatus();
        return;
      }
      if (save) {
        setToken("");
        setTokenFeedback({ kind: "saved", message: "Checked and saved" });
        await refreshStatus();
        afterTokenChange();
      } else {
        setTokenFeedback({ kind: "tested", message: "Token works — not saved yet" });
      }
    } catch (error) {
      logError("Failed to check GitHub Enterprise Server token", error);
      setTokenFeedback({
        kind: "error",
        message: save ? "Couldn't save token" : "Couldn't validate token",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async () => {
    setConfirmingClear(false);
    setBusy("clear");
    try {
      const result = await invoke<{ cleared: boolean }>(ENTERPRISE_CHANNELS.clearToken, { host });
      if (!result.cleared) {
        setTokenFeedback({
          kind: "error",
          message:
            "The Enterprise Server host changed in another window. Check it, then try again.",
        });
        await refreshStatus();
        return;
      }
      setTokenFeedback(null);
      await refreshStatus();
      afterTokenChange();
    } catch (error) {
      logError("Failed to clear GitHub Enterprise Server token", error);
      setTokenFeedback({ kind: "error", message: "Couldn't clear token" });
    } finally {
      setBusy(null);
    }
  };

  // Reading gh's token can raise an OS keychain prompt, so it runs only from a click.
  const handlePreviewImport = async () => {
    if (!host) return;
    setImportError(null);
    setBusy("preview");
    try {
      const preview = await invoke<EnterpriseImportPreviewResult>(
        ENTERPRISE_CHANNELS.previewImport
      );
      if (!preview.ok) {
        setImportError(
          describeImportFailure(preview.reason as ForgeCredentialImportFailureReason, host)
        );
        return;
      }
      setImportPreview(preview);
    } catch (error) {
      logError("Failed to preview GitHub CLI token import", error);
      setImportError("Couldn't read the GitHub CLI token.");
    } finally {
      setBusy(null);
    }
  };

  const handleConfirmImport = async () => {
    if (!importPreview || busy === "commit") return;
    setBusy("commit");
    try {
      const result = await invoke<EnterpriseImportCommitResult>(ENTERPRISE_CHANNELS.commitImport, {
        account: importPreview.account,
        host: importPreview.host,
      });
      setImportPreview(null);
      if (!result.ok) {
        setImportError(
          result.reason === "host-changed"
            ? "The Enterprise Server host changed since the preview. Import again."
            : describeImportFailure(result.reason as ForgeCredentialImportFailureReason, host ?? "")
        );
        return;
      }
      setToken("");
      setTokenFeedback({ kind: "saved", message: "Checked and saved" });
      await refreshStatus();
      afterTokenChange();
    } catch (error) {
      logError("Failed to import GitHub CLI token", error);
      setImportPreview(null);
      setImportError("Couldn't save the imported token.");
    } finally {
      setBusy(null);
    }
  };

  const tokenError = tokenFeedback?.kind === "error" ? tokenFeedback.message : undefined;
  const tokenStatus =
    tokenFeedback && tokenFeedback.kind !== "error" ? (
      <span className="flex items-center gap-1">
        <Icon
          name={tokenFeedback.kind === "saved" ? "circle-check" : "check"}
          className="w-3 h-3 shrink-0"
        />
        {tokenFeedback.message}
      </span>
    ) : tokenError ? (
      <span className="sr-only">{tokenError}</span>
    ) : null;

  const statusText = !host
    ? null
    : status?.hasToken
      ? status.account
        ? `Token saved for @${status.account}`
        : "Token saved"
      : status?.staleTokenHost
        ? `No token for ${host}. The token saved for ${status.staleTokenHost} isn't used here.`
        : "No token saved";

  return (
    <SettingsSection
      id="github-enterprise"
      title="GitHub Enterprise Server"
      description="Repositories on your company's GitHub Enterprise Server host get the same pull request, issue and CI context as github.com ones. The server keeps its own token, which is only ever sent to that host."
    >
      <SettingsGroup>
        <SettingsRow
          label="Server host"
          description="The hostname your repositories are cloned from, like github.example.com. Leave empty if you only use github.com."
          layout="stacked"
          disabled={working}
          error={hostError ?? undefined}
          control={({ labelId, descriptionId, disabled: rowDisabled }) => (
            <Input
              value={hostDraft}
              onValueChange={(next) => {
                setHostDraft(next);
                setHostError(null);
              }}
              onKeyDown={(e) => {
                if (!isEnterToSubmit(e)) return;
                e.preventDefault();
                if (working || !hostChanged) return;
                void handleSaveHost();
              }}
              placeholder="github.example.com"
              aria-label="GitHub Enterprise Server host"
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              aria-invalid={hostError ? true : undefined}
              invalid={Boolean(hostError)}
              spellCheck={false}
              autoComplete="off"
              disabled={rowDisabled}
              className="w-full"
            />
          )}
        />
        <SettingsActions>
          <Button
            onClick={handleSaveHost}
            disabled={busy !== null || !hostChanged}
            loading={isSavingHost}
            variant="contrast"
            size="sm"
            aria-label="Save Enterprise Server host"
          >
            Save
          </Button>
        </SettingsActions>
      </SettingsGroup>

      {host && (
        <>
          <SettingsGroup>
            <SettingsRow
              label="Status"
              control={
                <span className="flex items-center gap-1 text-xs text-text-secondary select-text">
                  {status?.hasToken && <Icon name="check" className="w-3 h-3" />}
                  {statusText}
                </span>
              }
            />
            <SettingsRow
              label={`Personal access token for ${host}`}
              description="Test checks a token without saving it; Save checks it, then stores it"
              layout="stacked"
              disabled={working}
              error={tokenError}
              control={({ labelId, descriptionId, disabled: rowDisabled }) => (
                <Input
                  type="password"
                  value={token}
                  onValueChange={(next) => {
                    setToken(next);
                    if (tokenFeedback) setTokenFeedback(null);
                  }}
                  onKeyDown={(e) => {
                    if (!isEnterToSubmit(e)) return;
                    e.preventDefault();
                    if (working) return;
                    void runTokenCheck(true);
                  }}
                  placeholder={
                    status?.hasToken ? "Enter new token to replace" : "ghp_... or github_pat_..."
                  }
                  aria-label={`Personal access token for ${host}`}
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  aria-invalid={tokenError ? true : undefined}
                  invalid={Boolean(tokenError)}
                  autoComplete="new-password"
                  disabled={rowDisabled}
                  className="w-full"
                />
              )}
            />
            <SettingsActions status={tokenStatus}>
              <Button
                onClick={() => void runTokenCheck(false)}
                disabled={working || !token.trim()}
                loading={busy === "test"}
                variant="outline"
                size="sm"
                aria-label="Test Enterprise Server token"
                icon="flask"
              >
                Test
              </Button>
              <Button
                onClick={() => void runTokenCheck(true)}
                disabled={working || !token.trim()}
                loading={busy === "save"}
                variant="contrast"
                size="sm"
                aria-label="Save Enterprise Server token"
              >
                Save
              </Button>
            </SettingsActions>
          </SettingsGroup>

          <SettingsGroup>
            <SettingsRow
              label="Get a token"
              description={`${
                isGhAvailable
                  ? `Import the token the GitHub CLI holds for ${host}, or create one there`
                  : `Create one on ${host}`
              } with the ${GITHUB_REQUIRED_SCOPES.join(" and ")} scopes.`}
              error={
                importError ? (
                  <span role="alert" className="select-text">
                    {importError}
                  </span>
                ) : undefined
              }
              layout="stacked"
              control={
                <div className="flex flex-wrap gap-2">
                  {isGhAvailable && (
                    <Button
                      onClick={handlePreviewImport}
                      disabled={working && busy !== "preview"}
                      loading={busy === "preview"}
                      variant="outline"
                      size="sm"
                      icon="import"
                    >
                      Import from GitHub CLI
                    </Button>
                  )}
                  <Button
                    onClick={() =>
                      void actionService.dispatch(
                        "system.openExternal",
                        { url: newClassicTokenUrl(host, GITHUB_REQUIRED_SCOPES) },
                        { source: "user" }
                      )
                    }
                    variant="outline"
                    size="sm"
                    icon="external-link"
                  >
                    Create token on {host}
                  </Button>
                </div>
              }
            />
          </SettingsGroup>
        </>
      )}

      {(status?.hasToken || status?.staleTokenHost) && (
        <SettingsGroup>
          <SettingsRow
            label="Stored Enterprise Server token"
            description="Clearing removes Daintree's copy; github.com's token stays"
            control={
              <Button
                onClick={() => setConfirmingClear(true)}
                disabled={working}
                loading={busy === "clear"}
                variant="ghost-danger"
                size="sm"
                aria-label="Clear Enterprise Server token"
              >
                Clear token
              </Button>
            }
          />
        </SettingsGroup>
      )}

      <ConfirmDialog
        open={confirmingClear}
        variant="destructive"
        onConfirm={() => void handleClear()}
        onClose={() => setConfirmingClear(false)}
        title="Clear the Enterprise Server token?"
        description="Daintree's copy is deleted. Pull requests, issues and CI for Enterprise Server repositories stop until you add a token again."
        confirmLabel="Clear token"
        layer="nested"
      />

      <ConfirmDialog
        open={importPreview !== null}
        onClose={() => setImportPreview(null)}
        title={`Import token for @${importPreview?.account ?? ""} on ${importPreview?.host ?? ""}?`}
        description="Daintree saves its own copy of the token the GitHub CLI holds for this account on this host."
        confirmLabel="Import token"
        onConfirm={handleConfirmImport}
        loading={busy === "commit"}
        variant="default"
        layer="nested"
      >
        {importPreview && (
          <GitHubCliImportDetails
            scopes={importPreview.scopes}
            missingScopes={importPreview.missingScopes}
            replacesToken={status?.hasToken === true}
          />
        )}
      </ConfirmDialog>
    </SettingsSection>
  );
}
