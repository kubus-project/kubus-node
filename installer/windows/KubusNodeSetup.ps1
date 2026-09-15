param(
  [switch]$FinalizeSetup,
  [switch]$Manage
)

# Setup is browser-first. The launcher never asks a person to read a terminal:
# it opens one local page that reports every step, including the parts that take
# minutes (pulling the runtime images) and the part that used to be invisible
# (the Node restarting into its configured runtime).
#
# The progress page is served by a raw TcpListener rather than HttpListener,
# because this installer runs with PrivilegesRequired=lowest and HttpListener
# needs an administrator URL reservation. Loopback only; GET only; it serves a
# static page and a status document and accepts no mutations.

$ErrorActionPreference = 'Stop'
$releaseRoot = $PSScriptRoot
$composeFile = Join-Path $releaseRoot 'docker-compose.release.yml'
$dataRoot = Join-Path $env:LOCALAPPDATA 'kubus-node'
$runtimeEnv = Join-Path $dataRoot 'runtime.env'
$nodeOrigin = 'http://127.0.0.1:8787'

function Show-Problem([string]$message) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($message, 'kubus Node Setup', 'OK', 'Error') | Out-Null
}

function Test-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker Desktop is required. Install Docker Desktop, enable its WSL 2 backend, then start kubus Node setup again.'
  }
  & docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'Docker Desktop is installed but its engine is not running. Start Docker Desktop, wait until it reports Running, then start kubus Node setup again.'
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
    if (-not $address) { throw 'LAN access was selected, but this PC has no private IPv4 address. Connect it to the intended network and start setup again.' }
    $bindAddress = '0.0.0.0'
    $lanUrl = "http://${address}:8787"
  }
  @("NODE_BIND_ADDRESS=$bindAddress", "NODE_LAN_URL=$lanUrl") | Set-Content -LiteralPath $runtimeEnv -Encoding ascii
}

function Invoke-NodeCompose([string[]]$arguments) {
  # Capturing docker's own words requires redirecting stderr, and PowerShell 5.1
  # turns redirected native stderr into ErrorRecords, which under 'Stop' would
  # abort on ordinary progress output. Same guard as the pull step.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & docker compose -p kubus-node --env-file $runtimeEnv -f $composeFile @arguments 2>&1
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($LASTEXITCODE -ne 0) {
    # A generic "check that Docker is running" was shown to an operator while
    # Docker was running and healthy, which made a real failure unfixable.
    # Docker's own last lines are what makes it diagnosable.
    $detail = ($output | ForEach-Object { "$_".Trim() } | Where-Object { $_ } | Select-Object -Last 3) -join ' / '
    if (-not $detail) { $detail = "docker compose $($arguments -join ' ') exited with code $LASTEXITCODE" }
    throw "Docker could not complete this step. $detail"
  }
  return $output
}

function Start-NodeRuntime($sync) {
  # Upgrading recreates the agent, which stops the previous container first. An
  # older Node can take the full stop grace period and be killed, and compose
  # has been observed returning non-zero having created the new container
  # without starting it. Retrying completes the upgrade instead of reporting a
  # failed install over a Node that is merely slow to stop.
  $lastError = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Invoke-NodeCompose @('up', '-d') | Out-Null
      return
    } catch {
      $lastError = $_
      if ($attempt -ge 3) { break }
      $sync.message = "Your previous Node is still stopping. Retrying ($attempt of 2)..."
      Start-Sleep -Seconds 5
    }
  }
  throw $lastError
}

function Read-SetupConfig {
  if (-not (Test-Path -LiteralPath $runtimeEnv)) { return $null }
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $config = & docker compose -p kubus-node --env-file $runtimeEnv -f $composeFile exec -T kubus-node-agent sh -lc 'test -s /var/lib/kubus-node/config.env && cat /var/lib/kubus-node/config.env' 2>$null
  } finally { $ErrorActionPreference = $previousPreference }
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($config -join "`n")
}

