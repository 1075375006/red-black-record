$ErrorActionPreference = 'Stop'

Write-Host '=== Red Black Record installer ===' -ForegroundColor Cyan

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'Docker is not installed. Install Docker Desktop first.' -ForegroundColor Red
  exit 1
}

cmd /c "docker info >nul 2>nul"
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Docker Desktop is not running. Start it and run this installer again.' -ForegroundColor Red
  exit 1
}

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

Write-Host 'Pulling required images...' -ForegroundColor Yellow
docker pull node:22-alpine
docker pull postgres:16-alpine

Write-Host 'Preparing proxy gateway secrets...' -ForegroundColor Yellow
$envPath = Join-Path $projectDir '.env'
$envLines = @()
if (Test-Path $envPath) { $envLines = @(Get-Content $envPath) }
function Set-EnvValue([string]$key, [string]$value) {
  $script:envLines = @($script:envLines | Where-Object { $_ -notmatch "^$([regex]::Escape($key))=" })
  $script:envLines += "$key=$value"
}
function Ensure-Secret([string]$key) {
  $existing = $script:envLines | Where-Object { $_ -match "^$([regex]::Escape($key))=" } | Select-Object -Last 1
  if (-not $existing -or $existing -match '^.+=$') {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    Set-EnvValue $key (([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()))
  }
}
if ($env:RED_BLACK_SOCKS5_PROXY) { Set-EnvValue 'UPSTREAM_SOCKS5_PROXY' $env:RED_BLACK_SOCKS5_PROXY }
Ensure-Secret 'RELAY_TOKEN'
Ensure-Secret 'PROXY_ADMIN_TOKEN'
Ensure-Secret 'PROXY_SECRET_KEY'
$envLines | Set-Content -Path $envPath -Encoding ascii

Write-Host 'Building and starting web, proxy gateway, and database...' -ForegroundColor Yellow
docker compose up -d --build

Write-Host 'Service status:' -ForegroundColor Yellow
docker compose ps

Write-Host ''
Write-Host 'Deployment complete: http://localhost:4399' -ForegroundColor Green
Start-Process 'http://localhost:4399'
