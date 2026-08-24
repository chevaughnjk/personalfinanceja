<#
  Personal Finance Analyser - Launcher
  ===========================================================================
  This is the home base for the whole app folder. Because the app is a folder
  you keep (not something installed into Windows), this window is the one place
  a person runs everything from: opening their finances, setting up, fixing
  problems, finding their files, and checking the record of what happened.

  It is written for someone who is not technical. Every button says what it
  does in plain words, and shows a short line underneath explaining it, so a
  person can operate the entire folder from here without ever opening a file
  or typing a command.

  One file, two run modes:
    * No arguments  -> the home window described above.
    * -Task <name>  -> runs one action in the background and writes a log.
                       The window launches this hidden, so there is exactly
                       one place that knows how each action actually runs.

  Lives in  pfa\launcher\  and drives the project one level up,
  reusing the npm scripts the project already defines. Double-click
  Launch.cmd beside it to open.

  Reliability notes (for future maintainers):
    * The browser is the preferred way in; the installed desktop app is a
      fallback offered only where it exists.
    * Logging never depends on Start-Transcript. Every background task writes
      timestamped lines directly to a log file, and native command output is
      redirected straight into that same file.
    * Stopping the app stops the whole process tree, so no orphaned Node or
      Electron process is left running invisibly after the window closes.
    * Only one window can run at a time, enforced with a per-user Mutex.
    * Any unexpected error is written to a dated crash log and shown in a
      message box that stays on screen.

  Corporate networks: setup trusts the machine certificate store so downloads
  work behind an SSL-inspecting proxy, then clears that setting again before
  the installed app starts. If the installed-app download is blocked, setup
  quietly continues with the browser version, which works.
#>

param(
    [ValidateSet('setup', 'web', 'desktop', 'test')]
    [string]$Task
)

# --- Where things are -------------------------------------------------------
$ScriptPath = if ($PSCommandPath) { $PSCommandPath }
              elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path }
              else { Join-Path (Get-Location).Path 'launch.ps1' }
$LauncherDir = Split-Path -Parent $ScriptPath
$ProjectRoot = Split-Path -Parent $LauncherDir
$LogDir      = Join-Path $LauncherDir 'logs'
if ($ProjectRoot -and (Test-Path -LiteralPath $ProjectRoot)) {
    Set-Location -LiteralPath $ProjectRoot
}

# --- Error handling: never let an error just flash and vanish ---------------
try {
    if (Test-Path Variable:\PSNativeCommandUseErrorActionPreference) {
        $PSNativeCommandUseErrorActionPreference = $false
    }
} catch { }

trap {
    $detail = ($_ | Out-String).Trim()
    $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
    $crash  = Join-Path $LogDir "crash-$stamp.log"
    try {
        if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
        Set-Content -LiteralPath $crash -Value $detail -ErrorAction Stop
    } catch { $crash = '(the log folder could not be written to)' }
    try {
        Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
        [System.Windows.MessageBox]::Show(
            "Something went wrong while opening the app.`n`n$detail`n`nA copy of this has been saved to:`n$crash",
            "Personal Finance Analyser",
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Error
        ) | Out-Null
    } catch {
        Write-Host ''
        Write-Host '  Something went wrong while opening the app:' -ForegroundColor Red
        Write-Host ''
        Write-Host "  $detail" -ForegroundColor Red
        Write-Host ''
        Write-Host "  A copy has been saved to: $crash"
        Write-Host ''
        try { Read-Host '  Press Enter to close' } catch { Start-Sleep -Seconds 30 }
    }
    exit 1
}

