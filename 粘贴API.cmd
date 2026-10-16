@echo off
rem 双击这个文件：弹出粘贴框，把从 AGC 控制台复制的内容粘进去即可。
rem 不需要自己创建 .json，也不需要在命令行里输入密码。
chcp 65001 >nul
setlocal
set "SCRIPT=%~dp0scripts\paste-credential.ps1"
if not exist "%SCRIPT%" (
  echo [错误] 找不到 %SCRIPT%
  echo 请确认这个 .cmd 和 scripts 目录在同一个仓库里。
  pause
  exit /b 2
)
powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%SCRIPT%"
if errorlevel 1 (
  echo.
  echo 如果窗口没有出现，可以改用命令行方式：
  echo   cd /d "%~dp0"
  echo   node scripts\setup.mjs
  pause
)
endlocal
