param([int]$Port)
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot '../../installer/windows/KubusNodeSetup.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$null, [ref]$null)
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-StatusServer' }, $false)
. ([scriptblock]::Create($definition.Extent.Text))
$sync = [hashtable]::Synchronized(@{ stopServer=$false; page='test progress'; done=$true; nextUrl='test-only-handoff' })
$server = Start-StatusServer $sync $Port
try {
  for ($attempt=0; $attempt -lt 100 -and -not $sync.listening; $attempt++) { Start-Sleep -Milliseconds 20 }
  if (-not $sync.listening) { throw 'Progress server did not start' }
  Write-Output 'ready'
  [Console]::ReadLine() | Out-Null
} finally {
  $sync.stopServer=$true
  Start-Sleep -Milliseconds 200
  $server.Shell.Dispose()
  $server.Runspace.Dispose()
}
