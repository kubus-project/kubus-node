@echo off
setlocal
start "kubus Node Setup" powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0KubusNodeSetup.ps1"