# ===========================================================================
#  LOGGING
# ===========================================================================
function Initialize-LogFile([string]$name) {
    if (-not (Test-Path -LiteralPath $LogDir)) {
        try { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null } catch { }
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $path  = Join-Path $LogDir "$name-$stamp.log"
    try {
        Set-Content -LiteralPath $path -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Log started ($name)." -ErrorAction Stop
    } catch { }
    return $path
}
function Write-Log([string]$Path, [string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    try { Add-Content -LiteralPath $Path -Value $line -ErrorAction Stop } catch { }
}

# ===========================================================================
#  FACTS
# ===========================================================================
function Get-NodeVersion {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $null }
    try { return (& node --version).Trim() } catch { return $null }
}
function Test-Deps    { Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules') }
function Test-Vendor  { Test-Path -LiteralPath (Join-Path $ProjectRoot 'third-party\pdf.min.mjs') }
function Test-Desktop { Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe') }
function Test-Core {
    foreach ($f in 'index.html','application\app.js','settings\config.json','package.json') {
        if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $f))) { return $false }
    }
    return $true
}
function Test-PortOpen([int]$Port) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async  = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok     = $async.AsyncWaitHandle.WaitOne(300)
        if ($ok -and $client.Connected) { $client.Close(); return $true }
        $client.Close()
        return $false
    } catch { return $false }
}

# The readiness list, in plain language. Shown in the "What's ready" panel so
# a person can see at a glance what is in place and what still needs doing.
function Get-Health {
    $node = Get-NodeVersion
    $rows = @()
    $rows += [pscustomobject]@{ id='node';    ok=[bool]$node; level='blocker'
        title = if ($node) { "Free part installed" } else { "Free part needed (Node.js)" }
        detail = if ($node) { "" }
                 else { "A small, free, one-time part. Installs in a couple of minutes; only ever needed once." } }
    $core = Test-Core
    $rows += [pscustomobject]@{ id='core';    ok=$core; level='blocker'
        title = if ($core) { "Program files present" } else { "Some program files are missing" }
        detail = if ($core) { "" }
                 else { "Part of the folder appears to be missing. Re-download or re-sync the whole folder, then open this again." } }
    $deps = Test-Deps
    $rows += [pscustomobject]@{ id='deps';    ok=$deps; level='blocker'
        title = if ($deps) { "Set up on this computer" } else { "Not set up yet" }
        detail = if ($deps) { "" }
                 else { "A quick one-time setup installs what the app needs. Nothing leaves this device." } }
    $vendor = Test-Vendor
    $rows += [pscustomobject]@{ id='vendor';  ok=$vendor; level='blocker'
        title = if ($vendor) { "Statement reader ready" } else { "Statement reader not prepared" }
        detail = if ($vendor) { "" }
                 else { "The app can open, but cannot read PDF statements until this is prepared. Repair or refresh finishes it." } }
    $desk = Test-Desktop
    $rows += [pscustomobject]@{ id='desktop'; ok=$desk; level='info'
        title = if ($desk) { "Installed app available" } else { "Installed app not downloaded" }
        detail = if ($desk) { "" }
                 else { "The browser version is recommended and works now. The installed version can be added later on a network that allows the download." } }
    return $rows
}

# Boil readiness down to the single best next step, for the big status line
# and the main button. The browser is always the recommended way in.
function Resolve-State {
    $node = Get-NodeVersion
    if (-not $node)        { return [pscustomobject]@{ dot='amber'; status='This computer needs one free part first (Node.js). It installs in a couple of minutes, once.'; label='Get the free part'; action='node' } }
    if (-not (Test-Core))  { return [pscustomobject]@{ dot='red';   status='Some program files are missing. Open the folder to check them, or re-sync the whole folder.'; label='Open app folder'; action='folder' } }
    if (-not (Test-Deps))  { return [pscustomobject]@{ dot='amber'; status="Almost there. A quick, one-time setup is needed before the first open."; label='Set up'; action='setup' } }
    if (-not (Test-Vendor)){ return [pscustomobject]@{ dot='amber'; status='Nearly ready. One short step remains so statements can be read.'; label='Finish setup'; action='setup' } }
    return [pscustomobject]@{ dot='green'; status="Everything's ready. Your money stays on this computer."; label='Open my finances'; action='web' }
}

