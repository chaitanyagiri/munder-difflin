<# 
.SYNOPSIS
    Deploys Munder Kalshi MCP as persistent Windows Scheduled Task
    Self-elevates to Administrator - just click "Yes" on the UAC prompt
#>

# Self-elevation check
if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Requesting Administrator privileges..." -ForegroundColor Yellow
    Start-Process powershell.exe "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Munder Kalshi MCP - Persistent Service Deployment" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Configuration
$NodePath = "C:\Program Files\nodejs\node.exe"
$LaunchScript = "C:\Users\chrom\AppData\Local\hermes\integrations\kalshi-mcp\launch.mjs"
$TaskName = "MunderKalshiMCP"
$TaskDescription = "Munder Difflin Kalshi MCP Server - Provides trading API access for agentic analysis pipeline"

# Verify files exist
if (-not (Test-Path $NodePath)) {
    Write-Error "Node.js not found at: $NodePath"
    pause
    exit 1
}
if (-not (Test-Path $LaunchScript)) {
    Write-Error "Launch script not found at: $LaunchScript"
    pause
    exit 1
}

Write-Host "Files verified:" -ForegroundColor Green
Write-Host "  Node.js: $NodePath"
Write-Host "  Launch:  $LaunchScript"
Write-Host ""

# Remove existing task if present
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Removing existing task..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Create the scheduled task
Write-Host "Creating scheduled task: $TaskName" -ForegroundColor Cyan

$Action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$LaunchScript`"" -WorkingDirectory (Split-Path $LaunchScript)
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description $TaskDescription -Force

Write-Host "Task created successfully!" -ForegroundColor Green
Write-Host ""

# Start the task immediately
Write-Host "Starting task now..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName

# Wait a moment and verify
Start-Sleep -Seconds 3

$NodeProcesses = Get-Process -Name "node" -ErrorAction SilentlyContinue
if ($NodeProcesses) {
    Write-Host ""
    Write-Host "Service is RUNNING!" -ForegroundColor Green
    Write-Host "  Node.exe processes found: $($NodeProcesses.Count)" -ForegroundColor Green
    $NodeProcesses | Select-Object Id, CPU, WorkingSet, StartTime | Format-Table -AutoSize | Out-Host
} else {
    Write-Host ""
    Write-Warning "Node.exe not detected yet - may still be starting"
}

# Show task details
Write-Host ""
Write-Host "Task Details:" -ForegroundColor Cyan
Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo | Select-Object TaskName, State, LastRunTime, NextRunTime | Format-Table -AutoSize | Out-Host

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  DEPLOYMENT COMPLETE" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "The MCP server will now:" -ForegroundColor White
Write-Host "  Start automatically at every user login" -ForegroundColor Green
Write-Host "  Run with highest privileges" -ForegroundColor Green
Write-Host "  Run as YOUR user (accesses .kalshi keys)" -ForegroundColor Green
Write-Host "  Survive logouts, restarts, and Hermes sessions" -ForegroundColor Green
Write-Host ""
Write-Host "To verify connection from any terminal:" -ForegroundColor Cyan
Write-Host '  cd "C:\Users\chrom\AppData\Local\hermes\integrations\kalshi-mcp"' -ForegroundColor Gray
Write-Host '  node verify_debug.mjs' -ForegroundColor Gray
Write-Host ""
Write-Host "To test a live trade:" -ForegroundColor Cyan
Write-Host '  echo {"qualifies": true, "side": "YES", "ticker": "KXLOWTBOS-26SEP11-T63", "contracts": 1, "size_dollars": 0.49, "executable_price": 0.35, "size_fraction": 0.01, "raw_edge": 0.05, "usable_edge": 0.03, "reasons": ["live test"]} | python skills\trading\kalshi\execute.py' -ForegroundColor Gray
Write-Host ""
Write-Host "Press any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")