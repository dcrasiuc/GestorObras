-- ============================================================================
-- Índices en columnas de FK — Obras/Seguros más lentos al editar (setiembre 2026)
-- gestor-obras
-- ============================================================================
-- Reporte del usuario: después de vincular Obras y Seguros, ambas hojas quedaron más lentas,
-- sobre todo al guardar una edición. Revisando el repo, NINGUNA columna de FK tiene un índice
-- creado explícitamente (Postgres solo indexa automáticamente el lado "uno" de la relación —la
-- primary key referenciada—, nunca el lado "muchos" que es el que se usa para buscar/unir).
--
-- Esto no rompía nada con pocas filas, pero cada vez que:
--   - se recarga `obras_resumen` (pasa después de CADA alta/edición de obra, vía `recargarObras()`
--     en GestorObras.jsx) — esa vista suma `total_gastado`/`cant_gastos` agrupando `gastos` por
--     obra, un full scan de `gastos` por cada obra si `gastos.obra_id` no tiene índice.
--   - se abre la pestaña Seguros — `usePolizas()` hace `select('*, obras(...), poliza_documentos(*)')`
--     (join sin índice en `polizas.obra_id` ni en `poliza_documentos.poliza_id`) y
--     `useObrasSeguros()` hace `select('*, clientes(nombre)')` (join sin índice en `obras.cliente_id`).
-- ...la base tiene que revisar fila por fila en vez de ir directo — y esto empeora a medida que
-- crecen `gastos`/`polizas`/`pagos_poliza`.
--
-- CREATE INDEX (sin CONCURRENTLY, tablas chicas todavía — un bloqueo de un instante es aceptable)
-- es 100% seguro: no cambia ningún dato ni comportamiento, solo acelera las búsquedas. Se puede
-- correr las veces que haga falta (IF NOT EXISTS).
--
-- Corré este bloque en el SQL Editor del dashboard de Supabase.
-- ============================================================================

BEGIN;

-- Gastos por obra — el más importante: lo usa `obras_resumen` (se recalcula en cada alta/edición
-- de obra) y todo el prorrateo de gastos generales.
CREATE INDEX IF NOT EXISTS idx_gastos_obra_id ON public.gastos(obra_id);

-- Distribución multi-obra de un gasto/remito (comprobante_obras.referencia_id + tipo, y su propio
-- obra_id si lo tiene) — usado por `imputaciones()` en GestorObras.jsx.
CREATE INDEX IF NOT EXISTS idx_comprobante_obras_referencia ON public.comprobante_obras(referencia_id, tipo);
CREATE INDEX IF NOT EXISTS idx_comprobante_obras_obra_id ON public.comprobante_obras(obra_id);

-- Asignación de obras a usuarios no-admin — `useObras()` filtra por usuario_id primero.
CREATE INDEX IF NOT EXISTS idx_obra_usuarios_usuario_id ON public.obra_usuarios(usuario_id);
CREATE INDEX IF NOT EXISTS idx_obra_usuarios_obra_id ON public.obra_usuarios(obra_id);

-- Cliente vinculado a la obra — join usado en Seguros (`useObrasSeguros`) y en los dropdowns de
-- cliente del modal unificado.
CREATE INDEX IF NOT EXISTS idx_obras_cliente_id ON public.obras(cliente_id);

-- Pólizas por obra — el corazón de Seguros: se consulta en cada carga de la pestaña y en cada
-- chequeo de "¿esta obra ya tiene póliza?" (`obrasSinGarantiaAdjudicada`, filtro "sin póliza", etc.)
CREATE INDEX IF NOT EXISTS idx_polizas_obra_id ON public.polizas(obra_id);

-- Documentos y pagos por póliza — joins de `usePolizas()` y de la cuenta corriente.
CREATE INDEX IF NOT EXISTS idx_poliza_documentos_poliza_id ON public.poliza_documentos(poliza_id);
CREATE INDEX IF NOT EXISTS idx_pagos_poliza_poliza_id ON public.pagos_poliza(poliza_id);
CREATE INDEX IF NOT EXISTS idx_pagos_poliza_gasto_id ON public.pagos_poliza(gasto_id);
CREATE INDEX IF NOT EXISTS idx_renovaciones_poliza_poliza_id ON public.renovaciones_poliza(poliza_id);

COMMIT;

-- ============================================================================
-- Verificación rápida (opcional) — confirma que los índices quedaron creados:
-- select tablename, indexname from pg_indexes where schemaname = 'public' and indexname like 'idx_%' order by tablename;
-- ============================================================================
