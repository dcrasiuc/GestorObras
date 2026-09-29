-- ============================================================================
-- Tabla configuracion_app — valores editables desde la app, sin tocar código
-- gestor-obras — septiembre 2026
-- ============================================================================
-- Primer uso: el umbral de "días de aviso" con el que Seguros decide si una
-- póliza/renovación está "por vencer" (antes era una constante fija en el
-- código, DIAS_AVISO_VENCIMIENTO = 30; ahora se puede cambiar desde la propia
-- pantalla de Seguros → 💳 Cuenta corriente, vía useConfiguracionSeguros() en
-- Seguros.jsx). Es clave/valor genérica para poder reusarla en el futuro para
-- otros valores configurables sin crear una tabla nueva cada vez.
--
-- RLS: sigue el mismo patrón ya fijado en CLAUDE.md ("Seguridad: Row Level
-- Security (RLS)") — política única "solo_autenticados", TO authenticated
-- (nunca a public/anon), USING(true) WITH CHECK(true).
--
-- Corré este bloque en el SQL Editor del dashboard de Supabase.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.configuracion_app (
  clave         TEXT PRIMARY KEY,
  valor         TEXT NOT NULL,
  descripcion   TEXT,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.configuracion_app ENABLE ROW LEVEL SECURITY;

CREATE POLICY "solo_autenticados" ON public.configuracion_app
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

INSERT INTO public.configuracion_app (clave, valor, descripcion)
VALUES (
  'dias_aviso_vencimiento_seguros',
  '30',
  'Días de anticipación con los que Seguros avisa que una póliza (o su próximo corte de renovación) está "por vencer". Editable desde Seguros → 💳 Cuenta corriente.'
)
ON CONFLICT (clave) DO NOTHING;

COMMIT;

-- ============================================================================
-- Verificación rápida (opcional):
-- select * from public.configuracion_app;
-- ============================================================================
