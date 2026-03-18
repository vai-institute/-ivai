@echo off
REM ============================================================
REM  start_cva_tool.bat — CVA Curation Tool Launcher
REM  Institute for Value-Generative AI (IVAI)
REM
REM  Usage: Double-click this file from Windows Explorer,
REM         or run from any terminal at C:\projects\ivai-cva-tool\
REM
REM  Requires: Node.js and npm installed and on PATH.
REM            Run `npm install` once before first launch.
REM ============================================================

cd /d "%~dp0"

echo Starting CVA Curation Tool...
npm start
