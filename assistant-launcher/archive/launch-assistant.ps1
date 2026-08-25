$ErrorActionPreference = "Stop"

$ScriptPath = if ($PSCommandPath) {
    $PSCommandPath
}
elseif ($MyInvocation.MyCommand.Path) {
    $MyInvocation.MyCommand.Path
}
else {
    Join-Path (Get-Location).Path "launch-assistant.ps1"
}

$LauncherDir = Split-Path -Parent $ScriptPath
$ProjectRoot = Split-Path -Parent $LauncherDir

$AssistantScript = Join-Path $ProjectRoot "developer-tools\repo-assistant\assistant.js"
$AssistantRoot = Join-Path $ProjectRoot ".assistant"
$ResultRoot = Join-Path $AssistantRoot "results"
$AuditRoot = Join-Path $AssistantRoot "audit"
$CurrentRoot = Join-Path $AssistantRoot "current"
$HandoffPath = Join-Path $CurrentRoot "copilot-context.md"

Set-Location -LiteralPath $ProjectRoot

function Show-PersistentError {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,

        [Parameter(Mandatory = $true)]
        [string]$Detail
    )

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $detailPath = Join-Path $AuditRoot "launcher-crash-$stamp.txt"

    try {
        New-Item -ItemType Directory -Path $AuditRoot -Force | Out-Null
        Set-Content -LiteralPath $detailPath -Value $Detail -Encoding utf8
    }
    catch {
        $detailPath = "(the detail file could not be written)"
    }

    try {
        Add-Type -AssemblyName PresentationFramework -ErrorAction Stop

        [System.Windows.MessageBox]::Show(
            "$Message`n`nDetails were saved to:`n$detailPath",
            "PFA Notes Assistant",
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Error
        ) | Out-Null
    }
    catch {
        Write-Host ""
        Write-Host $Message -ForegroundColor Red
        Write-Host ""
        Write-Host "Details were saved to:"
        Write-Host $detailPath
        Write-Host ""

        try {
            Read-Host "Press Enter to close"
        }
        catch {
            Start-Sleep -Seconds 30
        }
    }
}

trap {
    $detail = ($_ | Out-String).Trim()

    Show-PersistentError `
        -Message "Something went wrong while opening the notes assistant." `
        -Detail $detail

    exit 1
}

