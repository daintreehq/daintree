# ASAR integrity

Electron supports embedded ASAR integrity validation on macOS (since Electron 16) and Windows (since Electron 30). Daintree enables this via the `enableEmbeddedAsarIntegrityValidation` fuse in `electron-builder.config.cjs`.

## Platform coverage

| Platform | ASAR integrity | Notes |
| --- | --- | --- |
| macOS | Supported | `enableEmbeddedAsarIntegrityValidation` + `ElectronAsarIntegrity` in `Info.plist` |
| Windows | Supported | `enableEmbeddedAsarIntegrityValidation` + `ElectronAsarIntegrity` resource |
| Linux | Not supported | Electron has no ASAR integrity validation on Linux — the platform lacks the required OS-level code-signing infrastructure that macOS and Windows integrity checks chain into. AppImage's outer squashfs hash is the only tamper signal on Linux distributions. This is a known framework limitation, not a bug. |
