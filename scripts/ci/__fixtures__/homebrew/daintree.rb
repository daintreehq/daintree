cask "daintree" do
  arch arm: "arm64", intel: "x64"

  version "1.2.3"
  sha256 arm:   "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
         intel: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  url "https://updates.daintree.org/releases/Daintree-#{version}-#{arch}.dmg"
  name "Daintree"
  desc "IDE for orchestrating AI coding agents across git worktrees"
  homepage "https://daintree.org/"

  livecheck do
    url "https://updates.daintree.org/releases/latest-mac.yml"
    strategy :electron_builder
  end

  auto_updates true
  depends_on macos: :ventura

  app "Daintree.app"

  zap launchctl: "org.daintree.app.host",
      trash:     [
        "~/.daintree",
        "~/Library/Application Support/Daintree",
        "~/Library/Caches/daintree-updater",
        "~/Library/Caches/org.daintree.app",
        "~/Library/Caches/org.daintree.app.helper",
        "~/Library/Caches/org.daintree.app.ShipIt",
        "~/Library/HTTPStorages/org.daintree.app",
        "~/Library/HTTPStorages/org.daintree.app.helper",
        "~/Library/LaunchAgents/org.daintree.app.host.plist",
        "~/Library/LaunchAgents/org.daintree.app.schedules.*.plist",
        "~/Library/Logs/Daintree",
        "~/Library/Preferences/org.daintree.app.plist",
        "~/Library/Saved Application State/org.daintree.app.savedState",
        "~/Library/Services/Open in Daintree.workflow",
      ]
end
