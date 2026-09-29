-- ============================================================================
-- Pólizas en dólares (USD) — moneda y tipo de cambio
-- gestor-obras — septiembre 2026
-- ============================================================================
-- Pedido explícito del usuario: algunas pólizas (ej. RC de obras EBY) vienen en dólares, no en
-- pesos. `polizas.monto_asegurado`/`polizas.prima` y `renovaciones_poliza.monto` se siguen cargando
-- SIEMPRE en la moneda original del documento (nunca se convierten al guardar) — lo que agregamos
-- acá es de qué moneda se trata, y el tipo de cambio (+ su fecha) usado para poder mostrar el
-- equivalente en pesos en la cuenta corriente. El tipo de cambio se busca automático (oficial del
-- día, vía una API que replica el oficial de Banco Nación) pero SIEMPRE queda editable a mano antes
-- de guardar — mismo principio anti-alucinación que ya existe con `prima_fuente`: nunca un número
-- sin que el usuario lo pueda verificar/corregir.
--
-- Cada MOVIMIENTO se convierte con el tipo de cambio de SU PROPIO día (no uno solo fijado en la
-- emisión de la póliza): la prima original usa `polizas.tipo_cambio`/`fecha_tipo_cambio` (cargado
-- junto con la prima, en la emisión); cada renovación por período trae el suyo propio en
-- `renovaciones_poliza.tipo_cambio`/`fecha_tipo_cambio`, porque puede pasar bastante tiempo entre
-- una renovación y otra y el dólar puede haber cambiado. Los pagos (`pagos_poliza`) NO llevan
-- moneda/tipo de cambio propios — son pesos reales que salieron del banco, no hace falta convertir
-- nada ahí.
--
-- Corré este bloque en el SQL Editor del dashboard de Supabase.
-- ============================================================================

BEGIN;

ALTER TABLE public.polizas
  ADD COLUMN IF NOT EXISTS moneda TEXT NOT NULL DEFAULT 'ARS' CHECK (moneda IN ('ARS', 'USD')),
  ADD COLUMN IF NOT EXISTS tipo_cambio NUMERIC,
  ADD COLUMN IF NOT EXISTS fecha_tipo_cambio DATE;

ALTER TABLE public.renovaciones_poliza
  ADD COLUMN IF NOT EXISTS tipo_cambio NUMERIC,
  ADD COLUMN IF NOT EXISTS fecha_tipo_cambio DATE;

COMMIT;

-- ============================================================================
-- Verificación rápida (opcional):
-- select nro_poliza, moneda, prima, tipo_cambio, fecha_tipo_cambio from public.polizas limit 20;
-- ============================================================================
