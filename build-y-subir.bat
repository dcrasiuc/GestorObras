@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   GESTOR DE OBRAS - Build y subida a GitHub
echo ============================================
echo.

echo [1/3] Compilando (npm run build)...
call npm run build
if errorlevel 1 (
  echo.
  echo [ERROR] El build fallo. No se sube nada a GitHub.
  echo Revisa el error de arriba, corregi y volve a correr este archivo.
  echo.
  pause
  exit /b 1
)

echo.
echo [OK] Build terminado sin errores.
echo.

git add -A

set "MSG="
set /p MSG="Mensaje del commit (Enter para uno automatico): "
if "%MSG%"=="" set "MSG=Actualizacion %date% %time%"

git commit -m "%MSG%"
if errorlevel 1 (
  echo.
  echo [INFO] No habia cambios nuevos para commitear, o el commit no se pudo crear.
  echo Se intenta el push igual, por si hay commits pendientes de antes.
)

echo.
echo [2/3] Subiendo a GitHub (git push origin main)...
git push origin main
if errorlevel 1 (
  echo.
  echo [ERROR] El push fallo. Revisa el error de arriba ^(conexion, credenciales, conflictos, etc.^).
  echo.
  pause
  exit /b 1
)

echo.
echo [3/3] Listo. Cloudflare Pages va a desplegar la version nueva automaticamente en unos minutos.
echo.
pause