if (-not (Test-Path -LiteralPath $AssistantScript -PathType Leaf)) {
    throw "The repository assistant is missing: developer-tools\repo-assistant\assistant.js"
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw "Node.js is not available on this computer."
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$MutexName = "Local\PFA_Notes_Assistant_SingleInstance"
$CreatedNewMutex = $true
$AssistantMutex = $null

try {
    $AssistantMutex = New-Object System.Threading.Mutex(
        $true,
        $MutexName,
        [ref]$CreatedNewMutex
    )
}
catch {
    $CreatedNewMutex = $true
    $AssistantMutex = $null
}

if (-not $CreatedNewMutex) {
    [System.Windows.MessageBox]::Show(
        "PFA Notes Assistant is already open. Check the taskbar or press Alt+Tab.",
        "PFA Notes Assistant",
        [System.Windows.MessageBoxButton]::OK,
        [System.Windows.MessageBoxImage]::Information
    ) | Out-Null

    exit 0
}

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="PFA Notes Assistant"
        Width="620"
        Height="690"
        MinWidth="520"
        MinHeight="590"
        WindowStartupLocation="CenterScreen"
        ResizeMode="CanResize"
        Background="#12161F"
        UseLayoutRounding="True"
        TextOptions.TextFormattingMode="Display">
  <Window.Resources>
    <Style x:Key="ActionButton" TargetType="Button">
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="HorizontalContentAlignment" Value="Stretch"/>
      <Setter Property="Margin" Value="0,0,0,12"/>
      <Setter Property="Padding" Value="16,13"/>
      <Setter Property="Background" Value="#1B2130"/>
      <Setter Property="BorderBrush" Value="#2A3242"/>
      <Setter Property="BorderThickness" Value="1"/>
    </Style>

    <Style x:Key="SmallButton" TargetType="Button">
      <Setter Property="Foreground" Value="#B9C0CE"/>
      <Setter Property="Background" Value="#1B2130"/>
      <Setter Property="BorderBrush" Value="#2A3242"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Padding" Value="12,7"/>
      <Setter Property="Margin" Value="0,0,8,0"/>
      <Setter Property="Cursor" Value="Hand"/>
    </Style>
  </Window.Resources>

  <ScrollViewer VerticalScrollBarVisibility="Auto"
                HorizontalScrollBarVisibility="Disabled">
    <StackPanel Margin="30,26">
      <TextBlock Text="PFA Notes Assistant"
                 Foreground="#F2F4F8"
                 FontSize="24"
                 FontWeight="SemiBold"/>

      <TextBlock Text="Keeps the app notes current without reading personal finance data."
                 Foreground="#8B93A3"
                 FontSize="14"
                 Margin="0,6,0,0"
                 TextWrapping="Wrap"/>

      <Border Background="#1B2130"
              CornerRadius="12"
              Margin="0,20,0,18"
              Padding="16,14">
        <StackPanel>
          <StackPanel Orientation="Horizontal">
            <Ellipse x:Name="StatusDot"
                     Width="12"
                     Height="12"
                     Fill="#8B93A3"
                     Margin="0,5,0,0"
                     VerticalAlignment="Top"/>

            <TextBlock x:Name="StatusText"
                       Text="Ready."
                       Foreground="#E6EAF2"
                       FontSize="15"
                       Margin="12,0,0,0"
                       TextWrapping="Wrap"
                       AutomationProperties.LiveSetting="Polite"/>
          </StackPanel>

          <StackPanel x:Name="ProgressPanel"
                      Visibility="Collapsed"
                      Margin="0,14,0,0">
            <TextBlock x:Name="ProgressText"
                       Text="Working..."
                       Foreground="#B9C0CE"
                       FontSize="13"/>

            <ProgressBar Height="6"
                         IsIndeterminate="True"
                         Margin="0,7,0,0"
                         Foreground="#4F86F7"
                         Background="#12161F"
                         BorderThickness="0"/>
          </StackPanel>
        </StackPanel>
      </Border>

      <Button x:Name="CheckButton"
              Style="{StaticResource ActionButton}">
        <StackPanel>
          <TextBlock Text="See what's changed"
                     Foreground="#F2F4F8"
                     FontSize="16"
                     FontWeight="SemiBold"/>

          <TextBlock Text="Checks every generated note and changes nothing."
                     Foreground="#9AA2B2"
                     FontSize="13"
                     Margin="0,4,0,0"
                     TextWrapping="Wrap"/>
        </StackPanel>
      </Button>

      <Button x:Name="RefreshButton"
              Style="{StaticResource ActionButton}">
        <StackPanel>
          <TextBlock Text="Update what's changed"
                     Foreground="#F2F4F8"
                     FontSize="16"
                     FontWeight="SemiBold"/>

          <TextBlock Text="Rebuilds only notes whose source files have changed."
                     Foreground="#9AA2B2"
                     FontSize="13"
                     Margin="0,4,0,0"
                     TextWrapping="Wrap"/>
        </StackPanel>
      </Button>

      <Button x:Name="RebuildButton"
              Style="{StaticResource ActionButton}">
        <StackPanel>
          <TextBlock Text="Start completely fresh"
                     Foreground="#F2F4F8"
                     FontSize="16"
                     FontWeight="SemiBold"/>

          <TextBlock Text="Builds a complete replacement. The app and its data are untouched."
                     Foreground="#9AA2B2"
                     FontSize="13"
                     Margin="0,4,0,0"
                     TextWrapping="Wrap"/>
        </StackPanel>
      </Button>

      <TextBlock Text="RESULT"
                 Foreground="#6B7488"
                 FontSize="12"
                 FontWeight="SemiBold"
                 Margin="2,14,0,9"/>

      <Border Background="#171C27"
              BorderBrush="#2A3242"
              BorderThickness="1"
              CornerRadius="10"
              Padding="14">
        <TextBlock x:Name="ResultText"
                   Text="Run a check to compare the notes with the app."
                   Foreground="#B9C0CE"
                   FontSize="13"
                   TextWrapping="Wrap"
                   MinHeight="90"/>
      </Border>

      <StackPanel Orientation="Horizontal"
                  Margin="0,16,0,0">
        <Button x:Name="HandoffButton"
                Style="{StaticResource SmallButton}"
                Content="Open Copilot hand-off"
                IsEnabled="False"/>

        <Button x:Name="FolderButton"
                Style="{StaticResource SmallButton}"
                Content="Open notes folder"/>

        <Button x:Name="DetailsButton"
                Style="{StaticResource SmallButton}"
                Content="View details"
                IsEnabled="False"/>
      </StackPanel>

      <Border Background="#182A1F"
              CornerRadius="10"
              Margin="0,20,0,0"
              Padding="14,12">
        <TextBlock Text="Only project files are checked. Statements, browser storage and financial exports are not read."
                   Foreground="#B9E3C6"
                   FontSize="13"
                   TextWrapping="Wrap"/>
      </Border>
    </StackPanel>
  </ScrollViewer>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)