# ===========================================================================
#  HEADLESS MODE  ( -Task )
# ===========================================================================
function Invoke-SetupTask {
    $logPath = Initialize-LogFile 'setup'
    Write-Log $logPath 'Setup task started.'
    $env:NODE_OPTIONS = '--use-system-ca'
    $env:ELECTRON_GET_USE_PROXY = 'true'
    $rc = 0
    if (-not (Test-Deps)) {
        Write-Log $logPath 'Installing what the app needs...'
        & npm install --no-audit --no-fund *>> $logPath
        $rc = $LASTEXITCODE
        if ($rc -ne 0) {
            Write-Log $logPath "First install attempt failed (exit code $rc), usually the installed-app download on a work network. Retrying without it..."
            $env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
            & npm install --no-audit --no-fund *>> $logPath
            $rc = $LASTEXITCODE
            Remove-Item Env:\ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue
            Write-Log $logPath "Retry without the installed-app download exited with code $rc."
        }
    } else {
        Write-Log $logPath 'Already installed; moving straight to the statement reader step.'
    }
    if ($rc -eq 0) {
        Write-Log $logPath 'Preparing the statement reader...'
        & npm run vendor *>> $logPath
        $rc = $LASTEXITCODE
        Write-Log $logPath "Statement reader step exited with code $rc."
    }
    Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:\ELECTRON_GET_USE_PROXY -ErrorAction SilentlyContinue
    if ($rc -ne 0) {
        Write-Log $logPath 'Setup did not finish. See the lines above. On a stricter work network, setup.bat in the main folder carries the fuller fallback steps.'
    } else {
        Write-Log $logPath 'Setup finished successfully. The app is ready.'
    }
    exit $rc
}

function Invoke-WebTask {
    $logPath = Initialize-LogFile 'web'
    Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
    Write-Log $logPath 'Web task started.'
    if (Test-PortOpen 8000) {
        Write-Log $logPath 'Something is already responding on port 8000; opening the browser only.'
        Start-Process 'http://localhost:8000'
        exit 0
    }
    Start-Job -ScriptBlock {
        param($LogPath)
        $deadline = (Get-Date).AddSeconds(25)
        $opened = $false
        while ((Get-Date) -lt $deadline) {
            try {
                $client = New-Object System.Net.Sockets.TcpClient
                $async  = $client.BeginConnect('127.0.0.1', 8000, $null, $null)
                if ($async.AsyncWaitHandle.WaitOne(300) -and $client.Connected) {
                    $client.Close(); Start-Process 'http://localhost:8000'; $opened = $true; break
                }
                $client.Close()
            } catch { }
            Start-Sleep -Milliseconds 400
        }
        if (-not $opened) {
            $line = "[{0}] The web server did not respond within 25 seconds; the browser was not opened automatically." -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
            try { Add-Content -LiteralPath $LogPath -Value $line -ErrorAction Stop } catch { }
        }
    } -ArgumentList $logPath | Out-Null
    & npm run web *>> $logPath
    $rc = $LASTEXITCODE
    Write-Log $logPath "npm run web exited with code $rc."
    exit $rc
}

function Invoke-DesktopTask {
    $logPath = Initialize-LogFile 'desktop'
    Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
    Write-Log $logPath 'Desktop task started.'
    & npm start *>> $logPath
    $rc = $LASTEXITCODE
    Write-Log $logPath "npm start exited with code $rc."
    exit $rc
}

function Invoke-TestTask {
    $logPath = Initialize-LogFile 'test'
    Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
    Write-Log $logPath 'Test task started.'
    & npm test *>> $logPath
    $rc = $LASTEXITCODE
    Write-Log $logPath "npm test exited with code $rc."
    exit $rc
}

if ($Task) {
    switch ($Task) {
        'setup'   { Invoke-SetupTask }
        'web'     { Invoke-WebTask }
        'desktop' { Invoke-DesktopTask }
        'test'    { Invoke-TestTask }
    }
    return
}

