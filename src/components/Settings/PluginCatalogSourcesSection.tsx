import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { PluginCatalogSourceRefusal } from "@shared/types/plugin";
import { describeCatalogSource } from "@shared/utils/pluginInstallSource";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SECTION_SETTINGS } from "@/components/Settings/settingsSectionOwners";
import { SettingsSection } from "./SettingsSection";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { logError } from "@/utils/logger";

/** Why a catalog wasn't added, as the field's error says it. */
export const CATALOG_SOURCE_REFUSAL_COPY: Record<PluginCatalogSourceRefusal, string> = {
  malformed: "Enter a full https:// address",
  insecure: "Use https://. A catalog sent over http:// can be changed on its way to you",
  credentials: "Take the user name and password out of the address",
  "private-host": "Use a public address. Catalogs on private or local networks aren't supported",
  "too-long": "That address is too long",
  builtin: "That's Daintree's own catalog, which is always listed",
  duplicate: "That catalog is already in the list",
  "too-many": "Remove a catalog to add another",
};

/**
 * The plugin catalogs Browse reads beside Daintree's own (#17434). Each one
 * is a trust decision like a URL install: its curator, not Daintree, reviewed
 * what it lists, which the section says before anything is added. One change
 * at a time, and each answer from main is the whole list, so a list another
 * window changed is never written back over.
 */
export function PluginCatalogSourcesSection() {
  const [sources, setSources] = useState<string[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const [draft, setDraft] = useState("");
  const [refusal, setRefusal] = useState<PluginCatalogSourceRefusal | null>(null);
  const [failedSave, setFailedSave] = useState<{
    kind: "add" | "remove";
    message: string;
    retry: () => void;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // What the field holds now, so an answer for an address that has since been
  // edited never clears or flags the new one.
  const draftRef = useRef("");
  const changeDraft = (value: string) => {
    draftRef.current = value;
    setDraft(value);
  };
  // Only the latest read or write may settle the list, so a slow read can't
  // put back a catalog a removal that started after it already took out. A
  // write's own outcome (busy, its error, the field) is never skipped: the
  // change event its save broadcasts starts a read while it is still pending.
  const listSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const seq = ++listSeq.current;
    window.electron.plugin
      .getCatalogSources()
      .then(({ sources: next }) => {
        if (cancelled || seq !== listSeq.current) return;
        setSources(next);
        setLoadFailed(false);
      })
      .catch((err: unknown) => {
        if (cancelled || seq !== listSeq.current) return;
        logError("Failed to load plugin catalogs", err);
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadNonce]);

  // Another window's change re-reads the list rather than racing it.
  useEffect(
    () => window.electron.plugin.onCatalogSourcesChanged?.(() => setLoadNonce((n) => n + 1)),
    []
  );

  /** A control disabled while it saved dropped focus to the page; hand it to the field. */
  const keepFocus = () => {
    setTimeout(() => {
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected) {
        inputRef.current?.focus();
      }
    }, 0);
  };

  const add = () => {
    const url = draftRef.current.trim();
    if (busy || url.length === 0) return;
    const seq = ++listSeq.current;
    setBusy(true);
    setFailedSave(null);
    window.electron.plugin
      .addCatalogSource(url)
      .then((result) => {
        if (seq === listSeq.current) setSources(result.sources);
        if (draftRef.current.trim() !== url) return;
        if (result.status === "added") {
          changeDraft("");
          setRefusal(null);
        } else {
          setRefusal(result.reason);
        }
      })
      .catch((err: unknown) => {
        logError("Failed to add a plugin catalog", err);
        if (draftRef.current.trim() !== url) return;
        setFailedSave({ kind: "add", message: "The catalog wasn't added.", retry: add });
      })
      .finally(() => {
        setBusy(false);
        keepFocus();
      });
  };

  const remove = (sourceUrl: string) => {
    if (busy) return;
    const seq = ++listSeq.current;
    setBusy(true);
    setFailedSave(null);
    window.electron.plugin
      .removeCatalogSource(sourceUrl)
      .then((result) => {
        if (seq === listSeq.current) setSources(result.sources);
      })
      .catch((err: unknown) => {
        logError("Failed to remove a plugin catalog", err);
        setFailedSave({
          kind: "remove",
          message: `${describeCatalogSource(sourceUrl)} is still in the list.`,
          retry: () => remove(sourceUrl),
        });
      })
      .finally(() => {
        setBusy(false);
        keepFocus();
      });
  };

  return (
    <SettingsSection
      id="plugins-catalogs"
      title="Plugin catalogs"
      settings={SECTION_SETTINGS.pluginCatalogs}
      description="Browse lists plugins from Daintree's catalog and any catalog you add here. Whoever runs an added catalog decides what it lists and reviews it, not Daintree. Removing one stops Browse listing it; plugins you installed from it keep getting its updates."
    >
      {loadFailed && (
        <SettingsLoadErrorBanner
          title="Couldn't load your plugin catalogs"
          message="The catalogs you added couldn't be read."
          onRetry={() => setLoadNonce((n) => n + 1)}
        />
      )}
      {failedSave && (
        <SettingsLoadErrorBanner
          title="Couldn't save your plugin catalogs"
          message={failedSave.message}
          onRetry={failedSave.retry}
        />
      )}
      <SettingsGroup>
        <SettingsRow
          label="Daintree's catalog"
          description="Reviewed by Daintree for each plugin's source and bytes. Always listed"
        />
        {(sources ?? []).map((sourceUrl) => (
          <SettingsRow
            key={sourceUrl}
            label={<span className="break-all">{describeCatalogSource(sourceUrl)}</span>}
            description={<span className="break-all select-text">{sourceUrl}</span>}
            rootAttributes={{ "data-testid": "plugin-catalog-source" }}
            control={({ disabled }) => (
              <Button
                type="button"
                variant="ghost-danger"
                size="icon-sm"
                disabled={disabled || busy}
                aria-label={`Remove ${describeCatalogSource(sourceUrl)}`}
                onClick={() => remove(sourceUrl)}
              >
                <Trash2 />
              </Button>
            )}
          />
        ))}
        <SettingsRow
          label="Add a catalog"
          description="The https:// address of a catalog in the same format as Daintree's. Every install from it still shows its preview first"
          layout="stacked"
          error={refusal ? CATALOG_SOURCE_REFUSAL_COPY[refusal] : undefined}
          control={({ labelId, descriptionId, disabled }) => (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                add();
              }}
            >
              <Input
                ref={inputRef}
                type="url"
                inputMode="url"
                spellCheck={false}
                autoComplete="off"
                placeholder="https://example.com/plugins/catalog.json"
                value={draft}
                onChange={(event) => {
                  changeDraft(event.target.value);
                  setRefusal(null);
                  // A failed add's Retry would send the address as it was.
                  if (failedSave?.kind === "add") setFailedSave(null);
                }}
                disabled={disabled || sources === null}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                aria-invalid={refusal !== null}
                className="min-w-0 flex-1"
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={disabled || busy || sources === null || draft.trim().length === 0}
                loading={busy}
              >
                Add catalog
              </Button>
            </form>
          )}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
