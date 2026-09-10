@echo off
setlocal EnableDelayedExpansion
title jobSearch - dependency installer

rem ---------------------------------------------------------------------------
rem  Asks which dependencies you want, then installs them. Windows 10/11.
rem
rem  Everything here is optional and nothing is installed without a yes: press
rem  Enter to take the suggested answer, which is "no" for anything already
rem  found on this machine. Run it again as often as you like.
rem
rem  Installs go through winget (App Installer, shipped with Windows 11), except
rem  Claude Code, which uses its own installer so that it keeps itself updated.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

echo.
echo  ===========================================================
echo    jobSearch - dependency installer
echo  ===========================================================
echo.
echo  Repo: %CD%
echo.

rem --- what is already here ---------------------------------------------------

call :detect

echo  Checking what you already have...
echo.
echo    Node.js 20+ ........ !S_NODE!
echo    Git ................ !S_GIT!
echo    Obsidian ........... !S_OBSIDIAN!
echo    Claude Code ........ !S_CLAUDE!
echo    winget ............. !S_WINGET!
echo    Project deps ....... !S_MODULES!
echo    config.json ........ !S_CONFIG!
echo    Obsidian plugins ... !S_PLUGINS!
echo.

if "!HAVE_WINGET!"=="" (
  echo  winget was not found, so this script cannot install applications for you.
  echo  Install "App Installer" from the Microsoft Store, or use the download
  echo  links in README.md, then run this script again for the project steps.
  echo.
)

rem --- ask ---------------------------------------------------------------------

echo  ---- What would you like to install? ----------------------
echo.

set "DO_NODE=N"
set "DO_GIT=N"
set "DO_OBSIDIAN=N"
set "DO_CLAUDE=N"
set "DO_NPM=N"
set "DO_CONFIG=N"
set "DO_PLUGINS=N"
set "DO_VAULT=N"

if "!HAVE_WINGET!"=="1" (
  call :ask "Node.js 24 LTS - required, runs the scraper" "!SUGGEST_NODE!"
  set "DO_NODE=!ANSWER!"

  call :ask "Git - required to clone and update this repo" "!SUGGEST_GIT!"
  set "DO_GIT=!ANSWER!"

  call :ask "Obsidian - the vault and its control panel" "!SUGGEST_OBSIDIAN!"
  set "DO_OBSIDIAN=!ANSWER!"

  call :ask "Claude Code - optional, only for writing applications" "!SUGGEST_CLAUDE!"
  set "DO_CLAUDE=!ANSWER!"
) else (
  call :ask "Claude Code - optional, only for writing applications" "N"
  set "DO_CLAUDE=!ANSWER!"
)

call :ask "Project dependencies - npm install, downloads Chromium (~400 MB)" "!SUGGEST_NPM!"
set "DO_NPM=!ANSWER!"

call :ask "Create scraper\config.json from config.example.json" "!SUGGEST_CONFIG!"
set "DO_CONFIG=!ANSWER!"

call :ask "Obsidian plugins - Buttons, Shell commands, Meta Bind" "!SUGGEST_PLUGINS!"
set "DO_PLUGINS=!ANSWER!"

call :ask "Scaffold the vault now - npm run vault, no network" "Y"
set "DO_VAULT=!ANSWER!"

echo.
echo  ---- Working ----------------------------------------------
echo.

set "FAILED="

rem --- applications -------------------------------------------------------------

if /i "!DO_NODE!"=="Y" call :winget "Node.js 24 LTS" "OpenJS.NodeJS.LTS"
if /i "!DO_GIT!"=="Y" call :winget "Git" "Git.Git"
if /i "!DO_OBSIDIAN!"=="Y" call :winget "Obsidian" "Obsidian.Obsidian"
if /i "!DO_CLAUDE!"=="Y" call :claudecode

rem Anything installed above landed on the PATH of new shells, not this one.
call :refreshpath
call :detect

rem --- the project ---------------------------------------------------------------

if /i "!DO_CONFIG!"=="Y" (
  if exist "scraper\config.json" (
    echo  [skip] scraper\config.json already exists - left alone.
  ) else (
    copy /y "scraper\config.example.json" "scraper\config.json" >nul
    if errorlevel 1 (
      echo  [FAIL] could not create scraper\config.json
      set "FAILED=1"
    ) else (
      echo  [ok]   scraper\config.json created.
    )
  )
  echo.
)

