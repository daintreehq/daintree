# ASAR integrity

Electron supports embedded ASAR integrity validation on macOS (since Electron 16) and Windows (since Electron 30). Daintree enables this via the `enableEmbeddedAsarIntegrityValidation` fuse in `electron-builder.config.cjs`.

## Platform coverage

| Platform | ASAR integrity | Notes |
| --- | --- | --- |
| macOS | Supported | `enableEmbeddedAsarIntegrityValidation` + `ElectronAsarIntegrity` in `Info.plist` |
| Windows | Supported | `enableEmbeddedAsarIntegrityValidation` + `ElectronAsarIntegrity` resource |
| Linux | Not supported | Electron has no ASAR integrity validation on Linux — the platform lacks the required OS-level code-signing infrastructure that macOS and Windows integrity checks chain into. AppImage's outer squashfs hash is the only tamper signal on Linux distributions. This is a known framework limitation, not a bug. |

## Why it can break

The fuse validates a hash of `app.asar` recorded at package time against what is on disk at launch, so **anything that rewrites the ASAR after packaging invalidates it**. Two consequences worth knowing before you debug a launch failure:

- A post-package step that patches files inside `app.asar` is not a supported fix-up; repackage instead.
- The Microsoft Store re-signs the outer MSIX without touching `app.asar`, so a Store build should keep validating. If a Store-certified build ever fails at runtime, `electronFuses` in `electron-builder.config.cjs` accepts a per-platform override — turn the fuse off for that build only, and record why. See [microsoft-store.md](./microsoft-store.md#troubleshooting).

## Related

- [microsoft-store.md](./microsoft-store.md) — the Windows Store packaging path this fuse rides through.
- [../release.md](../release.md) — signing, notarization, and the per-OS release workflows.
