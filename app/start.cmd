@echo off
chcp 65001 >nul
rem 双击启动 NetPanel 交换机管理面板。关闭这个窗口 (或按 Ctrl+C) 即停止面板。
rem 需要先装好 Node.js 20 或更高版本 (https://nodejs.org)。
rem 第一次打开 http://127.0.0.1:8208 时先创建面板的管理员账号, 再在「设备管理」里添加交换机。
rem 要让局域网里的其它电脑也能访问, 把监听地址改成 0.0.0.0: 见 ..\README.md 的"配置"一节。
cd /d "%~dp0"
where node >nul 2>nul || (
  echo 没有找到 node 命令，请先安装 Node.js 20 或更高版本: https://nodejs.org
  pause
  exit /b 1
)
echo 正在启动 NetPanel，浏览器打开 http://127.0.0.1:8208
echo 关闭本窗口 (或按 Ctrl+C) 即停止。
node server.mjs
pause
