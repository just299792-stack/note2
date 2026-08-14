@echo off
chcp 65001 >nul
title 手记 Note 2 服务器
cd /d "%~dp0"
echo 正在启动「手记」服务器 ...
echo iPad 请在同一 Wi-Fi 下用 Safari 打开下面的地址：
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=1 delims= " %%b in ("%%a") do echo    http://%%b:8080
)
echo.
echo 关闭此窗口即停止服务。
echo.
node server.js
pause
