Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$composeFile = Join-Path $releaseRoot 'docker-compose.yml'

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

function Start-Node {
  Test-Docker
  if (-not (Test-Path -LiteralPath $composeFile)) { throw 'This release bundle is incomplete: docker-compose.yml is missing.' }
  $dataRoot = Join-Path $env:LOCALAPPDATA 'kubus-node'
  New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
  $freeBytes = (Get-PSDrive -Name ([IO.Path]::GetPathRoot($dataRoot).TrimEnd(':','\'))).Free
  if ($freeBytes -lt 10GB) { throw 'At least 10 GB of free disk space is required before starting kubus Node.' }
  & docker compose -p kubus-node -f $composeFile up -d --build
  if ($LASTEXITCODE -ne 0) { throw 'Docker could not start kubus Node. Open Docker Desktop, check its resources, then retry.' }
  Start-Process 'http://127.0.0.1:8787/setup'
}

function Stop-Node([bool]$removeData) {
  Test-Docker
  & docker compose -p kubus-node -f $composeFile down
  if ($LASTEXITCODE -ne 0) { throw 'Docker could not stop kubus Node.' }
  if ($removeData) {
    $answer = [System.Windows.Forms.MessageBox]::Show(
      'Delete the kubus Node Docker volumes? This permanently removes Node identity, pairing credentials, archive data, and private captures.',
      'Delete Node data', 'YesNo', 'Warning')
    if ($answer -eq 'Yes') { & docker volume rm kubus-node_node-state kubus-node_kubo-data | Out-Null }
  }
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
  try { Stop-Node $false; $status.Text = 'Node stopped. Its data and identity were preserved.' }
  catch { Show-Problem $_.Exception.Message }
})
$form.Controls.Add($remove)

$form.Controls.Add((New-Object System.Windows.Forms.Label -Property @{ Text = 'GPU reconstruction is only enabled on supported Linux Docker + NVIDIA/CUDA hosts. Windows uses archive participation and remote processing.'; Location = New-Object System.Drawing.Point(24, 220); Size = New-Object System.Drawing.Size(480, 38); AutoSize = $false }))

try { Test-Docker; $status.Text = 'Docker Desktop is ready.' } catch { $status.Text = 'Docker Desktop needs attention.' }
[void]$form.ShowDialog()
