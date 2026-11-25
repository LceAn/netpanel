@echo off
chcp 65001 >nul
rem 双击启动交换机面板。关闭这个窗口即停止面板。
rem 需要先装好 Node.js (https://nodejs.org)。如需修改交换机地址等配置，见 ..\README.md 的"配置"一节。
cd /d "%~dp0"
where node >nul 2>nul || (
  echo 没有找到 node 命令，请先安装 Node.js 20 或更高版本: https://nodejs.org
  pause
  exit /b 1
)
echo 正在启动交换机面板，浏览器打开 http://127.0.0.1:8208
echo 关闭本窗口 (或按 Ctrl+C) 即停止。
node server.mjs
pause
