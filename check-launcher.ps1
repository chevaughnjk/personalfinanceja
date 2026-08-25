$Path = ".\assistant-launcher\launch-assistant.ps1"
$Lines = Get-Content -LiteralPath $Path

function Show-LineRange {
    param(
        [int]$First,
        [int]$Last
    )

    if ($First -lt 1) {
        $First = 1
    }

    if ($Last -gt $Lines.Count) {
        $Last = $Lines.Count
    }

    for ($Number = $First; $Number -le $Last; $Number++) {
        "{0}: {1}" -f $Number, $Lines[$Number - 1]
    }
}

"=== FILE HEADER ==="
Show-LineRange -First 1 -Last 8

"=== XAML OPENING ==="
$XamlStart = Select-String -LiteralPath $Path -SimpleMatch -Pattern '$xaml = @'''

if ($XamlStart) {
    Show-LineRange -First $XamlStart.LineNumber -Last ($XamlStart.LineNumber + 15)
}
else {
    "XAML opening was not found."
}

"=== RUN ID SECTION ==="
$RunIdMatch = Select-String -LiteralPath $Path -SimpleMatch -Pattern '$runId ='

if ($RunIdMatch) {
    Show-LineRange -First ($RunIdMatch.LineNumber - 4) -Last ($RunIdMatch.LineNumber + 10)
}
else {
    "Run ID section was not found."
}

"=== DETAILS BUTTON SECTION ==="
$DetailsMatch = Select-String -LiteralPath $Path -SimpleMatch -Pattern '$Controls.DetailsButton.IsEnabled ='

foreach ($Match in $DetailsMatch) {
    Show-LineRange -First ($Match.LineNumber - 5) -Last ($Match.LineNumber + 7)
    "---"
}

"=== TIMER SECTION ==="
$TimerMatch = Select-String -LiteralPath $Path -SimpleMatch -Pattern '$Timer.Interval ='

if ($TimerMatch) {
    Show-LineRange -First ($TimerMatch.LineNumber - 4) -Last ($TimerMatch.LineNumber + 10)
}
else {
    "Timer interval section was not found."
}

"=== XAML CLOSING ==="
$XamlEnd = Select-String -LiteralPath $Path -SimpleMatch -Pattern "'@" | Select-Object -First 1

if ($XamlEnd) {
    Show-LineRange -First ($XamlEnd.LineNumber - 5) -Last ($XamlEnd.LineNumber + 3)
}
else {
    "XAML closing marker was not found."
}

"=== CURRENT PARSER RESULT ==="
$Tokens = $null
$Errors = $null

[System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $Path).Path,
    [ref]$Tokens,
    [ref]$Errors
) | Out-Null

$Errors | Format-List *
"Parser error count: $($Errors.Count)"
