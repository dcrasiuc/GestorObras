-- ============================================================================
-- FIX DE SEGURIDAD — RLS abierta a "public" (incluye anon, sin login)
-- gestor-obras — septiembre 2026
-- ============================================================================
-- Confirmado con "select * from pg_policies where schemaname='public'":
-- todas las tablas de abajo tienen HOY una política que aplica a "public"
-- (o sea, también a alguien SIN sesión, usando solo la clave anon pública)
-- con USING(true)/WITH CHECK(true) — acceso total sin login.
--
-- El fix NO toca la lógica de las políticas (USING/WITH CHECK se dejan
-- exactamente igual) — solo les saca el permiso al rol "public"/anon y
-- las deja aplicando SOLO a "authenticated". Como toda la app siempre
-- exige login (Login.jsx, no hay ninguna pantalla pública), esto no debería
-- cambiar nada para el uso normal — solo cierra el acceso a quien no está
-- logueado (por ejemplo, alguien que sacó la clave anon del bundle JS público
-- de la app y le pega directo a la API de Supabase sin loguearse).
--
-- Corré este bloque primero en el SQL Editor del dashboard de Supabase.
-- Es reversible: si algo se rompe, correr de nuevo con "TO public" en vez
-- de "TO authenticated" deja todo como estaba.
-- ============================================================================

BEGIN;

-- Tablas donde esta es la ÚNICA política (nunca se creó la versión
-- "solo_autenticados" — quedaron con la política original, abierta)
ALTER POLICY "acceso cc_pago_items"       ON public.cc_pago_items       TO authenticated;
ALTER POLICY "acceso cc_pagos"            ON public.cc_pagos            TO authenticated;
ALTER POLICY "acceso comprobante_obras"   ON public.comprobante_obras   TO authenticated;
ALTER POLICY "acceso factura_remitos"     ON public.factura_remitos     TO authenticated;
ALTER POLICY "acceso obra_usuarios"       ON public.obra_usuarios       TO authenticated;
ALTER POLICY "acceso remito_items"        ON public.remito_items        TO authenticated;
ALTER POLICY "acceso remitos"             ON public.remitos             TO authenticated;
ALTER POLICY "allow_all_usuarios_crm"     ON public.usuarios_crm        TO authenticated;

-- bancos: dos políticas separadas (una de escritura, una de lectura),
-- las dos abiertas a public — se cierran las dos a authenticated.
ALTER POLICY "admin modifica bancos"      ON public.bancos              TO authenticated;
ALTER POLICY "todos leen bancos"          ON public.bancos              TO authenticated;

-- pagos: las políticas de UPDATE/INSERT/DELETE ya están bien protegidas
-- (verifican usuarios.rol='admin' vía auth.uid(), así que un anon ya
-- fallaba ese chequeo). PERO "todos leen pagos" es un SELECT sin ningún
-- chequeo — cualquiera sin login podía leer el historial de pagos completo.
-- Esta es la que este script cierra.
ALTER POLICY "todos leen pagos"           ON public.pagos                TO authenticated;

-- gastos y obras: ya tienen la política correcta "solo_autenticados"
-- (creada según lo documentado en CLAUDE.md) — pero quedó ADEMÁS la
-- política vieja "acceso total ..." abierta a public al lado, que
-- neutralizaba a la correcta (Postgres combina políticas RLS con OR,
-- así que alcanza con que una sea permisiva). Se elimina la vieja;
-- la protección real queda a cargo de "solo_autenticados", que no se toca.
DROP POLICY "acceso total gastos" ON public.gastos;
DROP POLICY "acceso total obras"  ON public.obras;

COMMIT;

-- ============================================================================
-- Verificación rápida (opcional) — no debería quedar ninguna fila con "public"
-- salvo pagos/usuarios_obras con su propio chequeo interno de auth.uid():
--
-- select tablename, policyname, cmd, roles
-- from pg_policies
-- where schemaname = 'public' and roles = '{public}'::name[];
-- ============================================================================


-- ============================================================================
-- BLOQUE 2 — función, vista y storage (correr aparte, después de confirmar
-- que el bloque de arriba funcionó bien)
-- ============================================================================
-- Estos cambios son igual de conservadores (solo se achica el alcance,
-- no se toca la lógica), pero los separo en su propia transacción para
-- que si algún nombre de política de storage no coincide exacto y tira
-- error, no arrastre para atrás los fixes de la tabla de arriba (que ya
-- están confirmados 100% contra la base real).
-- ============================================================================

BEGIN;

-- get_auth_users_sin_perfil(): la usa el panel de administración de usuarios
-- (GestorObras.jsx, línea ~2118) mientras el usuario está logueado — por eso
-- se le saca el permiso solo a "anon", NUNCA a "authenticated" (si se le
-- sacara a authenticated también, ese panel deja de cargar la lista de
-- usuarios pendientes de perfil).
ALTER FUNCTION public.get_auth_users_sin_perfil() SET search_path = public;
REVOKE EXECUTE ON FUNCTION public.get_auth_users_sin_perfil() FROM anon;

-- obras_resumen: vista SECURITY DEFINER — hace que la vista ignore las
-- políticas RLS de las tablas que usa por debajo (corre siempre con los
-- permisos de quien la creó, no de quien consulta). security_invoker=on
-- la vuelve a comportamiento normal: usa los permisos del usuario que
-- consulta, como cualquier otra tabla/vista.
ALTER VIEW public.obras_resumen SET (security_invoker = on);

-- Storage: estos 4 buckets son públicos a propósito (las fotos/PDFs se
-- muestran en la app vía URL pública — eso sigue funcionando igual,
-- una URL pública de un bucket público no pasa por estas políticas).
-- Lo que se cierra es la posibilidad de LISTAR/enumerar todos los
-- archivos del bucket sin estar logueado.
ALTER POLICY "Permitir todo"                ON storage.objects TO authenticated;
ALTER POLICY "acceso comprobantes gastos"   ON storage.objects TO authenticated;
ALTER POLICY "Comprobantes pago públicos"   ON storage.objects TO authenticated;
ALTER POLICY "acceso comprobantes pagos"    ON storage.objects TO authenticated;
ALTER POLICY "acceso polizas documentos"    ON storage.objects TO authenticated;
ALTER POLICY "acceso relevamientos fotos"   ON storage.objects TO authenticated;

COMMIT;
