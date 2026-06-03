@echo off
title Asistan AI
cd /d "%~dp0"
echo ============================================================
echo    ASISTAN AI BASLATILIYOR...
echo    Adres: http://127.0.0.1:8000
echo    Bu pencereyi kapatmayin!
echo ============================================================
start "" "http://127.0.0.1:8000/?v=%RANDOM%%RANDOM%"
node server.js
pause
