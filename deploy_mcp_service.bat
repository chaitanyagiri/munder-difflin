@echo off
echo ============================================
echo Deploying Munder Kalshi MCP as Windows Service
echo ============================================
echo.
echo This script will create a scheduled task that runs the MCP server
echo automatically at every user login with highest privileges.
echo.
echo REQUIRED: This script MUST be run as Administrator
echo.

REM Check for admin rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This script requires Administrator privileges!
    echo Right-click this file and select "Run as Administrator"
    pause
    exit /b 1
)

echo Creating scheduled task "MunderKalshiMCP"...
schtasks /Create /SC ONLOGON /RL HIGHEST /TN "MunderKalshiMCP" ^
  /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\Users\chrom\AppData\Local\hermes\integrations\kalshi-mcp\launch.mjs\"" ^
  /F /RU "%USERNAME%"

if %errorLevel% neq 0 (
    echo ERROR: Failed to create scheduled task
    pause
    exit /b 1
)

echo.
echo Verifying task creation...
schtasks /Query /TN "MunderKalshiMCP" /V /FO LIST

echo.
echo Starting service now...
schtasks /Run /TN "MunderKalshiMCP"

echo.
echo Checking if node.exe is running...
timeout /t 3 /nobreak >nul
tasklist /FI "IMAGENAME eq node.exe"

echo.
echo ============================================
echo DEPLOYMENT COMPLETE
echo ============================================
echo.
echo The MCP server will now:
echo   * Start automatically at every user login
echo   * Run with highest privileges
echo   * Run as your user (accesses .kalshi keys)
echo   * Survive logouts, restarts, and Hermes sessions
echo.
echo To verify the connection from any terminal:
echo   cd "C:\Users\chrom\AppData\Local\hermes\integrations\kalshi-mcp"
echo   node verify_debug.mjs
echo.
echo To test a live trade:
echo   echo {\"qualifies\": true, \"side\": \"YES\", \"ticker\": \"KXLOWTBOS-26SEP11-T63\", \"contracts\": 1, \"size_dollars\": 0.49, \"executable_price\": 0.35, \"size_fraction\": 0.01, \"raw_edge\": 0.05, \"usable_edge\": 0.03, \"reasons\": [\"live test\"]} ^| python skills\trading\kalshi\execute.py
echo.
pause