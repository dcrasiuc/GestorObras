@echo off
cd /d C:\Users\dcras\gestor-obras
git add src/CuentaCorriente.jsx src/GestorObras.jsx src/main.jsx src/constants.js src/toast.js src/utils.js src/supabaseClient.js .github/workflows/deploy.yml
git commit -m "fix: gastos optimizado, deploy automatico, try/catch en hooks"
git push origin main
echo.
echo [OK] Subido a GitHub. Cloudflare despliega automaticamente.
pause
