<#
register-autostart.ps1 で登録した自動起動タスクを解除する（spec: server-autostart）。
未登録の状態で実行してもエラーにしない。
#>

$ErrorActionPreference = 'Stop'

$TaskName = 'TrackAndControlMe-AutoStart'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    } catch {
        Write-Error "解除に失敗しました: $($_.Exception.Message)`n→ PowerShell を「管理者として実行」で開き直して再実行してください。"
        exit 1
    }
    Write-Host "解除しました: $TaskName"
} else {
    Write-Host "$TaskName は登録されていません（何もしません）"
}
