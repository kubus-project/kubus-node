param(
  [Parameter(Mandatory=$true)][string]$BundleDir,
  [Parameter(Mandatory=$true)][string]$OutputDir,
  [string]$Compiler = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Compiler)) {
  $Compiler = Join-Path $env:LOCALAPPDATA 'Programs/Inno Setup 6/ISCC.exe'
}
$bundle = (Resolve-Path -LiteralPath $BundleDir).Path
$manifest = Get-Content -LiteralPath (Join-Path $bundle 'release-manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid release version' }
& node (Join-Path $PSScriptRoot 'verify_release_package.mjs') --directory $bundle --version $manifest.version
if ($LASTEXITCODE -ne 0) { throw 'Canonical bundle verification failed' }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$output = (Resolve-Path -LiteralPath $OutputDir).Path
$compilerArguments = @('/Qp', "/DBundleDir=$bundle", "/DReleaseVersion=$($manifest.version)", "/O$output")
# Configure a timestamped Authenticode command through the release secret.
# Inno passes only the artifact filename; no certificate/password goes in a URL.
if ($env:KUBUS_AUTHENTICODE_SIGN_COMMAND) {
  $compilerArguments += '/DSignRelease'
  $compilerArguments += "/Skubus=$env:KUBUS_AUTHENTICODE_SIGN_COMMAND"
}
$compilerArguments += (Join-Path $PSScriptRoot '../installer/windows/KubusNode.iss')
& $Compiler @compilerArguments
if ($LASTEXITCODE -ne 0) { throw 'Windows installer compilation failed' }
$artifact = Join-Path $output "KubusNodeSetup-$($manifest.version)-x64.exe"
if ($env:KUBUS_AUTHENTICODE_SIGN_COMMAND) {
  if ((Get-AuthenticodeSignature -LiteralPath $artifact).Status -ne 'Valid') { throw 'Authenticode verification failed' }
} else {
  Write-Warning 'Unsigned candidate: Authenticode signing infrastructure is not configured.'
}
Get-FileHash -LiteralPath $artifact -Algorithm SHA256
