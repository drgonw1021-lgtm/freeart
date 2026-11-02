@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   FREEART 启动器
echo   1. 首次使用请先执行：npm install --registry=https://registry.npmmirror.com
echo   2. 本地引擎未装时，打开页面点顶栏「引擎」一键安装
echo.
node launch.js
echo.
echo 关闭此窗口不会停止服务；要停止请在任务管理器结束 node.exe
pause
