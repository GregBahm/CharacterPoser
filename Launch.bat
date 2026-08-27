@echo off
title Character Poser Server
cd /d "%~dp0"

if not exist node_modules (
  echo node_modules not found - run "npm install" first.
  pause
  exit /b 1
)

echo Starting Character Poser dev server...
echo Close this window to stop the server.
echo.

rem Wait for the server to come up, then open the browser (runs in the background).
start "" /b cmd /c "for /l %%i in (1,1,60) do (curl -s -o nul http://localhost:5173/ && (start "" http://localhost:5173/ & exit /b) || timeout /t 1 /nobreak >nul)"

rem Run Vite in the foreground of this console; closing the window kills it.
call npm run dev
