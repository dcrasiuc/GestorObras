-- ============================================================================
-- Separar "requiere pólizas" de "requiere garantía de OFERTA para licitar"
-- gestor-obras — septiembre 2026
-- ============================================================================
-- Hasta ahora `obras.requiere_poliza` hacía dos trabajos a la vez: (1) decidir si la obra se
-- rastrea en Seguros, y (2) decidir si la obra tiene que esperar en etapa "oferta" hasta que se
-- cargue una garantía y se la marque adjudicada. Esto se rompía en un caso real: una obra puede
-- requerir pólizas (Responsabilidad Civil, seguro de obra, etc. una vez en marcha) sin haber
-- pasado por una licitación con garantía de oferta — por ejemplo una adjudicación directa. Esa
-- obra no tiene ninguna licitación de la que depender, así que no debería quedar trabada en
-- "oferta" esperando algo que nunca va a pasar.
--
-- Se agrega una segunda columna, independiente de `requiere_poliza`:
--   - `requiere_poliza`            → sigue siendo el interruptor general: ¿esta obra se rastrea
--                                     en Seguros? (si es false, queda totalmente afuera)
--   - `requiere_garantia_oferta`   → NUEVA. Solo tiene sentido si `requiere_poliza` es true.
--                                     ¿Esta obra depende de ganar una licitación con garantía de
--                                     oferta antes de poder arrancar? Si es true, la obra arranca
--                                     en etapa "oferta" (no aparece en gastos/finanzas hasta
--                                     adjudicarse). Si es false (adjudicación directa u otro caso
--                                     sin licitación), arranca directo en "ejecución" — igual va a
--                                     poder cargársele cualquier otra póliza puntual (RC, seguro de
--                                     obra, etc.) desde Seguros cuando corresponda, simplemente no
--                                     bloquea el arranque.
--
-- Default TRUE para no cambiar el comportamiento de ninguna obra ya cargada (todas las que hoy
-- requieren póliza van a seguir requiriendo también garantía de oferta, que es el caso más común:
-- licitación pública). Ver `ModalObraCompartido.jsx` (`etapaInicial`) para la lógica combinada.
--
-- Corré este bloque en el SQL Editor del dashboard de Supabase.
-- ============================================================================

BEGIN;

ALTER TABLE public.obras
  ADD COLUMN IF NOT EXISTS requiere_garantia_oferta BOOLEAN NOT NULL DEFAULT true;

COMMIT;

-- ============================================================================
-- Verificación rápida (opcional):
-- select nombre, etapa, requiere_poliza, requiere_garantia_oferta from public.obras order by nombre;
-- ============================================================================
