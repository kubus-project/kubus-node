; The EXE installs the already verified canonical runtime bundle unchanged.
; Node identity, captures and archive live in Docker volumes, never {app}.
#ifndef BundleDir
  #error BundleDir is required
#endif
#ifndef ReleaseVersion
  #error ReleaseVersion is required
#endif

[Setup]
AppId={{B89A30A4-DC77-48F6-95AF-FBF8D2C48A84}
AppName=kubus Node
AppVersion={#ReleaseVersion}
AppPublisher=kubus
AppPublisherURL=https://app.kubus.site
DefaultDirName={localappdata}\Programs\kubus-node
DefaultGroupName=kubus Node
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=KubusNodeSetup-{#ReleaseVersion}-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=no
UninstallDisplayName=kubus Node
#ifdef SignRelease
SignTool=kubus $f
SignedUninstaller=yes
#endif

[Files]
Source: "{#BundleDir}\Start-KubusNodeSetup.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BundleDir}\KubusNodeSetup.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BundleDir}\docker-compose.release.yml"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BundleDir}\version.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BundleDir}\release-manifest.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BundleDir}\release-metadata.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BundleDir}\README-FIRST.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BundleDir}\SHA256SUMS"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Opens the browser-first setup page. On an already configured Node the same
; launcher hands off to the dashboard instead, so one icon is always correct.
Name: "{group}\kubus Node"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File ""{app}\KubusNodeSetup.ps1"""; WorkingDir: "{app}"
; Stopping the Node and the explicit delete-data path stay separate from setup,
; so neither can be reached by accident while setting up.
Name: "{group}\Manage kubus Node"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File ""{app}\KubusNodeSetup.ps1"" -Manage"; WorkingDir: "{app}"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File ""{app}\KubusNodeSetup.ps1"""; Description: "Set up kubus Node"; Flags: postinstall nowait skipifsilent

; No data deletion entries: normal uninstall only removes installed files.
; The launcher's separate, explicitly confirmed delete option removes volumes.
