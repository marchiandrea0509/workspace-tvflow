@echo off
start "TradingView MCP Debug" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File "%~dp0start-tv-debug.ps1"
