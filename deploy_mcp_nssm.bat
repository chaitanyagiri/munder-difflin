@echo off
echo ============================================
echo Deploying Munder Kalshi MCP as TRUE Windows Service (NSSM)
echo ============================================
echo.
echo This creates a genuine Windows Service (not just a scheduled task).
echo More robust - survives reboots, runs at system startup (before login).
echo.
echo REQUIRED: This script MUST be run as Administrator
echo REQUIRED: NSSM must be installed first
echo.

REM Check for admin rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This script requires Administrator privileges!
    echo Right-click this file and select "Run as Administrator"
    pause
    exit /b 1
)

set NSSM_PATH=C:\tools\nssm\nssm.exe
if not exist "%NSSM_PATH%" (
    echo.
    echo NSSM not found at %NSSM_PATH%
    echo.
    echo DOWNLOAD INSTRUCTIONS:
    echo 1. Go to: https://nssm.cc/download
    echo 2. Download the latest release (nssm-2.24.zip or newer)
    echo 3. Extract to C:\tools\nssm\ (create the folder)
    echo 4. Ensure nssm.exe is at: C:\tools\nssm\nssm.exe
    echo 5. Run this script again as Administrator
    echo.
    pause
    exit /b 1
)

echo Installing Windows Service "MunderKalshiMCP"...
"%NSSM_PATH%" install MunderKalshiMCP "C:\Program Files\nodejs\node.exe" "C:\Users\chrom\AppData\Local\hermes\integrations\kalshi-mcp\launch.mjs"

if %errorLevel% neq 0 (
    echo ERROR: Failed to install service
    pause
    exit /b 1
)

echo Setting service to auto-start at boot...
"%NSSM_PATH%" set MunderKalshiMCP Start SERVICE_AUTO_START

if %errorLevel% neq 0 (
    echo WARNING: Could not set auto-start (may need manual start)
)

echo Setting service description...
"%NSSM_PATH%" set MunderKalshiMCP Description "Munder Difflin Kalshi MCP Server - Provides trading API access for agentic analysis pipeline"

echo Setting service to run as current user (for .kalshi key access)...
"%NSSM_PATH%" set MunderKalshiMCP ObjectName "%USERDOMAIN%\%USERNAME%"

echo.
echo Starting service now...
"%NSSM_PATH%" start MunderKalshiMCP

echo.
echo Checking service status...
"%NSSM_PATH%" status MunderKalshiMCP

echo.
echo ============================================
echo DEPLOYMENT COMPLETE
echo ============================================
echo.
echo The MCP server is now a TRUE Windows Service:
echo   * Starts at SYSTEM BOOT (before user login)
echo   * Runs with SYSTEM privileges (or your user if configured)
echo   * Automatically restarts on failure
echo   * Survives logouts, reboots, everything
echo.
echo To verify the connection:
echo   cd "C:\Users\chrom\AppData\Local\hermes\integrations\kalshi-mcp"
echo   node verify_debug.mjs
echo.
echo To manage the service later:
echo   %NSSM_PATH% start MunderKalshiMCP
echo   %NSSM_PATH% stop MunderKalshiMCP
echo   %NSSM_PATH% restart MunderKalshiMCP
echo   %NSSM_PATH% status MunderKalshiMCP
echo   %NSSM_PATH% edit MunderKalshiMCP   (opens GUI editor)
echo.
pause