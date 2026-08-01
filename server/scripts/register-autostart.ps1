<#
Windows ログオン時に track-and-control-me backend を非表示で自動起動するタスクを登録する
（spec: server-autostart / design.md D6）。パスワード保存は不要。
再実行しても安全（既存タスクは一度削除してから再登録する＝冪等）。

注意: 環境によっては `Register-ScheduledTask` が非昇格(非管理者)セッションだと
Access Denied になることがある。その場合は PowerShell を「管理者として実行」で
開き直してから本スクリプトを実行すること。
#>

$ErrorActionPreference = 'Stop'

$TaskName = 'TrackAndControlMe-AutoStart'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VbsPath = Join-Path $ScriptDir 'start-hidden.vbs'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
}

$Action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$VbsPath`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

try {
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings `
        -Description 'track-and-control-me backend をログオン時に非表示で自動起動する' `
        -ErrorAction Stop | Out-Null
} catch {
    Write-Error "登録に失敗しました: $($_.Exception.Message)`n→ PowerShell を「管理者として実行」で開き直して再実行してください。"
    exit 1
}

# Register-ScheduledTask はエラーを投げずに未登録で終わることがあるため、実際に
# 登録されたかどうかを読み取って確認する（成功メッセージの誤報を防ぐ）。
$verified = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $verified) {
    Write-Error "登録できませんでした（原因不明・Get-ScheduledTask で見つかりません）。`n→ PowerShell を「管理者として実行」で開き直して再実行してください。"
    exit 1
}

Write-Host "登録しました: $TaskName"
Write-Host "  起動スクリプト: $VbsPath"
