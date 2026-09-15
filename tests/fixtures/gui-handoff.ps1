param([string]$Origin)
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot '../../installer/windows/KubusNodeSetup.ps1'
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Launcher parse failed' }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-DashboardHandoff' }, $false)
if (-not $definition) { throw 'Handoff function missing' }
. ([scriptblock]::Create($definition.Extent.Text))
$nodeOrigin = $Origin
# Only an isolated test credential; never read the real Node configuration.
Get-DashboardHandoff 'NODE_GUI_TOKEN="test-windows-gui-credential"'
