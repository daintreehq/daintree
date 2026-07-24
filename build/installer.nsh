; Custom NSIS include for the per-user `.dntr` (Daintree plugin archive) file
; association. electron-builder's built-in `fileAssociations` writes to HKLM and
; requires `perMachine: true`, which would force UAC elevation on install and on
; every auto-update. Daintree ships a per-user (HKCU) installer, so the
; association is registered by hand here under HKCU\Software\Classes instead.
;
; Double-clicking a `.dntr` file then launches Daintree with the file path as a
; bare argv entry, which app's `second-instance` handler validates and sideloads
; (see electron/lifecycle/appLifecycle.ts).

!macro customInstall
  ; ProgID describing the plugin-archive document type.
  WriteRegStr HKCU "Software\Classes\Daintree.Plugin" "" "Daintree Plugin"
  WriteRegStr HKCU "Software\Classes\Daintree.Plugin\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Daintree.Plugin\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; Map the `.dntr` extension to the ProgID.
  WriteRegStr HKCU "Software\Classes\.dntr" "" "Daintree.Plugin"

  ; "Open in Daintree" folder context-menu verbs. `--cli-path` is used rather
  ; than a bare path argument so both branches land on the existing, tested
  ; CLI-path route (cold launch reads it from process.argv, a warm launch gets
  ; it via `second-instance`). `Directory\shell` fires on a selected folder and
  ; receives it as %1; `Directory\Background\shell` fires on empty space inside
  ; a folder, where there is no selection — %V carries the folder being viewed.
  ; Windows 11 files classic verbs like these under "Show more options"; the
  ; modern top-level menu would need an IExplorerCommand DLL plus a sparse
  ; package.
  WriteRegStr HKCU "Software\Classes\Directory\shell\Daintree" "" "Open in Daintree"
  ; Icon path is quoted so an install directory containing a comma isn't parsed
  ; as the icon-index separator.
  WriteRegStr HKCU "Software\Classes\Directory\shell\Daintree" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\Daintree\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --cli-path "%1"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Daintree" "" "Open in Daintree"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Daintree" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Daintree\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --cli-path "%V"'

  ; Tell the shell the association table changed so Explorer picks it up now.
  ; Covers the `.dntr` mapping and both folder verbs in one call.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Daintree.Plugin"
  ; Only drop the extension mapping if it still points at our ProgID, so a
  ; different handler that claimed `.dntr` since install is left untouched.
  ReadRegStr $0 HKCU "Software\Classes\.dntr" ""
  StrCmp $0 "Daintree.Plugin" 0 +2
    DeleteRegKey HKCU "Software\Classes\.dntr"

  ; Drop only our own folder verbs; sibling verbs registered by other apps live
  ; under the same `Directory\shell` parent and must survive.
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Daintree"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Daintree"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