# ===========================================================================
#  HOME MODE  ( default )  - the plain-language control panel.
# ===========================================================================
try {
    Add-Type -Namespace NativeMethods -Name DpiHelper -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
'@ -ErrorAction Stop
    [void][NativeMethods.DpiHelper]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch { }

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$MutexName = 'Local\PersonalFinanceAnalyser_Launcher_SingleInstance'
$createdNewMutex = $true
$AppMutex = $null
try {
    $AppMutex = New-Object System.Threading.Mutex($true, $MutexName, [ref]$createdNewMutex)
} catch { $createdNewMutex = $true; $AppMutex = $null }
if (-not $createdNewMutex) {
    try {
        [System.Windows.MessageBox]::Show(
            "Personal Finance Analyser is already open. Check your taskbar, or press Alt+Tab, to find its window.",
            "Personal Finance Analyser",
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Information
        ) | Out-Null
    } catch { }
    exit 0
}

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Personal Finance Analyser"
        WindowStartupLocation="CenterScreen"
        WindowStyle="SingleBorderWindow" ResizeMode="CanResize"
        UseLayoutRounding="True" TextOptions.TextFormattingMode="Display"
        MinWidth="480" MinHeight="600" Width="560" Height="760" Background="#12161F">
  <Window.Resources>
    <Style x:Key="Primary" TargetType="Button">
      <Setter Property="Foreground" Value="#FFFFFF"/>
      <Setter Property="FontSize" Value="16"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Height" Value="54"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" CornerRadius="10" Background="#4F86F7">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Background" Value="#6B9BFF"/></Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter TargetName="b" Property="Background" Value="#2A3242"/>
                <Setter Property="Foreground" Value="#6B7488"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <!-- A described action: title on top, one plain line underneath. -->
    <Style x:Key="Action" TargetType="Button">
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="HorizontalContentAlignment" Value="Stretch"/>
      <Setter Property="Margin" Value="0,0,0,10"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" CornerRadius="10" Background="#1B2130" BorderBrush="#2A3242" BorderThickness="1" Padding="16,12">
              <ContentPresenter VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Background" Value="#222A3B"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="b" Property="Background" Value="#161B26"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Link" TargetType="Button">
      <Setter Property="Foreground" Value="#8B93A3"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border Background="Transparent"><ContentPresenter HorizontalAlignment="Left" VerticalAlignment="Center"/></Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter Property="Foreground" Value="#B9C0CE"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Section" TargetType="TextBlock">
      <Setter Property="Foreground" Value="#6B7488"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Margin" Value="2,20,0,10"/>
    </Style>
  </Window.Resources>

  <ScrollViewer VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
    <Grid HorizontalAlignment="Center" MaxWidth="600" Margin="30,26,30,26">
      <StackPanel>
        <TextBlock Text="Personal Finance Analyser" Foreground="#F2F4F8" FontSize="24" FontWeight="SemiBold"/>
        <TextBlock Text="Your private money dashboard. Everything runs on this computer."
                   Foreground="#8B93A3" FontSize="14" Margin="0,6,0,0" TextWrapping="Wrap"/>

        <!-- STATUS: one plain line about what's happening right now. -->
        <Border CornerRadius="12" Background="#1B2130" Margin="0,20,0,0" Padding="16,14">
          <StackPanel>
            <StackPanel Orientation="Horizontal">
              <Ellipse x:Name="Dot" Width="12" Height="12" Fill="#8B93A3" VerticalAlignment="Top" Margin="0,5,0,0"/>
              <TextBlock x:Name="StatusText" Text="Checking..." Foreground="#E6EAF2" FontSize="15"
                         Margin="12,0,0,0" VerticalAlignment="Center" TextWrapping="Wrap"
                         AutomationProperties.LiveSetting="Polite" AutomationProperties.Name="Status"/>
            </StackPanel>
            <StackPanel x:Name="ProgressPanel" Margin="0,14,0,0" Visibility="Collapsed">
              <TextBlock x:Name="ProgressText" Text="Working..." Foreground="#B9C0CE" FontSize="13" Margin="0,0,0,7"/>
              <ProgressBar x:Name="Bar" Height="6" IsIndeterminate="True" Background="#12161F"
                           Foreground="#4F86F7" BorderThickness="0"/>
            </StackPanel>
          </StackPanel>
        </Border>

        <!-- MAIN ACTION -->
        <Button x:Name="PrimaryBtn" Style="{StaticResource Primary}" Content="Open my finances" Margin="0,18,0,0"/>

        <!-- RUNNING: shown only while the app is open. -->
        <Button x:Name="CloseAppBtn" Style="{StaticResource Action}" Visibility="Collapsed">
          <StackPanel>
            <TextBlock Text="Close app" Foreground="#F2F4F8" FontSize="15" FontWeight="SemiBold"/>
            <TextBlock Text="Stops the local service running behind your finances. Do this when you're finished." Foreground="#9AA2B2" FontSize="13" TextWrapping="Wrap" Margin="0,3,0,0"/>
          </StackPanel>
        </Button>

        <!-- OPEN OPTIONS -->
        <TextBlock x:Name="OpenHeading" Text="OTHER WAYS TO OPEN" Style="{StaticResource Section}"/>
        <Button x:Name="DesktopBtn" Style="{StaticResource Action}">
          <StackPanel>
            <TextBlock x:Name="DesktopTitle" Text="Open the installed app" Foreground="#F2F4F8" FontSize="15" FontWeight="SemiBold"/>
            <TextBlock x:Name="DesktopDesc" Text="A separate window instead of your browser. The browser is recommended." Foreground="#9AA2B2" FontSize="13" TextWrapping="Wrap" Margin="0,3,0,0"/>
          </StackPanel>
        </Button>

        <!-- SET UP & FIX -->
        <TextBlock Text="SET UP &amp; FIX" Style="{StaticResource Section}"/>
        <Button x:Name="SetupBtn" Style="{StaticResource Action}">
          <StackPanel>
            <TextBlock x:Name="SetupTitle" Text="Set up" Foreground="#F2F4F8" FontSize="15" FontWeight="SemiBold"/>
            <TextBlock x:Name="SetupDesc" Text="Installs what the app needs on this computer. Only needed once." Foreground="#9AA2B2" FontSize="13" TextWrapping="Wrap" Margin="0,3,0,0"/>
          </StackPanel>
        </Button>
        <Button x:Name="TestBtn" Style="{StaticResource Action}">
          <StackPanel>
            <TextBlock Text="Check everything works" Foreground="#F2F4F8" FontSize="15" FontWeight="SemiBold"/>
            <TextBlock Text="Runs a quick self-check and writes it to the activity log." Foreground="#9AA2B2" FontSize="13" TextWrapping="Wrap" Margin="0,3,0,0"/>
          </StackPanel>
        </Button>

        <!-- FILES & ACTIVITY -->
        <TextBlock Text="YOUR FILES &amp; ACTIVITY" Style="{StaticResource Section}"/>
        <Button x:Name="FolderBtn" Style="{StaticResource Action}">
          <StackPanel>
            <TextBlock Text="Open the app folder" Foreground="#F2F4F8" FontSize="15" FontWeight="SemiBold"/>
            <TextBlock Text="See where the app lives on this computer. Your statements are never copied here." Foreground="#9AA2B2" FontSize="13" TextWrapping="Wrap" Margin="0,3,0,0"/>
          </StackPanel>
        </Button>
        <Button x:Name="LogsBtn" Style="{StaticResource Action}">
          <StackPanel>
            <TextBlock Text="View the activity log" Foreground="#F2F4F8" FontSize="15" FontWeight="SemiBold"/>
            <TextBlock Text="A plain record of what the app did, useful if something needs troubleshooting." Foreground="#9AA2B2" FontSize="13" TextWrapping="Wrap" Margin="0,3,0,0"/>
          </StackPanel>
        </Button>

        <!-- WHAT'S READY -->
        <TextBlock Text="WHAT'S READY" Style="{StaticResource Section}"/>
        <StackPanel x:Name="HealthList"/>

        <!-- PRIVACY -->
        <Border CornerRadius="10" Background="#182A1F" Margin="0,16,0,0" Padding="14,12">
          <StackPanel Orientation="Horizontal">
            <TextBlock Text="&#128274;" FontSize="14" Margin="0,0,10,0" VerticalAlignment="Top"/>
            <TextBlock Text="Your statements and data stay on this device. Nothing is uploaded, ever."
                       Foreground="#B9E3C6" FontSize="13" TextWrapping="Wrap" VerticalAlignment="Center"/>
          </StackPanel>
        </Border>

        <!-- FOOTER: where it lives -->
        <TextBlock x:Name="FootText" Text="" Foreground="#5A6274" FontSize="12" Margin="2,16,0,0" TextWrapping="Wrap"/>
      </StackPanel>
    </Grid>
  </ScrollViewer>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)

