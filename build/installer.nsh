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

  ; Tell the shell the association table changed so Explorer picks it up now.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Daintree.Plugin"
  ; Only drop the extension mapping if it still points at our ProgID, so a
  ; different handler that claimed `.dntr` since install is left untouched.
  ReadRegStr $0 HKCU "Software\Classes\.dntr" ""
  StrCmp $0 "Daintree.Plugin" 0 +2
    DeleteRegKey HKCU "Software\Classes\.dntr"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
