import { Shield } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";

interface TelemetryConsentStepProps {
  isOpen: boolean;
  onDismiss: (enabled: boolean) => void;
}

export function TelemetryConsentStep({ isOpen, onDismiss }: TelemetryConsentStepProps) {
  return (
    <AppDialog isOpen={isOpen} onClose={() => void onDismiss(false)} size="sm" dismissible>
      <AppDialog.Header>
        <AppDialog.Title icon={<Shield className="w-5 h-5 text-canopy-accent" />}>
          Help improve Canopy
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        <p className="text-sm text-canopy-text/70">
          Send anonymous crash reports when something goes wrong. No file contents, credentials, or
          personal data are ever collected.
        </p>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="outline" onClick={() => void onDismiss(false)} className="flex-1">
          Disable
        </Button>
        <Button onClick={() => void onDismiss(true)} className="flex-1">
          Enable
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
