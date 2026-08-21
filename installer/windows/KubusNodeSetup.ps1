param([switch]$FinalizeSetup)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$composeFile = Join-Path $releaseRoot 'docker-compose.release.yml'
$dataRoot = Join-Path $env:LOCALAPPDATA 'kubus-node'
$runtimeEnv = Join-Path $dataRoot 'runtime.env'

function Show-Problem([string]$message) {
  [System.Windows.Forms.MessageBox]::Show($message, 'kubus Node Setup', 'OK', 'Error') | Out-Null
}

function Test-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker Desktop is required. Install Docker Desktop, enable its WSL 2 backend, then run this launcher again.'
  }
  & docker info --format '{{.ServerVersion}}' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'Docker Desktop is installed but its daemon is not running. Start Docker Desktop and run this launcher again.'
  }
}

function Write-RuntimeTopology([bool]$allowLan) {
  New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
  $bindAddress = '127.0.0.1'
  $lanUrl = ''
  if ($allowLan) {
    $address = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
      Select-Object -First 1 -ExpandProperty IPAddress
    if (-not $address) { throw 'LAN access was selected, but no private IPv4 address was found. Connect this PC to the intended network and start setup again.' }
    $bindAddress = '0.0.0.0'
    $lanUrl = "http://${address}:8787"
  }
  @("NODE_BIND_ADDRESS=$bindAddress", "NODE_LAN_URL=$lanUrl") | Set-Content -LiteralPath $runtimeEnv -Encoding ascii
}

function Invoke-NodeCompose([string[]]$arguments) {
  & docker compose -p kubus-node --env-file $runtimeEnv -f $composeFile @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Docker could not complete the kubus Node operation. Open Docker Desktop, check its resources, then retry.' }
}

function Read-SetupConfig {
  $config = & docker compose -p kubus-node --env-file $runtimeEnv -f $composeFile exec -T kubus-node-agent sh -lc 'test -s /var/lib/kubus-node/config.env && cat /var/lib/kubus-node/config.env' 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($config -join "`n")
}

function Wait-NodeReady {
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $status = & docker compose -p kubus-node --env-file $runtimeEnv -f $composeFile ps --format json 2>$null
    if ($LASTEXITCODE -eq 0 -and $status -match 'healthy') { return }
    Start-Sleep -Seconds 3
  }
  throw 'kubus Node did not become ready in time. Docker Desktop can show the runtime logs; your identity and configuration remain preserved.'
}

function Complete-SetupTransition {
  Test-Docker
  for ($attempt = 0; $attempt -lt 600; $attempt++) {
    $config = Read-SetupConfig
    if ($config -match '(?m)^LOCAL_API_ALLOW_LAN=(?:"true"|true)$') {
      Write-RuntimeTopology $true
      Invoke-NodeCompose @('up', '-d', '--force-recreate')
      Wait-NodeReady
      return
    }
    if ($config -match '(?m)^LOCAL_API_ALLOW_LAN=(?:"false"|false)$') {
      Write-RuntimeTopology $false
      Invoke-NodeCompose @('up', '-d', '--force-recreate')
      Wait-NodeReady
      return
    }
    Start-Sleep -Seconds 3
  }
}

function Start-Node {
  Test-Docker
  if (-not (Test-Path -LiteralPath $composeFile)) { throw 'This release bundle is incomplete: docker-compose.release.yml is missing.' }
  Write-RuntimeTopology $false
  $freeBytes = (Get-PSDrive -Name ([IO.Path]::GetPathRoot($dataRoot).TrimEnd(':','\'))).Free
  if ($freeBytes -lt 10GB) { throw 'At least 10 GB of free disk space is required before starting kubus Node.' }
  Invoke-NodeCompose @('pull')
  Invoke-NodeCompose @('up', '-d')
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', $PSCommandPath, '-FinalizeSetup')
  Start-Process 'http://127.0.0.1:8787/setup'
}

function Stop-Node([bool]$removeData) {
  Test-Docker
  if (-not (Test-Path -LiteralPath $runtimeEnv)) { Write-RuntimeTopology $false }
  Invoke-NodeCompose @('down')
  $deleted = $false
  if ($removeData) {
    $answer = [System.Windows.Forms.MessageBox]::Show(
      'Delete the kubus Node Docker volumes? This permanently removes Node identity, pairing credentials, archive data, and private captures.',
      'Delete Node data', 'YesNo', 'Warning')
    if ($answer -eq 'Yes') {
      & docker volume rm kubus-node_node-state kubus-node_kubo-data | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Docker stopped the Node, but could not remove its data volumes.' }
      $deleted = $true
    }
  }
  return $deleted
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'kubus Node Setup'
$form.Size = New-Object System.Drawing.Size(540, 310)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$intro = New-Object System.Windows.Forms.Label
$intro.Text = 'Install and start kubus Node without a terminal. The first browser page configures your Node identity, archive capacity, and optional LAN access. Docker volumes preserve your data by default.'
$intro.Location = New-Object System.Drawing.Point(24, 22)
$intro.Size = New-Object System.Drawing.Size(480, 68)
$intro.AutoSize = $false
$form.Controls.Add($intro)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Checking Docker Desktop…'
$status.Location = New-Object System.Drawing.Point(24, 105)
$status.Size = New-Object System.Drawing.Size(480, 24)
$form.Controls.Add($status)

$start = New-Object System.Windows.Forms.Button
$start.Text = 'Start setup'
$start.Location = New-Object System.Drawing.Point(24, 155)
$start.Size = New-Object System.Drawing.Size(150, 36)
$start.Add_Click({
  try { $start.Enabled = $false; $status.Text = 'Starting kubus Node…'; Start-Node; $status.Text = 'Node started. Your browser is opening the setup page.' }
  catch { $status.Text = 'Setup could not start.'; Show-Problem $_.Exception.Message }
  finally { $start.Enabled = $true }
})
$form.Controls.Add($start)

$remove = New-Object System.Windows.Forms.Button
$remove.Text = 'Stop / uninstall'
$remove.Location = New-Object System.Drawing.Point(188, 155)
$remove.Size = New-Object System.Drawing.Size(150, 36)
$remove.Add_Click({
  try {
    $deleted = Stop-Node $deleteData.Checked
    if ($deleted) { $status.Text = 'Node stopped and its Docker volumes were removed.' }
    else { $status.Text = 'Node stopped. Its data and identity were preserved.' }
  }
  catch { Show-Problem $_.Exception.Message }
})
$form.Controls.Add($remove)

$deleteData = New-Object System.Windows.Forms.CheckBox
$deleteData.Text = 'Also permanently delete Node data and identity'
$deleteData.Location = New-Object System.Drawing.Point(24, 202)
$deleteData.Size = New-Object System.Drawing.Size(360, 24)
$deleteData.Checked = $false
$form.Controls.Add($deleteData)

$form.Controls.Add((New-Object System.Windows.Forms.Label -Property @{ Text = 'GPU reconstruction is only enabled on supported Linux Docker + NVIDIA/CUDA hosts. Windows uses archive participation and remote processing.'; Location = New-Object System.Drawing.Point(24, 236); Size = New-Object System.Drawing.Size(480, 38); AutoSize = $false }))

if ($FinalizeSetup) { Complete-SetupTransition; exit }
try { Test-Docker; $status.Text = 'Docker Desktop is ready.' } catch { $status.Text = 'Docker Desktop needs attention.' }
[void]$form.ShowDialog()
