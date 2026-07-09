param([string]$Date = (Get-Date -Format "yyyy-MM-dd"))

$bytes = [System.Text.Encoding]::UTF8.GetBytes($Date)
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = $sha.ComputeHash($bytes)
$hex = ([System.BitConverter]::ToString($hash) -replace '-','').ToLower()
$hex.Substring(0, 6)