$ctrl = @{}
foreach ($n in 'Dot','StatusText','ProgressPanel','ProgressText','Bar','PrimaryBtn',
                'CloseAppBtn','OpenHeading','DesktopBtn','DesktopTitle','DesktopDesc',
                'SetupBtn','SetupTitle','SetupDesc','TestBtn','FolderBtn','LogsBtn',
                'HealthList','FootText') {
    $ctrl[$n] = $window.FindName($n)
}

$Colors = @{ green='#34D399'; amber='#F5B14C'; red='#F87171'; muted='#8B93A3' }

$script:busyProc    = $null   # short-lived setup/repair/test; shows progress
$script:busyLabel   = ''
$script:runningProc = $null   # long-lived app (web server or desktop app)
$script:runningKind = $null
$script:lastSetupFailed = $false
$script:nodeLinkOpened  = $false
$script:primaryAction   = 'web'

function Start-AppTask([string]$task) {
    return Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -WorkingDirectory $ProjectRoot -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ScriptPath`"", '-Task', $task
    )
}

function Get-ChildProcessIds([int]$ParentId) {
    try {
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId" -ErrorAction Stop |
            Select-Object -ExpandProperty ProcessId
    } catch { @() }
}
function Stop-ProcessTree([int]$RootId) {
    if (-not $RootId) { return }
    $ids = New-Object System.Collections.Generic.List[int]
    $ids.Add($RootId)
    $queue = New-Object System.Collections.Generic.Queue[int]
    $queue.Enqueue($RootId)
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        foreach ($childId in (Get-ChildProcessIds $current)) {
            if (-not $ids.Contains($childId)) { $ids.Add($childId); $queue.Enqueue($childId) }
        }
    }
    for ($i = $ids.Count - 1; $i -ge 0; $i--) {
        try { Stop-Process -Id $ids[$i] -Force -ErrorAction SilentlyContinue } catch { }
    }
}

function Start-Busy([string]$kind, [string]$label) {
    $script:busyProc  = Start-AppTask $kind
    $script:busyLabel = $label
    $ctrl.ProgressText.Text = $label
    $ctrl.ProgressPanel.Visibility = 'Visible'
}
function Start-Running([string]$kind) {
    $script:runningKind = $kind
    $script:runningProc = Start-AppTask $kind
}
function Stop-Running {
    if ($script:runningProc -and -not $script:runningProc.HasExited) {
        Stop-ProcessTree $script:runningProc.Id
    }
    $script:runningProc = $null
    $script:runningKind = $null
}

function Set-ActionsEnabled([bool]$on) {
    foreach ($b in 'PrimaryBtn','DesktopBtn','SetupBtn','TestBtn') { $ctrl[$b].IsEnabled = $on }
}

function Update-Ui {
    # Settle finished background work.
    if ($script:busyProc -and $script:busyProc.HasExited) {
        $exit = $script:busyProc.ExitCode
        # Only a setup run affects the failed flag; a test run does not.
        if ($script:busyLabel -like 'Set*' -or $script:busyLabel -like 'Repair*' -or $script:busyLabel -like 'Finish*') {
            $script:lastSetupFailed = ($exit -ne 0)
        }
        $script:busyProc  = $null
        $script:busyLabel = ''
        $ctrl.ProgressPanel.Visibility = 'Collapsed'
    }
    if ($script:runningProc -and $script:runningProc.HasExited) {
        $script:runningProc = $null
        $script:runningKind = $null
    }

    $busy    = [bool]$script:busyProc
    $running = [bool]$script:runningProc

    # Footer (where it lives) and readiness list refresh every tick.
    $node = Get-NodeVersion
    $ctrl.FootText.Text = "Installed in: $ProjectRoot" + $(if ($node) { "     .     $node     .     on-device only" } else { "     .     on-device only" })
    Build-Health

    # SET UP & FIX button wording adapts to the situation.
    if (-not (Test-Deps)) {
        $ctrl.SetupTitle.Text = 'Set up'
        $ctrl.SetupDesc.Text  = 'Installs what the app needs on this computer. Only needed once.'
    } elseif (-not (Test-Vendor)) {
        $ctrl.SetupTitle.Text = 'Finish setup'
        $ctrl.SetupDesc.Text  = 'One short step remains so PDF statements can be read.'
    } else {
        $ctrl.SetupTitle.Text = 'Repair or refresh'
        $ctrl.SetupDesc.Text  = 'Re-runs setup to fix a problem or refresh the statement reader. Safe to run anytime.'
    }

    # Installed-app button reflects availability.
    if (Test-Desktop) {
        $ctrl.DesktopBtn.IsEnabled = $true
        $ctrl.DesktopTitle.Text = 'Open the installed app'
        $ctrl.DesktopDesc.Text  = 'A separate window instead of your browser. The browser is recommended.'
    } else {
        $ctrl.DesktopBtn.IsEnabled = $false
        $ctrl.DesktopTitle.Text = 'Installed app (not downloaded)'
        $ctrl.DesktopDesc.Text  = "It didn't download, often a work network. The browser version works now."
    }

    if ($busy) {
        $ctrl.Dot.Fill = $Colors.amber
        $ctrl.StatusText.Text = $script:busyLabel
        $ctrl.PrimaryBtn.Visibility = 'Visible'
        $ctrl.CloseAppBtn.Visibility = 'Collapsed'
        Set-ActionsEnabled $false
        return
    }

    if ($running) {
        $ctrl.Dot.Fill = $Colors.green
        $ctrl.StatusText.Text = if ($script:runningKind -eq 'web') { 'Your finances are open in the browser. This window can stay out of the way.' } else { 'Your finances are open.' }
        $ctrl.PrimaryBtn.Visibility = 'Collapsed'
        $ctrl.CloseAppBtn.Visibility = 'Visible'
        Set-ActionsEnabled $true
        $ctrl.PrimaryBtn.IsEnabled = $false
        return
    }

    # Idle: main button = smart next step.
    $ctrl.CloseAppBtn.Visibility = 'Collapsed'
    $ctrl.PrimaryBtn.Visibility = 'Visible'
    Set-ActionsEnabled $true

    $s = Resolve-State
    $script:primaryAction = $s.action
    $ctrl.Dot.Fill = $Colors[$s.dot]
    $ctrl.PrimaryBtn.Content = $s.label

    if ($script:lastSetupFailed) {
        $ctrl.StatusText.Text = "That didn't finish. Try Set up again, or open the activity log below to see the step that stopped."
    } elseif ($script:nodeLinkOpened -and $s.action -eq 'node') {
        $ctrl.StatusText.Text = 'The Node.js download page opened in your browser. After installing it, click Set up.'
        $ctrl.PrimaryBtn.Content = 'Set up'
        $script:primaryAction = 'setup'
    } else {
        $ctrl.StatusText.Text = $s.status
    }
}

function Build-Health {
    $ctrl.HealthList.Children.Clear()
    $brush = { param($hex) (New-Object Windows.Media.BrushConverter).ConvertFromString($hex) }
    foreach ($r in (Get-Health)) {
        $color = if ($r.ok) { $Colors.green } elseif ($r.level -eq 'info') { $Colors.muted } elseif ($r.id -eq 'core') { $Colors.red } else { $Colors.amber }
        $row = New-Object System.Windows.Controls.StackPanel
        $row.Orientation = 'Horizontal'
        $row.Margin = New-Object Windows.Thickness(0,0,0,8)
        $dot = New-Object System.Windows.Shapes.Ellipse
        $dot.Width = 9; $dot.Height = 9
        $dot.Margin = New-Object Windows.Thickness(2,6,0,0)
        $dot.VerticalAlignment = 'Top'
        $dot.Fill = & $brush $color
        $col = New-Object System.Windows.Controls.StackPanel
        $col.Margin = New-Object Windows.Thickness(11,0,0,0)
        $t = New-Object System.Windows.Controls.TextBlock
        $t.Text = $r.title; $t.FontSize = 14; $t.Foreground = & $brush '#D7DCE6'; $t.TextWrapping = 'Wrap'
        [void]$col.Children.Add($t)
        if (-not $r.ok -and $r.detail) {
            $d = New-Object System.Windows.Controls.TextBlock
            $d.Text = $r.detail; $d.FontSize = 12; $d.Foreground = & $brush '#9AA2B2'
            $d.TextWrapping = 'Wrap'; $d.Margin = New-Object Windows.Thickness(0,2,0,0)
            [void]$col.Children.Add($d)
        }
        [void]$row.Children.Add($dot); [void]$row.Children.Add($col)
        [void]$ctrl.HealthList.Children.Add($row)
    }
}

function Open-Logs {
    try {
        if ((Test-Path -LiteralPath $LogDir) -and (Get-ChildItem -LiteralPath $LogDir -Filter *.log -ErrorAction SilentlyContinue)) {
            $latest = Get-ChildItem -LiteralPath $LogDir -Filter *.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            Start-Process -FilePath 'notepad.exe' -ArgumentList "`"$($latest.FullName)`"" -ErrorAction Stop
        } else {
            $ctrl.StatusText.Text = 'No activity log yet. One is created the first time you set up or open the app.'
        }
    } catch {
        $ctrl.StatusText.Text = 'The log could not be opened. You can find it in the logs folder next to this app.'
    }
}
function Open-Folder {
    try { Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$ProjectRoot`"" -ErrorAction Stop }
    catch { $ctrl.StatusText.Text = 'The app folder could not be opened.' }
}

function Invoke-Action([string]$action) {
    switch ($action) {
        'node' {
            try { Start-Process 'https://nodejs.org' -ErrorAction Stop; $script:nodeLinkOpened = $true }
            catch { $ctrl.StatusText.Text = 'Could not open the download page. Visit nodejs.org in your browser instead.' }
        }
        'folder'  { Open-Folder }
        'setup'   {
            $label = if (-not (Test-Deps)) { 'Setting up. This can take a couple of minutes...' } else { 'Finishing setup. This will only take a few seconds...' }
            $script:lastSetupFailed = $false
            Start-Busy 'setup' $label
        }
        'web'     { Start-Running 'web' }
        'desktop' { Start-Running 'desktop' }
    }
    Update-Ui
}

# --- Wiring -----------------------------------------------------------------
$ctrl.PrimaryBtn.Add_Click({ Invoke-Action $script:primaryAction })
$ctrl.DesktopBtn.Add_Click({ Invoke-Action 'desktop' })
$ctrl.CloseAppBtn.Add_Click({ Stop-Running; Update-Ui })
$ctrl.SetupBtn.Add_Click({
    $label = if (-not (Test-Deps)) { 'Setting up. This can take a couple of minutes...' }
             elseif (-not (Test-Vendor)) { 'Finishing setup. This will only take a few seconds...' }
             else { 'Repairing and refreshing. This can take a moment...' }
    $script:lastSetupFailed = $false
    Start-Busy 'setup' $label
    Update-Ui
})
$ctrl.TestBtn.Add_Click({ Start-Busy 'test' 'Checking everything works...'; Update-Ui })
$ctrl.FolderBtn.Add_Click({ Open-Folder })
$ctrl.LogsBtn.Add_Click({ Open-Logs })

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(2)
$timer.Add_Tick({
    try { Update-Ui }
    catch {
        try {
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            Add-Content -LiteralPath (Join-Path $LogDir "ui-$stamp.log") -Value (($_ | Out-String).Trim()) -ErrorAction SilentlyContinue
        } catch { }
    }
})

$window.Add_Loaded({ Update-Ui; $timer.Start() })
$window.Add_Closed({
    $timer.Stop()
    if ($script:busyProc -and -not $script:busyProc.HasExited) { Stop-ProcessTree $script:busyProc.Id }
    Stop-Running
    if ($AppMutex) { try { $AppMutex.ReleaseMutex() } catch { } }
})

[void]$window.ShowDialog()
