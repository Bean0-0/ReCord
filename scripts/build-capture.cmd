@echo off
call "%~1" >nul
if errorlevel 1 exit /b 1
cl.exe /nologo /std:c++17 /EHsc /MT /O2 /W4 /Fe:"%~2" /Fo:"%~3" "%~4"
exit /b %errorlevel%
