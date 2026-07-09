<#
.SYNOPSIS
  SQLite の日次バックアップをタスクスケジューラに登録する（pwsh）。
.DESCRIPTION
  毎日 04:10（ロールオーバー直後）に scripts\backup-db.mjs を実行し、
  backups\ に track-YYYYMMDD-HHmmss.sqlite を作成する。
.EXAMPLE
  pwsh -NoProfile -File scripts\install-backup-task.ps1
  pwsh -NoProfile -File scripts\install-backup-task.ps1 -Uninstall
#>
param(
  [switch]$Uninstall,
  [string]$Time = '04:10'
)

$ErrorActionPreference = 'Stop'
$taskName = 'TrackAndControlMe-Backup'
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

$nodePath = (Get-Command node).Source
$argument = "`"$repoRoot\scripts\backup-db.mjs`""

$action = New-ScheduledTaskAction -Execute $nodePath -Argument $argument -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "タスク '$taskName' を登録しました（毎日 $Time にバックアップ）。"
