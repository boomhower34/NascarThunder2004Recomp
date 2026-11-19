@echo off
rem Double-click to open the NASCAR Thunder 2004 launcher in your browser.
cd /d "%~dp0"
node launcher.mjs %*
if errorlevel 1 pause