$ControlNames = @(
    "StatusDot",
    "StatusText",
    "ProgressPanel",
    "ProgressText",
    "CheckButton",
    "RefreshButton",
    "RebuildButton",
    "ResultText",
    "HandoffButton",
    "FolderButton",
    "DetailsButton"
)

$Controls = @{}

foreach ($ControlName in $ControlNames) {
    $Controls[$ControlName] = $window.FindName($ControlName)
}

$Colours = @{
    Green = "#34D399"
    Amber = "#F5B14C"
    Red = "#F87171"
    Muted = "#8B93A3"
}

$script:RunningProcess = $null
$script:RunningAction = $null
$script:RunningRunId = $null
$script:ExpectedResultPath = $null
$script:LatestDetailPath = $null

function Set-ActionsEnabled {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Enabled
    )

    $Controls.CheckButton.IsEnabled = $Enabled
    $Controls.RefreshButton.IsEnabled = $Enabled
    $Controls.RebuildButton.IsEnabled = $Enabled
}

function Start-AssistantAction {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("check", "refresh", "rebuild")]
        [string]$Action
    )

    if ($script:RunningProcess) {
        return
    }

    if ($Action -eq "rebuild") {
        $answer = [System.Windows.MessageBox]::Show(
            "This replaces the complete generated notes pack.`n`nThe finance app and personal data are untouched. The current pack stays in place unless the new one passes validation.`n`nContinue?",
            "Start completely fresh?",
            [System.Windows.MessageBoxButton]::YesNo,
            [System.Windows.MessageBoxImage]::Question
        )

        if ($answer -ne [System.Windows.MessageBoxResult]::Yes) {
            return
        }
    }

    New-Item -ItemType Directory -Path $ResultRoot -Force | Out-Null

    $runId = "{0}-{1}" -f (
        Get-Date -Format "yyyyMMddHHmmss"
    ), (
        (New-Guid).ToString("N")
    )

    $resultPath = Join-Path $ResultRoot "$runId.json"

    $arguments = @(
        $AssistantScript,
        $Action,
        "--run-id",
        $runId,
        "--result",
        $resultPath
    )

    $script:RunningProcess = Start-Process `
        -FilePath "node.exe" `
        -ArgumentList $arguments `
        -WorkingDirectory $ProjectRoot `
        -PassThru `
        -WindowStyle Hidden

    $script:RunningAction = $Action
    $script:RunningRunId = $runId
    $script:ExpectedResultPath = $resultPath
    $script:LatestDetailPath = $null

    Set-ActionsEnabled -Enabled $false

    $Controls.DetailsButton.IsEnabled = $false
    $Controls.HandoffButton.IsEnabled = $false
    $Controls.ProgressPanel.Visibility = "Visible"

    $Controls.ProgressText.Text = switch ($Action) {
        "check" {
            "Checking the current notes..."
        }

        "refresh" {
            "Updating changed notes..."
        }

        "rebuild" {
            "Building a complete replacement..."
        }
    }

    $Controls.StatusDot.Fill = $Colours.Amber
    $Controls.StatusText.Text = $Controls.ProgressText.Text
    $Controls.ResultText.Text = "The current valid pack stays available while this runs."
}

function Finish-AssistantAction {
    $finishedProcess = $script:RunningProcess
    $expectedAction = $script:RunningAction
    $expectedRunId = $script:RunningRunId
    $expectedResultPath = $script:ExpectedResultPath

    $script:RunningProcess = $null
    $script:RunningAction = $null
    $script:RunningRunId = $null
    $script:ExpectedResultPath = $null

    $Controls.ProgressPanel.Visibility = "Collapsed"
    Set-ActionsEnabled -Enabled $true

    if (-not (Test-Path -LiteralPath $expectedResultPath -PathType Leaf)) {
        $Controls.StatusDot.Fill = $Colours.Red
        $Controls.StatusText.Text = "No trustworthy result was produced."
        $Controls.ResultText.Text = "The existing notes pack was not replaced."
        return
    }

    try {
        $result = Get-Content -LiteralPath $expectedResultPath -Raw |
            ConvertFrom-Json
    }
    catch {
        $Controls.StatusDot.Fill = $Colours.Red
        $Controls.StatusText.Text = "The result file was broken."
        $Controls.ResultText.Text = "The existing notes pack was not replaced."
        return
    }

    $validResult = (
        $result.schemaVersion -eq 1 -and
        $result.runId -eq $expectedRunId -and
        $result.action -eq $expectedAction -and
        $result.complete -eq $true -and
        $finishedProcess.HasExited
    )

    if (-not $validResult) {
        $Controls.StatusDot.Fill = $Colours.Red
        $Controls.StatusText.Text = "The result did not match the action that was started."
        $Controls.ResultText.Text = "The result was rejected. The existing notes pack was not replaced."
        return
    }

    $Controls.StatusText.Text = [string]$result.headline
    $Controls.ResultText.Text = [string]$result.message

    $Controls.StatusDot.Fill = if (
        $result.outcome -in @("current", "updated")
    ) {
        $Colours.Green
    }
    elseif (
        $result.outcome -in @(
            "out-of-date",
            "full-rebuild-required"
        )
    ) {
        $Colours.Amber
    }
    else {
        $Colours.Red
    }

    $script:LatestDetailPath = if ($result.detailPath) {
        Join-Path $AssistantRoot ([string]$result.detailPath)
    }
    else {
        $null
    }

    $Controls.DetailsButton.IsEnabled = [bool]$script:LatestDetailPath

    $Controls.HandoffButton.IsEnabled = $result.handoffCurrent -eq $true -and
        (Test-Path -LiteralPath $HandoffPath -PathType Leaf)
    
}

function Stop-RunningAction {
    if (-not $script:RunningProcess) {
        return
    }

    if (-not $script:RunningProcess.HasExited) {
        try {
            Stop-Process `
                -Id $script:RunningProcess.Id `
                -Force `
                -ErrorAction SilentlyContinue
        }
        catch {
        }
    }

    $script:RunningProcess = $null
}

