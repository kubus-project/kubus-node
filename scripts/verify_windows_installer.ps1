param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$BundleDir,
  [Parameter(Mandatory=$true)][string]$NpmRuntimeDir
)
$ErrorActionPreference = 'Stop'
$registration = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B89A30A4-DC77-48F6-95AF-FBF8D2C48A84}_is1'
if (Test-Path -LiteralPath $registration) { throw 'Existing kubus Node installation found; use an isolated acceptance machine.' }
$artifact = (Resolve-Path -LiteralPath $Installer).Path
$bundle = (Resolve-Path -LiteralPath $BundleDir).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('kubus-exe-acceptance-' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $testRoot 'installed'
New-Item -ItemType Directory -Path $testRoot | Out-Null
$acceptedHash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
function Install-Candidate {
  $process = Start-Process -FilePath $artifact -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/DIR=`"$installDir`"") -WindowStyle Hidden -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw 'EXE install failed' }
  & node (Join-Path $PSScriptRoot 'verify_artifact_parity.mjs') $bundle $NpmRuntimeDir $installDir
  if ($LASTEXITCODE -ne 0) { throw 'Installed artifact parity failed' }
  foreach ($line in (Get-Content -LiteralPath (Join-Path $bundle 'SHA256SUMS'))) {
    if ($line -notmatch '^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$') { throw 'Unexpected bundle checksum entry' }
    $expectedHash = $Matches[1]
    $installedFile = Join-Path $installDir $Matches[2]
    if ((Get-FileHash -LiteralPath $installedFile -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Installed file differs from tested bundle' }
  }
}
function Uninstall-Candidate {
  $uninstaller = Join-Path $installDir 'unins000.exe'
  $process = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -WindowStyle Hidden -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw 'EXE uninstall failed' }
  if (Test-Path -LiteralPath (Join-Path $installDir 'release-manifest.json')) { throw 'Uninstall left the installed runtime bundle' }
}
try {
  Install-Candidate
  Uninstall-Candidate
  Install-Candidate
  Uninstall-Candidate
  if ((Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash -ne $acceptedHash) { throw 'Installer bytes changed during acceptance' }
  Write-Output "EXE file installation, uninstall, reinstall and payload parity passed: $acceptedHash"
  Write-Output 'Runtime start, Docker volume preservation, previous-version upgrade and reconstruction require separate acceptance.'
} finally {
  # Retain the isolated test directory on failure for diagnosis. Never invoke
  # the runtime/data deletion UI from an automated installer file test.
  Write-Output "Installer test directory: $testRoot"
}
