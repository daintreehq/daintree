; Custom NSIS include for the per-user `.dntr` (Daintree plugin archive) file
; association. electron-builder's built-in `fileAssociations` writes to HKLM and
; requires `perMachine: true`, which would force UAC elevation on install and on
; every auto-update. Daintree ships a per-user (HKCU) installer, so the
; association is registered by hand here under HKCU\Software\Classes instead.
;
; Double-clicking a `.dntr` file then launches Daintree with the file path as a
; bare argv entry, which app's `second-instance` handler validates and sideloads
; (see electron/lifecycle/appLifecycle.ts).
;
; It also puts the `daintree` command on PATH (#17931): $INSTDIR\bin holds only
; daintree.cmd, which scripts/afterPack.cjs renders from build/win/daintree.cmd.in.

!define DAINTREE_MACHINE_ENV_KEY "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"

; Adds (ADD 1) or removes (ADD 0) $INSTDIR\bin in the Path of the scope this copy
; was installed for: HKCU for a per-user install, the machine environment for an
; all-users one. Entries compare whole and case-insensitively, ignoring
; surrounding quotes and trailing backslashes; every other entry, empty ones
; included, is written back exactly as read.
!macro daintreeEditPath ADD
  System::Store "s"
  StrCpy $9 "$INSTDIR\bin"
  StrCpy $6 "" ; the entries that aren't $9
  StrCpy $7 0 ; how many are
  StrCpy $0 0x80000001 ; HKEY_CURRENT_USER
  StrCpy $1 "Environment"
  ${If} $installMode == "all"
    StrCpy $0 0x80000002 ; HKEY_LOCAL_MACHINE
    StrCpy $1 "${DAINTREE_MACHINE_ENV_KEY}"
  ${EndIf}

  !if ${ADD} == 1
    ${IfNot} ${FileExists} "$9\daintree.cmd"
      Goto daintreePathSkip
    ${EndIf}
  !endif

  ; Type and size first, without the data (RRF_RT_ANY | RRF_NOEXPAND).
  ; ReadRegStr returns "" both for a missing value and for one longer than its
  ; buffer, and a PATH rebuilt from that "" would wipe the user's.
  System::Call 'advapi32::RegGetValueW(p r0, w r1, w "Path", i 0x1000FFFF, *i .r2, p 0, *i .r3) i .r4'
  ${If} $4 = 2 ; ERROR_FILE_NOT_FOUND: no Path value yet
    !if ${ADD} == 1
      StrCpy $2 2 ; REG_EXPAND_SZ, as Windows creates it
      StrCpy $5 ""
      Goto daintreePathScanned
    !else
      Goto daintreePathDone
    !endif
  ${ElseIf} $4 <> 0
    Goto daintreePathSkip
  ${EndIf}
  ${If} $2 <> 1 ; REG_SZ
  ${AndIf} $2 <> 2 ; REG_EXPAND_SZ
    Goto daintreePathSkip
  ${EndIf}
  ; The value (and, when adding, a separator and $9) must fit NSIS's string
  ; buffer, or the string operations below would truncate what gets written.
  IntOp $R8 $3 / 2
  !if ${ADD} == 1
    StrLen $R9 $9
    IntOp $R8 $R8 + $R9
    IntOp $R8 $R8 + 1
  !endif
  ${If} $R8 >= ${NSIS_MAX_STRLEN}
    Goto daintreePathSkip
  ${EndIf}

  ClearErrors
  ${If} $installMode == "all"
    ReadRegStr $5 HKLM "${DAINTREE_MACHINE_ENV_KEY}" "Path"
  ${Else}
    ReadRegStr $5 HKCU "Environment" "Path"
  ${EndIf}
  ${If} ${Errors}
    Goto daintreePathSkip
  ${EndIf}
  ; Another installer could have rewritten Path between the two reads; the
  ; write below reuses the first read's type, so it must still be the type.
  System::Call 'advapi32::RegGetValueW(p r0, w r1, w "Path", i 0x1000FFFF, *i .R8, p 0, *i .R9) i .r4'
  ${If} $4 <> 0
  ${OrIf} $R8 <> $2
    Goto daintreePathSkip
  ${EndIf}

  ; Split on semicolons outside double quotes.
  StrCpy $8 0 ; scan index
  StrCpy $R0 0 ; start of the current entry
  StrCpy $R1 0 ; inside quotes
  StrCpy $R2 0 ; entries kept
  StrCmp $5 "" daintreePathScanned
daintreePathScan:
  StrCpy $R4 $5 1 $8
  StrCmp $R4 "" daintreePathEntry
  StrCmp $R4 "$\"" 0 +3
    IntOp $R1 $R1 ^ 1
    Goto daintreePathNext
  StrCmp $R4 ";" 0 daintreePathNext
  IntCmp $R1 0 daintreePathEntry daintreePathNext daintreePathNext
daintreePathEntry:
  IntOp $R5 $8 - $R0
  StrCpy $R6 $5 $R5 $R0
  StrCpy $R7 $R6
  StrCpy $R8 $R7 1
  StrCmp $R8 "$\"" 0 daintreePathTrim
  StrCpy $R8 $R7 1 -1
  StrCmp $R8 "$\"" 0 daintreePathTrim
  StrCpy $R7 $R7 "" 1
  StrCpy $R7 $R7 -1
daintreePathTrim:
  StrCpy $R8 $R7 1 -1
  StrCmp $R8 "\" 0 daintreePathCompare
  StrCpy $R7 $R7 -1
  Goto daintreePathTrim
daintreePathCompare:
  StrCmp $R7 $9 0 daintreePathKeep
  IntOp $7 $7 + 1
  Goto daintreePathKept
daintreePathKeep:
  ${If} $R2 = 0
    StrCpy $6 $R6
  ${Else}
    StrCpy $6 "$6;$R6"
  ${EndIf}
  IntOp $R2 $R2 + 1
daintreePathKept:
  StrCmp $R4 "" daintreePathScanned
  IntOp $R0 $8 + 1
daintreePathNext:
  IntOp $8 $8 + 1
  Goto daintreePathScan
daintreePathScanned:

  !if ${ADD} == 1
    ${If} $7 > 0
      Goto daintreePathDone
    ${EndIf}
    ; An entry can't carry a bare semicolon, and in a REG_EXPAND_SZ value a
    ; percent sign in the install directory could expand on load.
    StrCpy $R8 0
    ${Do}
      StrCpy $R4 $9 1 $R8
      ${If} $R4 == ""
        ${ExitDo}
      ${ElseIf} $R4 == ";"
        Goto daintreePathSkip
      ${ElseIf} $R4 == "%"
      ${AndIf} $2 = 2
        Goto daintreePathSkip
      ${EndIf}
      IntOp $R8 $R8 + 1
    ${Loop}
    ; Always a new separator, even after a trailing one: the empty entry
    ; that trailing ";" stood for is then still there after an uninstall.
    ${If} $5 == ""
      StrCpy $6 $9
    ${Else}
      StrCpy $6 "$5;$9"
    ${EndIf}
  !else
    ${If} $7 = 0
      Goto daintreePathDone
    ${EndIf}
  !endif

  ; Written back with the type it was read with, so a REG_SZ PATH keeps its
  ; literal % signs and a REG_EXPAND_SZ one keeps expanding.
  StrLen $R8 $6
  IntOp $R8 $R8 + 1
  IntOp $R8 $R8 * 2
  System::Call 'advapi32::RegSetKeyValueW(p r0, w r1, w "Path", i r2, w r6, i R8) i .r4'
  ${If} $4 <> 0
    Goto daintreePathSkip
  ${EndIf}
  ; Explorer rereads the environment on this, so terminals it starts afterwards
  ; see the change. SMTO_ABORTIFHUNG: a hung window can't stall the installer.
  System::Call 'user32::SendMessageTimeoutW(p 0xffff, i 0x1A, p 0, w "Environment", i 0x2, i 5000, *p .r4)'
  Goto daintreePathDone
daintreePathSkip:
  DetailPrint "PATH was left unchanged: it could not be updated safely for $9"
daintreePathDone:
  System::Store "l"
!macroend

; Inserted by electron-builder after its own includes, where $installMode
; exists. The removal waits for a successful uninstall, an update's included:
; the uninstall section can still restore the old files and abort, and an update
; that moved the install directory must not leave the old bin on PATH. The new
; install's customInstall adds its own entry back.
!macro customHeader
  !ifdef BUILD_UNINSTALLER
    Function un.onUninstSuccess
      !insertmacro daintreeEditPath 0
    FunctionEnd
  !else
    Function daintreeAddCliToPath
      !insertmacro daintreeEditPath 1
    FunctionEnd
  !endif
!macroend

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
  ;
  ; The folder is joined to the switch (`--cli-path=<path>`) rather than passed
  ; as a following token. A warm launch does not see this command line as-is:
  ; Electron's `second-instance` reports Chromium's reconstruction, which groups
  ; switches ahead of positionals, so with the two-token form an injected
  ; Chromium switch can land in the operand slot and be read as the folder
  ; (#11410). A joined switch cannot be split apart that way.
  WriteRegStr HKCU "Software\Classes\Directory\shell\Daintree" "" "Open in Daintree"
  ; Icon path is quoted so an install directory containing a comma isn't parsed
  ; as the icon-index separator.
  WriteRegStr HKCU "Software\Classes\Directory\shell\Daintree" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\Daintree\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --cli-path="%1"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Daintree" "" "Open in Daintree"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Daintree" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  ; The trailing `\.` is a drive-root guard, not a typo. At a drive root %V
  ; expands to `D:\`, and CommandLineToArgvW treats an odd run of backslashes
  ; immediately before a quote as escaping it — `--cli-path="D:\"` never closes
  ; and swallows the rest of the command line. `\.` keeps a non-backslash
  ; character against the closing quote and normalizes away: `D:\\.` -> `D:\`,
  ; `C:\src\.` -> `C:\src`. (Appending a bare `.` the way Git for Windows does
  ; would name the sibling `C:\src.` on every non-root folder.) %1 needs no
  ; guard: a selected item is never a drive root — drives are `Drive\shell`.
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Daintree\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --cli-path="%V\."'

  Call daintreeAddCliToPath

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

  ; The app claims `daintree://` itself at launch (app.setAsDefaultProtocolClient),
  ; so nothing above wrote it and it outlived an uninstall, leaving links that
  ; fail to launch a deleted exe. Drop it only while it still launches this
  ; install, and not during an update: the new build re-registers on launch.
  ${ifNot} ${isUpdated}
    ReadRegStr $0 HKCU "Software\Classes\daintree\shell\open\command" ""
    StrCmp $0 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"' 0 +2
      DeleteRegKey HKCU "Software\Classes\daintree"
  ${endIf}

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
