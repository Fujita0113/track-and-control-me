<#
.SYNOPSIS
  backend をログオン時に常駐起動する Windows タスクスケジューラ登録スクリプト（pwsh）。
.DESCRIPTION
  現在のユーザーのログオン時に、非表示ウィンドウで `npm run server` を起動する
  スケジュールタスク "TrackAndControlMe-Backend" を登録する。
.EXAMPLE
  pwsh -NoProfile -File scripts\install-startup.ps1
  pwsh -NoProfile -File scripts\install-startup.ps1 -Uninstall
#>
param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$taskName = 'TrackAndControlMe-Backend'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "タスク '$taskName' を削除しました。"
  } else {
    Write-Host "タスク '$taskName' は存在しません。"
  }
  return
}

# pwsh の実体パス。
$pwshPath = (Get-Command pwsh).Source

# 非表示で backend を起動（作業ディレクトリ = リポジトリルート）。
$argument = "-NoProfile -WindowStyle Hidden -Command `"Set-Location -LiteralPath '$repoRoot'; npm run server`""

$action = New-ScheduledTaskAction -Execute $pwshPath -Argument $argument -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "タスク '$taskName' を登録しました（次回ログオンから backend が常駐します）。"
Write-Host "今すぐ起動: Start-ScheduledTask -TaskName '$taskName'"
