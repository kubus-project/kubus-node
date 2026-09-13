@echo off
rem Hands straight to a hidden PowerShell and exits, so no console window sits
rem in front of the person while setup runs. Every step is reported in the
rem browser page the launcher opens.
setlocal
start "" /b powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "%~dp0KubusNodeSetup.ps1"
exit /b 0