if /i "!DO_PLUGINS!"=="Y" (
  echo  Downloading the three Obsidian plugins into JobVault\.obsidian\plugins ...
  call :getplugin "buttons" "shabegom/buttons"
  call :getplugin "obsidian-shellcommands" "Taitava/obsidian-shellcommands"
  call :getplugin "obsidian-meta-bind-plugin" "mProjectsCode/obsidian-meta-bind-plugin"
  echo.
)

if /i "!DO_NPM!"=="Y" (
  if "!HAVE_NODE!"=="" (
    echo  [FAIL] npm install needs Node.js. Close this window, open a new one
    echo         and run this script again - a fresh install of Node is only on
    echo         the PATH of terminals opened after it.
    set "FAILED=1"
  ) else (
    echo  Running npm install in scraper\ - this fetches Playwright and Chromium,
    echo  so it takes a few minutes.
    echo.
    pushd scraper
    call npm install
    if errorlevel 1 (
      echo  [FAIL] npm install failed.
      set "FAILED=1"
    ) else (
      echo  [ok]   project dependencies installed.
    )
    popd
  )
  echo.
)

if /i "!DO_VAULT!"=="Y" (
  if "!HAVE_NODE!"=="" (
    echo  [skip] the vault needs Node.js - run this script again once it is in.
  ) else (
    echo  Scaffolding the vault...
    pushd scraper
    call npm run --silent vault
    if errorlevel 1 (
      echo  [FAIL] the vault build failed.
      set "FAILED=1"
    ) else (
      echo  [ok]   JobVault is ready.
    )
    popd
  )
  echo.
)

rem --- what to do next ------------------------------------------------------------

echo  ---- Done -------------------------------------------------
echo.
if defined FAILED (
  echo  Something above did not work. The messages marked [FAIL] say what.
  echo  README.md has a direct download link for every dependency.
) else (
  echo  Everything you asked for went in.
)
echo.
echo  Next:
echo.
echo    1. Open a NEW terminal - anything installed just now is only on the
echo       PATH of shells started after it.
echo    2. cd scraper
echo    3. npm run scrape -- --sources noorderlink,remotive --max-pages 1
echo    4. Open the JobVault folder as a vault in Obsidian. Turn off Restricted
echo       mode, enable Buttons, Shell commands and Meta Bind under Community
echo       plugins, then open Profile\Scraper.md - that is the control panel.
echo.
echo  Do not smoke-test with Indeed: it drives a real Chromium, a full sweep is
echo  about half an hour, and hammering it earns you a temporary block.
echo.
pause
endlocal
exit /b 0

rem ===========================================================================
rem  Subroutines
rem ===========================================================================

:detect
rem Sets HAVE_* (1 or empty), S_* (a line for the table) and SUGGEST_* (Y/N).
set "HAVE_NODE="
set "HAVE_GIT="
set "HAVE_OBSIDIAN="
set "HAVE_CLAUDE="
set "HAVE_WINGET="

where winget >nul 2>&1 && set "HAVE_WINGET=1"
where git >nul 2>&1 && set "HAVE_GIT=1"
where claude >nul 2>&1 && set "HAVE_CLAUDE=1"

set "NODEVER="
set "NODEMAJOR=0"
for /f "usebackq tokens=* delims=v" %%v in (`node --version 2^>nul`) do set "NODEVER=%%v"
if defined NODEVER for /f "tokens=1 delims=." %%m in ("!NODEVER!") do set "NODEMAJOR=%%m"
if !NODEMAJOR! GEQ 20 set "HAVE_NODE=1"

if exist "%LOCALAPPDATA%\Obsidian\Obsidian.exe" set "HAVE_OBSIDIAN=1"
if exist "%PROGRAMFILES%\Obsidian\Obsidian.exe" set "HAVE_OBSIDIAN=1"

if "!HAVE_WINGET!"=="1" (set "S_WINGET=found") else (set "S_WINGET=MISSING")
if "!HAVE_GIT!"=="1" (set "S_GIT=found") else (set "S_GIT=missing")
if "!HAVE_CLAUDE!"=="1" (set "S_CLAUDE=found") else (set "S_CLAUDE=missing")
if "!HAVE_OBSIDIAN!"=="1" (set "S_OBSIDIAN=found") else (set "S_OBSIDIAN=missing")
if "!HAVE_NODE!"=="1" (
  set "S_NODE=found - v!NODEVER!"
) else (
  if defined NODEVER (
    set "S_NODE=v!NODEVER! - TOO OLD, needs 20+"
  ) else (
    set "S_NODE=missing"
  )
)