function Test-Url([string]$url) {
  try {
    $request = [System.Net.HttpWebRequest]::Create($url)
    $request.Method = 'GET'
    $request.Timeout = 3000
    $request.AllowAutoRedirect = $false
    $response = $request.GetResponse()
    $response.Close()
    return $true
  } catch [System.Net.WebException] {
    # A redirect or any HTTP status still means something is listening and
    # answering, which is the only question being asked here.
    if ($_.Exception.Response) { return $true }
    return $false
  } catch { return $false }
}

function Get-DashboardHandoff([string]$config) {
  if ($config -notmatch '(?m)^NODE_GUI_TOKEN=(.+)\r?$') {
    throw 'The saved GUI credential is missing. Your Node data is preserved; repair its configuration before opening the dashboard.'
  }
  $encoded = $Matches[1].Trim()
  $guiCredential = if ($encoded.StartsWith('"')) { $encoded | ConvertFrom-Json } else { $encoded }
  if (-not $guiCredential) { throw 'The saved GUI credential is empty.' }
  try {
    $handoff = Invoke-RestMethod -Uri "$nodeOrigin/gui/api/session/handoff" -Method Post -ContentType 'application/json' -Body '{}' -Headers @{ Authorization = "Bearer $guiCredential" } -TimeoutSec 10
    if ($handoff.ticket -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Invalid handoff' }
    return "$nodeOrigin/gui#handoff=$($handoff.ticket)"
  } catch {
    # Never surface the request, credential, or ticket in an error or progress log.
    throw 'The dashboard could not authorize this browser. Start kubus Node again to retry; your Node data is preserved.'
  } finally { $guiCredential = $null }
}

function Get-FreePort([int]$preferred) {
  foreach ($candidate in @($preferred, 0)) {
    try {
      $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $candidate)
      $probe.Start()
      $port = ([System.Net.IPEndPoint]$probe.LocalEndpoint).Port
      $probe.Stop()
      return $port
    } catch { continue }
  }
  throw 'No local port was available for the setup page.'
}

