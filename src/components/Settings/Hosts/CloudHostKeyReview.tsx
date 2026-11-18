import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { InlineError } from "@/components/ui/field";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { cloudProviderFor } from "@/components/Hosts/cloud/cloudHostLabels";
import { cloudStatusFor, useCloudHosts } from "@/components/Hosts/cloud/cloudHostsState";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import type { CloudHostKeyReview } from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";

/**
 * A host key the machine presented, for the person to compare and trust:
 * once on a first connect, and again, as a warning, whenever it changes.
 */
export function HostKeyReviewDetails({
  review,
  providerName,
}: {
  review: CloudHostKeyReview;
  providerName: string;
}) {
  const presented = (
    <span className="select-text break-all font-mono text-2xs">
      {review.keyType} {review.fingerprint}
    </span>
  );
  if (review.reason === "first-connect") {
    return (
      <div className="flex flex-col gap-1.5" data-testid="cloud-host-key-review">
        <span>
          {providerName} can&apos;t vouch for this machine&apos;s host key, so Daintree asks you
          once. To check it, compare it with what{" "}
          <code>ssh-keygen -lf /etc/ssh/ssh_host_{review.keyType.toLowerCase()}_key.pub</code>{" "}
          prints in {providerName}&apos;s console for the machine. Once trusted, Daintree refuses
          any other key.
        </span>
        {presented}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5" data-testid="cloud-host-key-review">
      <Callout severity="warning" title="This machine's identity changed">
        It presents a different host key from the one you trusted
        {review.previousTrustedAt !== null
          ? ` on ${new Date(review.previousTrustedAt).toLocaleDateString()}`
          : ""}
        , so Daintree won&apos;t connect. Trust the new key only if you expect the change, such as
        after the machine was rebuilt.
      </Callout>
      <span className="select-text break-all font-mono text-2xs">
        Trusted {review.previousFingerprint}
      </span>
      <span className="select-text break-all font-mono text-2xs">
        Now {review.keyType} {review.fingerprint}
      </span>
    </div>
  );
}

/**
 * The key a cloud host's machine presented, offered right where its setup
 * stopped for it; `note` instead when there's no key waiting.
 */
export function CloudSetupHostKey({
  hostId,
  onTrusted,
  note = null,
}: {
  hostId: HostId;
  /** The key is trusted: setup can look again. */
  onTrusted: () => void;
  note?: ReactNode;
}) {
  const { snapshot } = useCloudHosts();
  const status = cloudStatusFor(snapshot, hostId);
  const provider = cloudProviderFor(snapshot.providers, status);
  const [trusting, setTrusting] = useState(false);
  const [error, setError] = useState<{ fingerprint: string; message: string } | null>(null);
  const review = status?.hostKeyReview ?? null;
  if (!review) return note;

  // Names the fingerprint shown, so a key that changed again since is refused.
  const trust = () => {
    setTrusting(true);
    setError(null);
    cloudHostsClient.trustHostKey(hostId, review.fingerprint).then(
      () => {
        setTrusting(false);
        onTrusted();
      },
      (err: unknown) => {
        setTrusting(false);
        setError({
          fingerprint: review.fingerprint,
          message:
            isClientAppError(err) && err.userMessage
              ? err.userMessage
              : clientErrorText(err, "Couldn't trust the host key"),
        });
      }
    );
  };

  return (
    <div className="mt-3 flex flex-col gap-2 text-xs text-text-secondary">
      <HostKeyReviewDetails
        review={review}
        providerName={provider?.name ?? status?.providerId ?? "The provider"}
      />
      <div>
        <Button variant="outline" size="sm" loading={trusting} onClick={trust}>
          {review.reason === "changed" ? "Trust new key" : "Trust this key"}
        </Button>
      </div>
      {error?.fingerprint === review.fingerprint && (
        <InlineError role="alert">{error.message}</InlineError>
      )}
    </div>
  );
}