if exist "scraper\node_modules\playwright" (
  set "S_MODULES=installed"
  set "SUGGEST_NPM=N"
) else (
  set "S_MODULES=missing"
  set "SUGGEST_NPM=Y"
)
if exist "scraper\config.json" (
  set "S_CONFIG=present"
  set "SUGGEST_CONFIG=N"
) else (
  set "S_CONFIG=missing"
  set "SUGGEST_CONFIG=Y"
)
if exist "JobVault\.obsidian\plugins\obsidian-shellcommands\main.js" (
  set "S_PLUGINS=installed"
  set "SUGGEST_PLUGINS=N"
) else (
  set "S_PLUGINS=missing"
  set "SUGGEST_PLUGINS=Y"
)

if "!HAVE_NODE!"=="1" (set "SUGGEST_NODE=N") else (set "SUGGEST_NODE=Y")
if "!HAVE_GIT!"=="1" (set "SUGGEST_GIT=N") else (set "SUGGEST_GIT=Y")
if "!HAVE_OBSIDIAN!"=="1" (set "SUGGEST_OBSIDIAN=N") else (set "SUGGEST_OBSIDIAN=Y")
if "!HAVE_CLAUDE!"=="1" (set "SUGGEST_CLAUDE=N") else (set "SUGGEST_CLAUDE=N")
goto :eof

:ask
rem %1 = question, %2 = suggested answer. Leaves it in ANSWER.
set "ANSWER="
set /p "ANSWER=  %~1? [%~2] "
if not defined ANSWER set "ANSWER=%~2"
if /i "!ANSWER:~0,1!"=="y" (set "ANSWER=Y") else (set "ANSWER=N")
goto :eof

:winget
rem %1 = human name, %2 = winget package id
echo  Installing %~1 ...
winget install --id %~2 -e --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
if errorlevel 1 (
  echo  [FAIL] winget could not install %~1. It may already be installed, or
  echo         the install needs to be run by hand - see README.md for a link.
  set "FAILED=1"
) else (
  echo  [ok]   %~1 installed.
)
echo.
goto :eof

:claudecode
rem The native installer, which keeps itself updated. winget as the fallback.
echo  Installing Claude Code ...
curl -fsSL https://claude.ai/install.cmd -o "%TEMP%\claude-install.cmd"
if errorlevel 1 (
  echo  Could not download the installer, trying winget instead...
  if "!HAVE_WINGET!"=="1" (
    call :winget "Claude Code" "Anthropic.ClaudeCode"
  ) else (
    echo  [FAIL] no way to install Claude Code here. See README.md.
    set "FAILED=1"
  )
  goto :eof
)
call "%TEMP%\claude-install.cmd"
if errorlevel 1 (
  echo  [FAIL] the Claude Code installer reported an error.
  set "FAILED=1"
) else (
  echo  [ok]   Claude Code installed. Run "claude" in a new terminal to log in.
  echo         It needs a Pro, Max, Team or Console account.
)
del "%TEMP%\claude-install.cmd" >nul 2>&1
echo.
goto :eof

:getplugin
rem %1 = plugin folder name, %2 = owner/repo. Settings are already in the repo;
rem this only fetches the plugin build, which is not ours to redistribute.
set "PDIR=JobVault\.obsidian\plugins\%~1"
if not exist "!PDIR!" mkdir "!PDIR!"
curl -fsSL -o "!PDIR!\main.js" "https://github.com/%~2/releases/latest/download/main.js"
if errorlevel 1 (
  echo  [FAIL] %~1 - download failed. Install it from Obsidian's community
  echo         plugin browser instead; your settings for it are kept either way.
  set "FAILED=1"
  goto :eof
)
curl -fsSL -o "!PDIR!\manifest.json" "https://github.com/%~2/releases/latest/download/manifest.json"
curl -fsSL -o "!PDIR!\styles.css" "https://github.com/%~2/releases/latest/download/styles.css"
echo  [ok]   %~1
goto :eof

:refreshpath
rem Pick up PATH changes made by the installers above, so the npm steps in this
rem same window can find node. The doubled %% forces a second expansion pass so
rem entries written as %%SystemRoot%%\... resolve.
for /f "usebackq tokens=2,*" %%A in (`reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul`) do set "SYSPATH=%%B"
for /f "usebackq tokens=2,*" %%A in (`reg query "HKCU\Environment" /v Path 2^>nul`) do set "USERPATH=%%B"
if defined SYSPATH call set "PATH=%%SYSPATH%%;%%USERPATH%%"
goto :eof
