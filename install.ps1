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

Write-Host 'Building and starting web and database...' -ForegroundColor Yellow
docker compose up -d --build

Write-Host 'Service status:' -ForegroundColor Yellow
docker compose ps

Write-Host ''
Write-Host 'Deployment complete: http://localhost:8787' -ForegroundColor Green
Start-Process 'http://localhost:8787'
