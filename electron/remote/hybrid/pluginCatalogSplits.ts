import type { HybridSplit } from "../../ipc/endpoint.js";
import type {
  PluginInstallErrorCode,
  PluginUrlInstallPreviewResult,
} from "../../../shared/types/plugin.js";
import { describeCatalogSource } from "../../../shared/utils/pluginInstallSource.js";

/**
 * Browse and catalog installs run on the host, but which catalogs the person
 * trusts is this machine's setting (#17434). These splits carry it: Browse
 * sends this machine's list along, and a preview or install that names an
 * added catalog is checked against it here, before the host fetches anything.
 * The host trusts what arrives over the link for the same reason it trusts a
 * remote window's other calls: this machine's main process sent it.
 *
 * Lazy throughout, so no catalog code loads until a remote window's Browse asks.
 */

type SplitCall = Parameters<HybridSplit>[0];

function loadSources() {
  return import("../../services/plugin/pluginCatalogSources.js");
}

function loadSourceUrl() {
  return import("../../services/plugin/pluginCatalogSourceUrl.js");
}

/** A refusal in the shape both a preview and an install answer with. */
function refusal(code: PluginInstallErrorCode, message: string): PluginUrlInstallPreviewResult {
  return { status: "failed", errors: [{ code, message }] };
}

function unknownCatalog(sourceUrl: string): PluginUrlInstallPreviewResult {
  return refusal(
    "catalog_source_unknown",
    `${describeCatalogSource(sourceUrl)} isn't one of your plugin catalogs, so nothing was installed. Add it in Settings > Plugins if you trust whoever curates it, then try again.`
  );
}

/**
 * The added catalog a request names, canonical, once this machine has checked
 * it is one the person added: `"forward"` when there is nothing to check here
 * (Daintree's own catalog), the refusal when it isn't on the list or isn't a
 * catalog URL at all. A malformed name is refused here, not left to the host:
 * an older host ignores the name and would answer from Daintree's catalog.
 */
async function checkNamedCatalog(
  request: unknown
): Promise<{ sourceUrl: string } | "forward" | PluginUrlInstallPreviewResult> {
  const raw = (request as { sourceUrl?: unknown } | null | undefined)?.sourceUrl;
  if (raw === undefined) return "forward";
  const { catalogSourceOf } = await loadSourceUrl();
  const sourceUrl = catalogSourceOf(raw);
  if (sourceUrl === null) {
    return refusal(
      "catalog_not_listed",
      "The install names a catalog address Daintree can't read, so nothing was installed."
    );
  }
  if (sourceUrl === undefined) return "forward";
  const { isAddedPluginCatalogSource } = await loadSources();
  return isAddedPluginCatalogSource(sourceUrl) ? { sourceUrl } : unknownCatalog(sourceUrl);
}

function withSource(call: SplitCall, sourceUrl: string): unknown[] {
  const [request, ...rest] = call.args;
  return [{ ...(request as object), sourceUrl }, ...rest];
}

export const pluginBrowseCatalog: HybridSplit = async ({ remote }) => {
  const { getPluginCatalogSources } = await loadSources();
  return remote(undefined, [{ sourceUrls: getPluginCatalogSources() }]);
};

export const pluginPreviewFromCatalog: HybridSplit = async (call) => {
  const checked = await checkNamedCatalog(call.args[0]);
  if (checked === "forward") return call.remote();
  if (!("sourceUrl" in checked)) return checked;
  const answer = (await call.remote(
    undefined,
    withSource(call, checked.sourceUrl)
  )) as PluginUrlInstallPreviewResult;
  // An older host reads the request as one for Daintree's own catalog and
  // answers with that catalog's release. Its preview names no catalog, so it is
  // refused here, before anyone can confirm an install the person didn't ask for.
  if (answer?.status === "preview" && answer.preview.catalog?.sourceUrl !== checked.sourceUrl) {
    return refusal(
      "catalog_unavailable",
      "This host's Daintree can't install from added catalogs yet, so nothing was installed. Update Daintree on the host, then try again."
    );
  }
  return answer;
};

export const pluginInstallFromCatalog: HybridSplit = async (call) => {
  // An update names the catalog its installed copy came from, which the host
  // holds it to; that catalog needn't still be on this machine's list. It is
  // still refused here when it names no catalog at all, which an older host
  // would read as Daintree's.
  const request = call.args[0] as { intent?: unknown; sourceUrl?: unknown } | null | undefined;
  if (request?.intent === "update") {
    if (request.sourceUrl === undefined) return call.remote();
    const { catalogSourceOf } = await loadSourceUrl();
    if (catalogSourceOf(request.sourceUrl) === null) {
      return refusal(
        "catalog_not_listed",
        "The update names a catalog address Daintree can't read, so nothing was installed."
      );
    }
    return call.remote();
  }
  const checked = await checkNamedCatalog(call.args[0]);
  if (checked === "forward") return call.remote();
  if (!("sourceUrl" in checked)) return checked;
  return call.remote(undefined, withSource(call, checked.sourceUrl));
};
