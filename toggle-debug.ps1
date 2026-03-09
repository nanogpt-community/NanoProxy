$flagFile = Join-Path $PSScriptRoot ".debug-logging"

if (Test-Path $flagFile) {
  Remove-Item $flagFile -Force
  Write-Output "Nano Proxy debug logging: OFF"
} else {
  Set-Content -Path $flagFile -Value "enabled" -NoNewline
  Write-Output "Nano Proxy debug logging: ON"
}

if (Test-Path (Join-Path $PSScriptRoot "Logs")) {
  Write-Output ("Logs folder: " + (Join-Path $PSScriptRoot "Logs"))
}