function Get-ProgressPage {
  return @'
<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Setting up kubus Node</title>
<style>
body{max-width:38rem;margin:3rem auto;padding:0 1rem;font:16px system-ui;line-height:1.55;color:#111}
h1{font-size:1.5rem;margin-bottom:.25rem}
p.lead{color:#555;margin-top:0}
ol{list-style:none;padding:0;margin:2rem 0}
li{padding:.6rem 0 .6rem 2rem;position:relative;color:#999}
li.active{color:#111;font-weight:600}
li.done{color:#111}
li.done::before{content:"\2713";position:absolute;left:0;color:#1a7f37}
li.active::before{content:"";position:absolute;left:.15rem;top:1rem;width:.8rem;height:.8rem;border:2px solid #111;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#detail{color:#555;font-size:.9rem;min-height:1.4rem;white-space:pre-wrap;word-break:break-word}
#err{display:none;background:#fff4f4;border:1px solid #f0c0c0;padding:1rem;border-radius:.4rem}
</style>
<h1>Setting up kubus Node</h1>
<p class="lead">You can leave this page open. It updates by itself.</p>
<ol id="steps">
  <li data-step="docker">Checking Docker Desktop</li>
  <li data-step="pull">Downloading the kubus Node runtime</li>
  <li data-step="start">Starting your Node</li>
  <li data-step="wait">Waiting for your Node to answer</li>
  <li data-step="handoff">Opening setup</li>
</ol>
<p id="detail"></p>
<div id="err"><strong>Setup stopped.</strong><p id="errtext"></p>
<p>Your Node data and identity are untouched. Fix the problem above, then start kubus Node setup again.</p></div>
<script>
var order=['docker','pull','start','wait','handoff'];
function paint(at){
  order.forEach(function(name,i){
    var li=document.querySelector('li[data-step="'+name+'"]');
    li.className = at<0 ? '' : (i<at?'done':(i===at?'active':''));
  });
}
async function tick(){
  try{
    var r=await fetch('/status',{cache:'no-store'});
    var s=await r.json();
    document.getElementById('detail').textContent=s.message||'';
    paint(order.indexOf(s.step));
    if(s.error){
      document.getElementById('err').style.display='block';
      document.getElementById('errtext').textContent=s.error;
      paint(-1);
      return;
    }
    if(s.done&&s.nextUrl){
      order.forEach(function(name){document.querySelector('li[data-step="'+name+'"]').className='done'});
      location.href=s.nextUrl;
      return;
    }
  }catch(e){/* the launcher is busy; keep polling */}
  setTimeout(tick,1000);
}
tick();
</script>
'@
}

function Start-StatusServer([hashtable]$sync, [int]$port) {
  $script = {
    function Read-BoundedLine($reader) {
      $line = New-Object Text.StringBuilder
      while ($true) {
        $value = $reader.Read()
        if ($value -lt 0 -or $value -eq 10) { return $line.ToString().TrimEnd([char]13) }
        if ($line.Length -ge 8192) { throw 'Request line too large' }
        [void]$line.Append([char]$value)
      }
    }
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
    $listener.Start()
    $sync.listening = $true
    while (-not $sync.stopServer) {
      if (-not $listener.Pending()) { Start-Sleep -Milliseconds 50; continue }
      $client = $listener.AcceptTcpClient()
      try {
        $stream = $client.GetStream()
        $stream.ReadTimeout = 3000
        $stream.WriteTimeout = 3000
        $reader = New-Object System.IO.StreamReader($stream)
        $requestLine = Read-BoundedLine $reader
        $headers = @{}
        $headerBytes = 0
        while ($line = Read-BoundedLine $reader) {
          $headerBytes += $line.Length
          if ($headerBytes -gt 8192) { throw 'Request headers too large' }
          if ($line -match '^([^:]+):\s*(.*)$') { $headers[$Matches[1].ToLowerInvariant()] = $Matches[2].Trim() }
        }
        # The status document can contain a single-use browser handoff. Reject
        # DNS rebinding and cross-site reads rather than exposing it to a page
        # hosted on an unrelated origin. No CORS access is granted.
        if ($requestLine -notmatch '^GET /(?:status)?(?:\?[^ ]*)? HTTP/1\.[01]$' -or
            $headers['host'] -ne "127.0.0.1:$port" -or
            $headers['sec-fetch-site'] -eq 'cross-site' -or
            ($headers['origin'] -and $headers['origin'] -ne "http://127.0.0.1:$port")) {
          $denied = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 403 Forbidden`r`nContent-Length: 0`r`nConnection: close`r`n`r`n")
          $stream.Write($denied, 0, $denied.Length)
          continue
        }
        $path = '/'
        if ($requestLine -match '^[A-Z]+\s+(\S+)') { $path = $Matches[1] }
        if ($path -like '/status*') {
          $payload = [ordered]@{ step = $sync.step; message = $sync.message; error = $sync.error; nextUrl = $sync.nextUrl; done = $sync.done } | ConvertTo-Json -Compress
          $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
          $type = 'application/json; charset=utf-8'
        } else {
          $bytes = [Text.Encoding]::UTF8.GetBytes($sync.page)
          $type = 'text/html; charset=utf-8'
        }
        $head = "HTTP/1.1 200 OK`r`nContent-Type: $type`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n"
        $headBytes = [Text.Encoding]::ASCII.GetBytes($head)
        $stream.Write($headBytes, 0, $headBytes.Length)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
      } catch { } finally { $client.Close() }
    }
    $listener.Stop()
  }
  $runspace = [runspacefactory]::CreateRunspace()
  $runspace.Open()
  $runspace.SessionStateProxy.SetVariable('sync', $sync)
  $runspace.SessionStateProxy.SetVariable('port', $port)
  $shell = [powershell]::Create()
  $shell.Runspace = $runspace
  $shell.AddScript($script) | Out-Null
  $shell.BeginInvoke() | Out-Null
  return @{ Shell = $shell; Runspace = $runspace }
}

function Set-Step([hashtable]$sync, [string]$step, [string]$message) {
  $sync.step = $step
  $sync.message = $message
}

function Start-SetupFlow {
  $port = Get-FreePort 8799
  $sync = [hashtable]::Synchronized(@{
    step = 'docker'; message = 'Checking Docker Desktop...'; error = $null
    nextUrl = $null; done = $false; stopServer = $false; page = (Get-ProgressPage)
  })
  $server = Start-StatusServer $sync $port
  Start-Sleep -Milliseconds 250
  Start-Process "http://127.0.0.1:$port/"

  try {
    Test-Docker

    $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($dataRoot).TrimEnd(':', '\'))
    if ($drive.Free -lt 10GB) { throw 'At least 10 GB of free disk space is required before starting kubus Node.' }
    if (-not (Test-Path -LiteralPath $composeFile)) { throw 'This release bundle is incomplete: docker-compose.release.yml is missing. Reinstall kubus Node.' }
    $existingConfig = Read-SetupConfig
    Write-RuntimeTopology ($existingConfig -match '(?m)^LOCAL_API_ALLOW_LAN=(?:"true"|true)$')

    # The pull is the long part. Its output is the only honest progress signal
    # available, so it is surfaced line by line instead of leaving the page
    # looking stalled for minutes.
    #
    # docker compose writes that progress to stderr, and Windows PowerShell 5.1
    # wraps every redirected stderr line in an ErrorRecord. Under the script's
    # 'Stop' preference the FIRST progress line would therefore become a
    # terminating error and abort a pull that was in fact succeeding, reporting
    # a normal line such as "Image ipfs/kubo:v0.43.0 Pulling" as the failure.
    # The preference is relaxed for the duration of the pull only, so progress
    # stays visible; the real outcome is taken from the exit code below, which
    # still catches a genuine failure.
    Set-Step $sync 'pull' 'Downloading the kubus Node runtime. This can take several minutes the first time.'
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & docker compose -p kubus-node --env-file $runtimeEnv -f $composeFile pull 2>&1 | ForEach-Object {
        $line = "$_".Trim()
        if ($line) { $sync.message = $line }
      }
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    if ($LASTEXITCODE -ne 0) { throw 'The kubus Node runtime could not be downloaded. Check this PC''s internet connection and Docker Desktop, then start setup again.' }

    Set-Step $sync 'start' 'Starting your Node...'
    Start-NodeRuntime $sync

    Set-Step $sync 'wait' 'Waiting for your Node to answer...'
    $target = $null
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
      # A Node that has never been configured serves /setup; one that is already
      # configured serves /gui and redirects /setup to it. Either answer means
      # the runtime is up, and each sends the person to the right place.
      if (Test-Url "$nodeOrigin/setup") { $target = "$nodeOrigin/setup"; break }
      if (Test-Url "$nodeOrigin/gui") { $target = "$nodeOrigin/gui"; break }
      Start-Sleep -Seconds 2
    }
    if (-not $target) { throw 'Your Node started but did not answer in time. It keeps running in Docker - open Docker Desktop to see its logs, then start setup again.' }

    $savedConfig = Read-SetupConfig
    if ($savedConfig) {
      $target = Get-DashboardHandoff $savedConfig
    } else {
      Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', $PSCommandPath, '-FinalizeSetup'
      )
    }

    Set-Step $sync 'handoff' 'Your Node is running. Opening setup...'
    $sync.nextUrl = $target
    $sync.done = $true
    # Long enough for the page to poll once and navigate.
    Start-Sleep -Seconds 5
  } catch {
    # Only the deliberate 'throw' messages in this script are written for the
    # person reading the page. Anything else is an internal error, and a raw
    # native-command line ("Image ... Pulling") must never be presented as the
    # reason setup stopped, because it reads as a failure when it is not one.
    $reason = "$($_.Exception.Message)".Trim()
    if ($_.CategoryInfo.Reason -eq 'NativeCommandError' -or -not $reason) {
      $reason = "Setup could not finish the '$($sync.step)' step. Open Docker Desktop, check that it is running, then start kubus Node setup again."
    }
    $sync.error = $reason
    $sync.message = ''
    # Keep the page alive so the reason stays readable instead of vanishing.
    Start-Sleep -Seconds 600
  } finally {
    $sync.stopServer = $true
    Start-Sleep -Milliseconds 200
    try { $server.Shell.Dispose(); $server.Runspace.Dispose() } catch { }
  }
}

function Complete-SetupTransition {
  Test-Docker
  for ($attempt = 0; $attempt -lt 600; $attempt++) {
    $config = Read-SetupConfig
    if ($config -match '(?m)^LOCAL_API_ALLOW_LAN=(?:"true"|true)$') {
      Write-RuntimeTopology $true
      Invoke-NodeCompose @('up', '-d', '--force-recreate')
      return
    }
    if ($config -match '(?m)^LOCAL_API_ALLOW_LAN=(?:"false"|false)$') {
      Write-RuntimeTopology $false
      Invoke-NodeCompose @('up', '-d', '--force-recreate')
      return
    }
    Start-Sleep -Seconds 3
  }
}

function Stop-Node([bool]$removeData) {
  Add-Type -AssemblyName System.Windows.Forms
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

function Show-ManageWindow {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'kubus Node'
  $form.Size = New-Object System.Drawing.Size(520, 250)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false

  $intro = New-Object System.Windows.Forms.Label
  $intro.Text = 'Your Node runs in Docker. Stopping it pauses archive participation; your identity, pairings and captures stay on this computer unless you explicitly delete them.'
  $intro.Location = New-Object System.Drawing.Point(24, 20)
  $intro.Size = New-Object System.Drawing.Size(460, 56)
  $form.Controls.Add($intro)

  $status = New-Object System.Windows.Forms.Label
  $status.Text = ''
  $status.Location = New-Object System.Drawing.Point(24, 84)
  $status.Size = New-Object System.Drawing.Size(460, 24)
  $form.Controls.Add($status)

  $dashboard = New-Object System.Windows.Forms.Button
  $dashboard.Text = 'Open dashboard'
  $dashboard.Location = New-Object System.Drawing.Point(24, 118)
  $dashboard.Size = New-Object System.Drawing.Size(150, 34)
  $dashboard.Add_Click({
    try { Start-Process (Get-DashboardHandoff (Read-SetupConfig)) }
    catch { $status.Text = 'Could not open the dashboard. Start kubus Node and try again.' }
  })
  $form.Controls.Add($dashboard)

  $deleteData = New-Object System.Windows.Forms.CheckBox
  $deleteData.Text = 'Also permanently delete Node data and identity'
  $deleteData.Location = New-Object System.Drawing.Point(24, 164)
  $deleteData.Size = New-Object System.Drawing.Size(400, 24)
  $deleteData.Checked = $false
  $form.Controls.Add($deleteData)

  $stop = New-Object System.Windows.Forms.Button
  $stop.Text = 'Stop Node'
  $stop.Location = New-Object System.Drawing.Point(188, 118)
  $stop.Size = New-Object System.Drawing.Size(150, 34)
  $stop.Add_Click({
    try {
      $deleted = Stop-Node $deleteData.Checked
      if ($deleted) { $status.Text = 'Node stopped and its Docker volumes were removed.' }
      else { $status.Text = 'Node stopped. Its data and identity were preserved.' }
    } catch { Show-Problem $_.Exception.Message }
  })
  $form.Controls.Add($stop)

  [void]$form.ShowDialog()
}

if ($FinalizeSetup) { Complete-SetupTransition; exit }
if ($Manage) { Show-ManageWindow; exit }

try { Start-SetupFlow }
catch { Show-Problem $_.Exception.Message }
