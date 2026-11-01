import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsEmptyRow, SettingsGroup } from "@/components/Settings/SettingsGroup";

/**
 * Devices: the phones that answer. Pairing with a QR code and the device list
 * land here (#16009), then revoking (#16010) and enrolled hosts (#16021).
 * Until pairing exists the empty row says what the list holds rather than
 * asking for a step nothing on the page can take.
 */
export function DecisionsDevicesSection() {
  return (
    <SettingsSection title="Devices" id="decisions-devices">
      <SettingsGroup>
        <SettingsEmptyRow>Phones you pair with this computer appear here</SettingsEmptyRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
