@echo off
rem Manual launcher for tools\webvpn-proxy.mjs (the plugin starts it automatically on
rem every host start and re-checks it every 30 s, so this is only a fallback).
rem Idempotent: exits when 127.0.0.1:8788 is already listening.
setlocal
set SCRIPT=%~dp0webvpn-proxy.mjs

netstat -ano | findstr ":8788" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [madmodel] adapter already listening on 127.0.0.1:8788
  exit /b 0
)

where node >nul 2>&1
if errorlevel 1 (
  echo [madmodel] node is not on PATH - run it with the DSH runtime node instead:
  echo   "%%LOCALAPPDATA%%\..\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "%%~dp0webvpn-proxy.mjs"
  exit /b 1
)

echo [madmodel] starting adapter (Ctrl+C to stop)
node "%SCRIPT%"