$Controls.CheckButton.Add_Click({
    Start-AssistantAction -Action "check"
})

$Controls.RefreshButton.Add_Click({
    Start-AssistantAction -Action "refresh"
})

$Controls.RebuildButton.Add_Click({
    Start-AssistantAction -Action "rebuild"
})

$Controls.HandoffButton.Add_Click({
    if (Test-Path -LiteralPath $HandoffPath -PathType Leaf) {
        Start-Process `
            -FilePath "notepad.exe" `
            -ArgumentList "`"$HandoffPath`""
    }
})

$Controls.FolderButton.Add_Click({
    New-Item `
        -ItemType Directory `
        -Path $AssistantRoot `
        -Force |
        Out-Null

    Start-Process `
        -FilePath "explorer.exe" `
        -ArgumentList "`"$AssistantRoot`""
})

$Controls.DetailsButton.Add_Click({
    if (
        $script:LatestDetailPath -and
        (Test-Path -LiteralPath $script:LatestDetailPath -PathType Leaf)
    ) {
        Start-Process `
            -FilePath "notepad.exe" `
            -ArgumentList "`"$script:LatestDetailPath`""
    }
})

$Timer = New-Object System.Windows.Threading.DispatcherTimer
$Timer.Interval = New-Object System.TimeSpan(0,0,0,0,250)

$Timer.Add_Tick({
    if (
        $script:RunningProcess -and
        $script:RunningProcess.HasExited
    ) {
        Finish-AssistantAction
    }
})

$window.Add_Loaded({
    $Timer.Start()
})

$window.Add_Closed({
    $Timer.Stop()
    Stop-RunningAction

    if ($AssistantMutex) {
        try {
            $AssistantMutex.ReleaseMutex()
        }
        catch {
        }
    }
})

[void]$window.ShowDialog()