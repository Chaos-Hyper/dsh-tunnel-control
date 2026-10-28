@echo off
rem dsh-tunnel 的 Windows 快捷入口：等价于 node bin\dsh-tunnel.mjs %*
rem 不放 npm install 也能用，只要本机有 node。
setlocal
node "%~dp0bin\dsh-tunnel.mjs" %*
endlocal
