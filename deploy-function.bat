@echo off
start cmd /k "cd /d %~dp0src && echo Desplegando desde: %CD% && npx supabase functions deploy analizar-comprobante --project-ref oyqmowolwwjjuarxttuh"
