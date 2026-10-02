import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'
import { C, MEDIOS_PAGO } from './constants'
import { fmt, fmtDec, hoy, dbWrite, fmtFechaAR } from './utils'
import { toast } from './toast'
import { exportarCuentaCorrienteSeguros } from './exportSegurosExcel'
import { ModalObra, etapaInicial } from './ModalObraCompartido'

// ── Constantes propias de Seguros ───────────────────────────────
// Algunas pólizas (ej. RC de obras EBY) vienen en dólares en vez de pesos — ver "Moneda y tipo de
// cambio" más abajo (enPesos, buscarTipoCambioOficial) para cómo se convierten a pesos.
export const MONEDAS = ['ARS', 'USD']
export const MONEDA_LABELS = { ARS: 'Pesos (ARS)', USD: 'Dólares (USD)' }

export const ORGANISMOS = ['IPRODA', 'EBY', 'UCEF', 'MUNI_POSADAS', 'VIALIDAD', 'Privado', 'Otro']
export const ORGANISMO_LABELS = {
  IPRODA: 'IPRODA', EBY: 'Entidad Binacional Yacyretá', UCEF: 'UCEF',
  MUNI_POSADAS: 'Muni. Posadas', VIALIDAD: 'Vialidad Provincial', Privado: 'Privado', Otro: 'Otro',
}

// Nota de experto: "Cumplimiento de Contrato" y "Anticipo Financiero" son dos garantías DISTINTAS
// aunque ambas sean seguros de caución de la misma obra. Cumplimiento garantiza que se ejecute el
// contrato (no se amortiza, se cancela recién al llegar a recepción). Anticipo Financiero garantiza
// la devolución del anticipo que te dio el organismo, y se va reduciendo/cancelando a medida que se
// descuenta de los certificados de obra — un proceso aparte, no ligado a la recepción de obra.
export const TIPOS_COBERTURA = [
  { value: 'mantenimiento_oferta',   label: 'Mantenimiento de Oferta' },
  { value: 'ejecucion_contrato',     label: 'Cumplimiento de Contrato' },
  { value: 'anticipo_financiero',    label: 'Anticipo Financiero' },
  { value: 'fondo_reparo',           label: 'Fondo de Reparo' },
  { value: 'responsabilidad_civil',  label: 'Responsabilidad Civil' },
  { value: 'otro',                   label: 'Otro' },
]
const COBERTURA_LABELS = Object.fromEntries(TIPOS_COBERTURA.map(t => [t.value, t.label]))
// Ícono corto por tipo de cobertura — usado en los badges de un vistazo en la tarjeta de la obra
// (setiembre 2026, pedido del usuario: poder ver qué seguros tiene cargados una obra sin tener que
// expandirla y entrar póliza por póliza).
const COBERTURA_ICONS = {
  mantenimiento_oferta: '📋', ejecucion_contrato: '✅', anticipo_financiero: '💰',
  fondo_reparo: '🔧', responsabilidad_civil: '🛡️', otro: '📎',
}

// Vigencia: "única vez" = válida hasta un hito de obra (no se renueva por plazo);
// "renovable" = vigencia por período fijo (ej. RC anual) que hay que renovar.
export const TIPOS_VIGENCIA = [
  { value: 'unica_vez', label: 'Única vez (hasta un hito de obra)' },
  { value: 'renovable', label: 'Renovable (vigencia por período fijo)' },
]
const VIGENCIA_LABELS = Object.fromEntries(TIPOS_VIGENCIA.map(t => [t.value, t.label]))

// Cláusula de repetición: si la aseguradora renuncia o no a repetir contra el asegurado/tomador.
export const CLAUSULAS_REPETICION = [
  { value: 'sin_repeticion', label: 'Sin derecho de repetición' },
  { value: 'con_repeticion', label: 'Con derecho de repetición' },
  { value: 'no_especifica',  label: 'No especifica' },
]
const REPETICION_LABELS = Object.fromEntries(CLAUSULAS_REPETICION.map(t => [t.value, t.label]))

export const TIPOS_DOCUMENTO_POLIZA = [
  { value: 'poliza',           label: 'Póliza' },
  { value: 'cuponera',         label: 'Cuponera de pago' },
  { value: 'factura',          label: 'Factura' },
  { value: 'comprobante_pago', label: 'Comprobante de pago' },
  { value: 'endoso',           label: 'Endoso' },
  { value: 'certificacion',    label: 'Certificación' },
  { value: 'legalizacion',     label: 'Legalización' },
  { value: 'baja_aseguradora', label: 'Confirmación de baja (aseguradora)' },
  { value: 'otro',             label: 'Otro' },
]
const DOC_LABELS = Object.fromEntries(TIPOS_DOCUMENTO_POLIZA.map(t => [t.value, t.label]))

// Estados administrativos de una póliza: activa → baja presentada (le mandamos la recepción de
// obra a la aseguradora pidiendo la baja) → dada de baja (la aseguradora ya la confirmó). "Vencida"
// es un cierre aparte para cuando se venció el plazo sin gestión.
export const ESTADOS_ADMIN_POLIZA = [
  { value: 'activa',          label: 'Activa' },
  { value: 'baja_presentada', label: 'Baja presentada' },
  { value: 'dada_de_baja',    label: 'Dada de baja' },
  { value: 'vencida',         label: 'Vencida' },
]

// Tipos de cobertura donde aplica el mecanismo de auto-renovación por períodos (la aseguradora la
// emite por plazos fijos cortos —90/180 días— y la renueva sola cobrando prima nueva hasta que se
// presente la recepción de obra). Mantenimiento de Oferta NO aplica: es a fecha fija ligada a la
// apertura de la licitación, no hay "recepción" que la corte. Responsabilidad Civil tampoco: es
// renovable anual común, no un caución atado a un hito de obra.
const APLICA_AUTORENOVACION_PERIODOS = ['ejecucion_contrato', 'anticipo_financiero', 'fondo_reparo']

// Por tipo de cobertura, reglas FIJAS de negocio de vigencia / si requiere recepción de obra para
// la baja (confirmado con el usuario, setiembre 2026 — "eso hay que hacerlo al pie de la letra,
// salvo que te diga lo contrario"): NO dependen de lo que diga el documento ni de lo que infiera
// la IA al leerlo — son ciertas siempre para ese tipo de cobertura. Por eso procesarArchivo() las
// aplica DESPUÉS de la IA y las hace ganar por sobre lo que la IA haya leído (ver más abajo); la
// única forma de cambiarlas para una póliza puntual es que el usuario las edite a mano en el paso
// de revisión. Para 'otro' (sin regla fija) sí se respeta lo que haya leído la IA, a falta de algo mejor.
//   - Mantenimiento de Oferta: se da de baja al adjudicarse la obra (o vencer la oferta) — no hay
//     "recepción de obra" que la corte.
//   - Ejecución de Contrato y Fondo de Reparo: se dan de baja recién con la Recepción de obra
//     (provisoria/definitiva) — clásico caución "hasta hito de obra".
//   - Anticipo Financiero: se AMORTIZA progresivamente contra los certificados de avance, pero en
//     la práctica el organismo/aseguradora no tramita la baja definitiva hasta la recepción/final
//     de obra — igual que Ejecución de Contrato (corregido setiembre 2026, antes decía false).
//   - Responsabilidad Civil: renovable por calendario (vigencia anual típica), no atada a ningún
//     hito de obra — se da de baja por vencimiento de plazo, no por recepción.
function inferirVigenciaYFinalObra(tipo_cobertura) {
  switch (tipo_cobertura) {
    case 'mantenimiento_oferta':  return { tipo_vigencia: 'unica_vez', requiere_final_obra: false }
    case 'ejecucion_contrato':    return { tipo_vigencia: 'unica_vez', requiere_final_obra: true }
    case 'anticipo_financiero':   return { tipo_vigencia: 'unica_vez', requiere_final_obra: true }
    case 'fondo_reparo':          return { tipo_vigencia: 'unica_vez', requiere_final_obra: true }
    case 'responsabilidad_civil': return { tipo_vigencia: 'renovable', requiere_final_obra: false }
    default:                      return { tipo_vigencia: null, requiere_final_obra: null }
  }
}

// Revisión tipo "experto": inconsistencias o datos faltantes que conviene chequear. Es un chequeo
// aparte de las alertas administrativas (vencimiento/baja) — acá se marcan errores de carga o datos
// dudosos, con un color distinto (ámbar) para no confundir con las alertas rojas.
function detectarAdvertencias(poliza) {
  const w = []
  if (!poliza.aseguradora) w.push('Falta la aseguradora.')
  if (!poliza.nro_poliza) w.push('Falta el número de póliza.')
  if (!poliza.monto_asegurado || parseFloat(poliza.monto_asegurado) <= 0) w.push('Falta o es inválido el monto asegurado.')
  if (poliza.corredor && poliza.aseguradora && poliza.corredor.trim().toLowerCase() === poliza.aseguradora.trim().toLowerCase()) {
    w.push('El corredor figura igual que la aseguradora — revisá si es un error de carga.')
  }
  if (poliza.fecha_inicio && poliza.fecha_vencimiento && poliza.fecha_vencimiento < poliza.fecha_inicio) {
    w.push('La fecha de vencimiento es anterior a la fecha de inicio de vigencia.')
  }
  if (poliza.tipo_vigencia === 'renovable' && !poliza.fecha_vencimiento) {
    w.push('Es una póliza renovable (vigencia por plazo fijo) pero no tiene fecha de vencimiento cargada.')
  }
  if (poliza.prima && poliza.prima_fuente && !/PRIMA|PREMIO/i.test(poliza.prima_fuente)) {
    w.push(`El monto de prima se extrajo de "${poliza.prima_fuente}" en el documento, no de una etiqueta explícita de "Prima"/"Premio" — verificalo contra la factura o cuponera de la aseguradora antes de darlo por bueno.`)
  }
  if (poliza.moneda === 'USD' && !(parseFloat(poliza.tipo_cambio) > 0)) {
    w.push('Es una póliza en USD sin tipo de cambio cargado — la cuenta corriente no puede convertir sus montos a pesos hasta que se complete.')
  }
  const obra = poliza.obras
  if (obra?.monto_contrato && poliza.monto_asegurado && ['ejecucion_contrato', 'anticipo_financiero', 'fondo_reparo'].includes(poliza.tipo_cobertura)) {
    const ratio = parseFloat(poliza.monto_asegurado) / parseFloat(obra.monto_contrato)
    if (ratio > 0 && ratio < 0.01) w.push('El monto asegurado parece muy bajo respecto al monto de contrato de la obra — revisar.')
  }
  return w
}

// Matching de "obra" detectada por la IA contra las obras ya cargadas. Se separa en dos niveles:
// - match FUERTE (substring exacto de un nombre dentro del otro) → se auto-selecciona.
// - candidatas POSIBLES (comparten una palabra significativa del nombre, o mismo organismo) → no se
//   auto-seleccionan ni se ofrece crear obra nueva sin preguntar antes; se le muestran al usuario
//   para que confirme si es alguna de esas antes de crear una obra (nueva) potencialmente duplicada.
//   Esto evita el caso real que pasó con "8360 Mojones" / "Mojones EBY": la IA leyó un nombre más
//   largo/distinto para la misma obra y, al no matchear, se creó una obra duplicada.
function normalizarTexto(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
}
function nombresRelacionados(a, b) {
  const na = normalizarTexto(a), nb = normalizarTexto(b)
  if (!na || !nb) return false
  const wa = na.split(/[^a-z0-9]+/).filter(w => w.length > 3)
  const wb = new Set(nb.split(/[^a-z0-9]+/).filter(w => w.length > 3))
  return wa.some(w => wb.has(w))
}
function matchFuerteObra(obras, nombreIA) {
  if (!nombreIA) return null
  const n = nombreIA.toLowerCase()
  return obras.find(o => o.nombre.toLowerCase().includes(n) || n.includes(o.nombre.toLowerCase())) || null
}
// Nombre a mostrar para "quién es" una obra: en la práctica casi ninguna obra tiene `organismo`
// cargado (es un campo aparte, propio de Seguros, que nadie completa) — lo que SÍ está cargado casi
// siempre es el cliente vinculado desde el panel de Obras (`obras.cliente_id` → `clientes.nombre`),
// que para obra pública ES el organismo (IPRODA, EBY, USCEPP, etc.) y para obra privada es el cliente
// real. Por eso el cliente vinculado es la fuente primaria acá, `organismo` queda como fallback/legacy.
function nombreOrganismoObra(obra) {
  return obra?.clientes?.nombre?.trim() || (obra?.organismo ? (ORGANISMO_LABELS[obra.organismo] || obra.organismo) : '') || ''
}
function candidatasObra(obras, nombreIA, orgIA, excluirId) {
  return obras.filter(o => o.id !== excluirId && (
    (nombreIA && nombresRelacionados(o.nombre, nombreIA)) ||
    (orgIA && o.organismo === orgIA) ||
    (orgIA && nombresRelacionados(nombreOrganismoObra(o), orgIA))
  ))
}

// ── Estilos compartidos (mismo lenguaje visual que el resto de la app) ──
const inputSt = { width: '100%', padding: '8px 12px', fontSize: 13, fontFamily: "'Outfit', sans-serif", border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface, color: C.text, boxSizing: 'border-box', outline: 'none', colorScheme: 'light' }
const cardSt = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 }
// Botón compacto para iconos/acciones cortas inline (ej. "= saldo" en ModalPagoPoliza, ✏️ editar obra en
// FilaObra) — faltaba esta definición (bug descubierto octubre 2026: "btnIconSt is not defined" rompía
// el modal de Registrar pago en producción apenas alguna póliza tenía saldo pendiente).
const btnIconSt = { padding: '4px 9px', background: C.surface, color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontWeight: 500, fontFamily: "'Outfit', sans-serif", whiteSpace: 'nowrap' }

function Campo({ label, children, style }) {
  return <div style={{ ...style }}><label style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</label>{children}</div>
}
function BtnPrimary({ children, onClick, disabled }) {
  return <button onClick={onClick} disabled={disabled} style={{ padding: '7px 16px', background: disabled ? C.textFaint : C.purple, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: disabled ? 'default' : 'pointer', fontWeight: 600, fontFamily: "'Outfit', sans-serif", whiteSpace: 'nowrap' }}>{children}</button>
}
function BtnSecondary({ children, onClick }) {
  return <button onClick={onClick} style={{ padding: '7px 14px', background: C.surface, color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, cursor: 'pointer', fontWeight: 500, fontFamily: "'Outfit', sans-serif", whiteSpace: 'nowrap' }}>{children}</button>
}
function BtnPeligro({ children, onClick }) {
  return <button onClick={onClick} style={{ padding: '7px 14px', background: '#FFF0F0', color: '#C62828', border: '1px solid #FFDCDC', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontWeight: 500, fontFamily: "'Outfit', sans-serif", whiteSpace: 'nowrap' }}>{children}</button>
}
function Spinner() {
  return <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}><div style={{ width: 24, height: 24, border: `2px solid ${C.border}`, borderTopColor: C.purple, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} /></div>
}
function EmptyState({ texto }) {
  return <div style={{ textAlign: 'center', padding: '40px 20px', color: C.textFaint, fontSize: 13 }}>{texto}</div>
}
function Badge({ bg, color, children }) {
  return <span style={{ background: bg, color, padding: '2px 9px', borderRadius: 99, fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>{children}</span>
}
// Vista previa del archivo (foto o PDF) que se acaba de subir/analizar, para poder comparar contra
// los datos que completó la IA sin salir de la app (setiembre 2026, pedido del usuario — antes solo
// se veía un cartelito "✓ Archivo subido", sin forma de revisar el documento real ahí mismo).
// Prioriza el archivo local recién elegido en esta sesión (más rápido, no depende de red); si no hay
// uno (por ejemplo, editando algo ya guardado) cae a la URL ya almacenada.
function VistaPreviaArchivo({ file, url }) {
  const [objUrl, setObjUrl] = useState(null)
  useEffect(() => {
    if (!file) { setObjUrl(null); return }
    const u = URL.createObjectURL(file)
    setObjUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  const src = objUrl || url
  if (!src) return null
  const esPdf = file ? file.type === 'application/pdf' : /\.pdf(\?|$)/i.test(src)
  // El visor nativo de PDF de Chrome (PDF.js) por defecto muestra su propia barra de herramientas y
  // un panel lateral de miniaturas — ocupa buena parte del ancho y deja la página real chica e
  // ilegible dentro de un recuadro de este tamaño. Los parámetros de fragmento #toolbar=0&navpanes=0
  // se los pasamos al visor para que arranque sin ese panel (el usuario puede reabrirlo con el botón
  // del visor si quiere, pero por defecto queda oculto) y &view=FitH para que la página ocupe todo el
  // ancho disponible en vez de aparecer chica centrada (pedido del usuario, setiembre 2026).
  const srcPdf = esPdf ? `${src}#toolbar=0&navpanes=0&view=FitH` : src
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', background: '#FAFAFA' }}>
      {esPdf
        ? <iframe src={srcPdf} title="Vista previa del documento" style={{ width: '100%', height: 520, border: 'none', display: 'block' }} />
        : <img src={src} alt="Vista previa del documento" style={{ width: '100%', maxHeight: 520, objectFit: 'contain', display: 'block' }} />}
      <div style={{ padding: '6px 10px', borderTop: `1px solid ${C.border}`, background: '#fff', textAlign: 'right' }}>
        <a href={src} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: C.purple, fontWeight: 600, textDecoration: 'none' }}>
          ↗ Abrir en pestaña nueva
        </a>
      </div>
    </div>
  )
}
function EtapaBadge({ etapa }) {
  return etapa === 'oferta' ? <Badge bg="#FFF8ED" color="#8A5200">📋 En oferta</Badge> : <Badge bg={C.greenDim} color={C.green}>🏗️ En ejecución</Badge>
}
function EstadoLicitacionBadge({ estado }) {
  const m = { en_curso: null, recepcion_provisoria: ['#FFF8ED', '#8A5200', 'Recepción Provisoria'], recepcion_definitiva: [C.purpleDim, C.purple, 'Recepción Definitiva'] }
  const v = m[estado]
  if (!v) return null
  return <Badge bg={v[0]} color={v[1]}>{v[2]}</Badge>
}
function EstadoAdminBadge({ estado }) {
  const m = {
    activa:          [C.greenDim, C.green, 'Activa'],
    baja_presentada: ['#FFF8ED', '#8A5200', 'Baja presentada'],
    dada_de_baja:    ['#F3F3F3', '#888', 'Dada de baja'],
    vencida:         ['#FFF0F0', '#C62828', 'Vencida'],
  }
  const v = m[estado] || m.activa
  return <Badge bg={v[0]} color={v[1]}>{v[2]}</Badge>
}
// Días entre hoy y una fecha YYYY-MM-DD (negativo = ya pasó)
function diasHasta(fechaStr) {
  if (!fechaStr) return null
  const d0 = new Date(hoy() + 'T00:00:00')
  const d1 = new Date(fechaStr + 'T00:00:00')
  return Math.round((d1 - d0) / 86400000)
}
// Suma N días a una fecha YYYY-MM-DD y devuelve YYYY-MM-DD — se usa para estimar el próximo corte
// de auto-renovación (fecha_vencimiento + duracion_periodo_dias).
function sumarDias(fechaStr, dias) {
  if (!fechaStr || !dias) return null
  const d = new Date(fechaStr + 'T00:00:00')
  d.setDate(d.getDate() + Number(dias))
  return d.toISOString().slice(0, 10)
}
// Valor de arranque antes de que cargue la configuración editable (ver useConfiguracionSeguros
// más abajo) — nunca se usa como umbral real una vez que la config terminó de cargar.
const DIAS_AVISO_VENCIMIENTO = 30

// Fecha de corte VIGENTE de una póliza: si tiene renovaciones por período no anuladas, es el
// período de la ÚLTIMA (la más reciente) — nunca fecha_vencimiento a secas, que queda desactualizada
// en cuanto la póliza empieza a autorenovarse sola. Si no hay renovaciones (o no se autorenueva),
// es fecha_vencimiento tal cual. Se usa tanto para las alertas como para la cuenta corriente, para
// que las dos vistas coincidan siempre en qué fecha están mirando.
function corteVigentePoliza(poliza, renovaciones) {
  const vigentes = (renovaciones || []).filter(r => r.poliza_id === poliza.id && !r.anulada)
  const ultima = vigentes.slice().sort((a, b) => (b.periodo_hasta || '').localeCompare(a.periodo_hasta || ''))[0]
  return ultima?.periodo_hasta || poliza.fecha_vencimiento
}

// Estado de vencimiento de una póliza contra el umbral configurable de "días de aviso".
function estadoVencimiento(poliza, renovaciones, diasAviso) {
  const corte = corteVigentePoliza(poliza, renovaciones)
  const dias = diasHasta(corte)
  if (dias === null) return { estado: 'sin_fecha', dias: null, corte }
  if (dias < 0) return { estado: 'vencida', dias, corte }
  if (dias <= diasAviso) return { estado: 'por_vencer', dias, corte }
  return { estado: 'vigente', dias, corte }
}

function VencimientoBadge({ fecha, diasAviso = DIAS_AVISO_VENCIMIENTO }) {
  const dias = diasHasta(fecha)
  if (dias === null) return <Badge bg="#F3F3F3" color="#888">Sin vencimiento cargado</Badge>
  if (dias < 0) return <Badge bg="#FFF0F0" color="#C62828">🔴 Vencida hace {Math.abs(dias)}d</Badge>
  if (dias <= diasAviso) return <Badge bg="#FFF8ED" color="#8A5200">🟠 Vence en {dias}d ({fmtFechaAR(fecha)})</Badge>
  return <Badge bg={C.greenDim} color={C.green}>⏳ Vence {fmtFechaAR(fecha)}</Badge>
}

// Badge chico para el estado de PAGO de un movimiento individual (prima o una renovación puntual)
// dentro de la cuenta corriente — ver movimientosPoliza() más abajo.
function EstadoPagoBadge({ estadoPago }) {
  if (estadoPago === 'anulada') return <Badge bg="#F3F3F3" color="#888">Anulada</Badge>
  if (estadoPago === 'pagado') return <Badge bg={C.greenDim} color={C.green}>✅ Pagado</Badge>
  if (estadoPago === 'parcial') return <Badge bg="#FFF8ED" color="#8A5200">◐ Parcial</Badge>
  return <Badge bg="#FFF0F0" color="#C62828">Pendiente de pago</Badge>
}

// ── Moneda y tipo de cambio ───────────────────────────────────
// Algunas pólizas (ej. RC de obras EBY) vienen en dólares. `prima`/`monto_asegurado` de `polizas` y
// `monto` de `renovaciones_poliza` se cargan SIEMPRE en la moneda original del documento (poliza.moneda) —
// nunca se convierten al guardar. `enPesos()` es la única función que calcula el equivalente en pesos,
// y se usa en todos lados donde hace falta sumar/comparar montos (cuenta corriente, alertas, export):
// así el monto original (verificable contra el documento) y el tipo de cambio usado (verificable
// contra la fuente) quedan siempre separados y trazables — mismo principio que `prima_fuente`.
function enPesos(monto, moneda, tipoCambio) {
  const m = parseFloat(monto) || 0
  if (moneda === 'USD') return m * (parseFloat(tipoCambio) || 0)
  return m
}

// Tipo de cambio oficial del día (fuente: dolarapi.com, que replica el oficial de Banco Nación) —
// SIEMPRE se ofrece editable en el formulario antes de guardar (nunca se guarda a ciegas): es un
// punto de partida cómodo, no una verdad indiscutible. Si falla la conexión o el formato de
// respuesta cambia, devuelve null y el usuario completa el valor a mano.
async function buscarTipoCambioOficial() {
  try {
    const resp = await fetch('https://dolarapi.com/v1/dolares/oficial')
    if (!resp.ok) return null
    const data = await resp.json()
    const valor = parseFloat(data?.venta)
    if (!Number.isFinite(valor) || valor <= 0) return null
    return { valor, fecha: (data?.fechaActualizacion || '').slice(0, 10) || hoy() }
  } catch {
    return null
  }
}

function MonedaBadge({ moneda }) {
  if (moneda !== 'USD') return null
  return <Badge bg="#EAF4FF" color="#2D5FA8">💵 USD</Badge>
}
function EndosoBadge({ poliza }) {
  const nEndosos = (poliza.poliza_documentos || []).filter(d => d.tipo === 'endoso').length
  return nEndosos > 0
    ? <Badge bg={C.purpleDim} color={C.purple}>📎 Con endoso ({nEndosos})</Badge>
    : <Badge bg="#F3F3F3" color="#888">Sin endoso</Badge>
}
function VigenciaBadge({ tipo }) {
  if (!tipo) return null
  return tipo === 'renovable'
    ? <Badge bg="#EEF4FF" color="#2D5FA8">♻️ Renovable</Badge>
    : <Badge bg="#F3F3F3" color="#555">🔒 Única vez</Badge>
}
function RepeticionBadge({ clausula }) {
  if (!clausula || clausula === 'no_especifica') return null
  return clausula === 'sin_repeticion'
    ? <Badge bg={C.greenDim} color={C.green}>🛡️ Sin repetición</Badge>
    : <Badge bg="#FFF0F0" color="#C62828">⚠️ Con repetición</Badge>
}
// Caución "hasta la recepción" que en realidad se emite por períodos fijos y se autorenueva sola
// (cobrando prima nueva) mientras no se presente la recepción de obra.
function AutorenovacionBadge({ poliza }) {
  if (!poliza.se_autorenueva) return null
  const periodo = poliza.duracion_periodo_dias ? ` (${poliza.duracion_periodo_dias}d)` : ''
  return <Badge bg="#FFF8ED" color="#8A5200">🔁 Autorenovable{periodo} hasta recepción</Badge>
}

// ── Modal genérico (mismo patrón visual que el resto de la app) ──
function Modal({ title, children, onClose, onGuardar, guardarLabel = 'Guardar', zIndex = 200, wide = false }) {
  const [saving, setSaving] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  const handleGuardar = async () => {
    if (!onGuardar || saving) return
    setSaving(true); setErrMsg('')
    try { await onGuardar() } catch (e) { setErrMsg(e?.message || 'Error al guardar') } finally { setSaving(false) }
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 22, width: '100%', maxWidth: wide ? 620 : 480, maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box', boxShadow: '0 8px 40px rgba(0,0,0,0.12)' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 18 }}>{title}</h3>
        {children}
        {errMsg && <div style={{ marginTop: 10, padding: '8px 12px', background: '#FFF0F0', border: '1px solid #FFCCCC', borderRadius: 8, fontSize: 12, color: '#C62828' }}>⚠ {errMsg}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button style={{ padding: '8px 16px', background: 'transparent', color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }} onClick={onClose}>Cancelar</button>
          {onGuardar && <button disabled={saving} style={{ padding: '8px 20px', background: saving ? C.textFaint : C.purple, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: saving ? 'default' : 'pointer', fontWeight: 600, fontFamily: "'Outfit', sans-serif" }} onClick={handleGuardar}>{saving ? 'Guardando...' : guardarLabel}</button>}
        </div>
      </div>
    </div>
  )
}

// ── Helpers de archivo (mismo patrón que GestorObras.jsx: compresión + IA) ──
function leerBase64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onerror = rej; r.onload = e => res(String(e.target.result).split(',')[1]); r.readAsDataURL(file) })
}
async function _canvasComprimido(file, maxLado = 1600) {
  const objUrl = URL.createObjectURL(file)
  const img = await Promise.race([
    new Promise((res, rej) => { const i = new Image(); i.onerror = () => { URL.revokeObjectURL(objUrl); rej(new Error('img error')) }; i.onload = () => res(i); i.src = objUrl }),
    new Promise((_, rej) => setTimeout(() => { URL.revokeObjectURL(objUrl); rej(new Error('Image load timeout')) }, 20000))
  ])
  URL.revokeObjectURL(objUrl)
  let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height
  if (w > maxLado || h > maxLado) { if (w >= h) { h = Math.round(h * maxLado / w); w = maxLado } else { w = Math.round(w * maxLado / h); h = maxLado } }
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  canvas.getContext('2d').drawImage(img, 0, 0, w, h)
  return canvas
}
async function comprimirImagen(file, maxLado = 1600, calidad = 0.7) {
  const canvas = await _canvasComprimido(file, maxLado)
  return { base64: canvas.toDataURL('image/jpeg', calidad).split(',')[1], mimeType: 'image/jpeg' }
}
async function comprimirImagenBlob(file, maxLado = 1600, calidad = 0.72) {
  const canvas = await _canvasComprimido(file, maxLado)
  return await Promise.race([
    new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/jpeg', calidad)),
    new Promise((_, rej) => setTimeout(() => rej(new Error('toBlob timeout')), 10000))
  ])
}
// Subida directa de documentos (comprobante de pago, endoso, recepción de obra, baja, etc.) — no requiere IA.
async function subirDocumentoStorage(file, carpeta = 'polizas') {
  try {
    let blob = file, ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
    if (file.type === 'application/pdf') {
      if (file.size > 25 * 1024 * 1024) { toast('El PDF es muy pesado (máx ~25 MB).'); return null }
    } else {
      try { blob = await comprimirImagenBlob(file); ext = 'jpg' } catch { /* sube original */ }
    }
    const path = `${carpeta}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
    const intentar = () => Promise.race([
      supabase.storage.from('polizas-documentos').upload(path, blob, { upsert: true }),
      new Promise(r => setTimeout(() => r({ data: null, error: { message: 'timeout' } }), 60000))
    ])
    let res = await intentar()
    // Antes acá no se logueaba nada si Supabase devolvía un error "prolijo" (sin throw) — el toast
    // genérico no alcanzaba para diagnosticar un fallo persistente (ej. cuota de Storage agotada,
    // política de RLS del bucket, sesión vencida). Ahora se loguea el error completo en consola
    // (F12 → Console) Y se muestra el mensaje técnico en el propio toast, para poder mandarlo por
    // captura de pantalla sin tener que abrir las herramientas de desarrollador (setiembre 2026).
    if (res?.error) { console.warn('subirDocumentoStorage (1er intento):', res.error); await new Promise(r => setTimeout(r, 1500)); res = await intentar() }
    if (res?.error) {
      console.error('subirDocumentoStorage: falló tras reintentar:', res.error)
      toast(`No se pudo subir el archivo${res.error?.message ? ` — ${res.error.message}` : ''}. Verificá la conexión e intentá de nuevo.`)
      return null
    }
    return supabase.storage.from('polizas-documentos').getPublicUrl(path).data.publicUrl
  } catch (e) {
    console.error('subirDocumentoStorage:', e)
    toast(`No se pudo subir el archivo${e?.message ? ` — ${e.message}` : ''}.`)
    return null
  }
}

// Normaliza un texto para usarlo en un nombre de archivo (sin espacios ni caracteres raros).
function _nombreArchivoSeguro(txt) {
  return String(txt || '').trim().replace(/\s+/g, '_').replace(/[^\w\-]+/g, '').slice(0, 60) || 'sin_dato'
}

// Descarga TODOS los documentos de una póliza (los de poliza_documentos + los comprobantes de
// pago de pagos_poliza) empaquetados en un único .zip, con cada archivo nombrado
// "{obra}_{nroPoliza}_{tipo}_N.ext" para poder identificarlos sin abrirlos. Usa JSZip cargado
// dinámicamente desde CDN (no hace falta agregarlo como dependencia del proyecto).
async function descargarDocumentosZip(poliza, pagos) {
  const items = []
  ;(poliza.poliza_documentos || []).forEach(d => items.push({ url: d.archivo_url, tipo: d.tipo, nombreOriginal: d.nombre_archivo }))
  ;(pagos || []).filter(p => p.comprobante_url).forEach(p => items.push({ url: p.comprobante_url, tipo: 'comprobante_pago', nombreOriginal: null }))
  if (items.length === 0) { toast('Esta póliza no tiene documentos adjuntos.'); return }
  toast(`Preparando .zip con ${items.length} documento(s)...`)
  let JSZip
  try {
    JSZip = (await import(/* @vite-ignore */ 'https://esm.sh/jszip@3.10.1')).default
  } catch (e) {
    console.warn('descargarDocumentosZip: no se pudo cargar JSZip', e)
    toast('No se pudo preparar el .zip (sin conexión al CDN). Descargá los documentos uno por uno.')
    return
  }
  const zip = new JSZip()
  const obraNombre = _nombreArchivoSeguro(poliza.obras?.nombre)
  const nroPoliza = _nombreArchivoSeguro(poliza.nro_poliza || 's-n')
  let ok = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    try {
      const res = await fetch(it.url)
      if (!res.ok) continue
      const blob = await res.blob()
      const extOriginal = (it.nombreOriginal || it.url).split('?')[0].split('.').pop()
      const ext = extOriginal && extOriginal.length <= 5 ? extOriginal.toLowerCase() : 'bin'
      const tipoLabel = _nombreArchivoSeguro(DOC_LABELS[it.tipo] || it.tipo)
      zip.file(`${obraNombre}_${nroPoliza}_${tipoLabel}_${i + 1}.${ext}`, blob)
      ok++
    } catch (e) { console.warn('descargarDocumentosZip: fallo al descargar', it.url, e) }
  }
  if (ok === 0) { toast('No se pudo descargar ningún documento (revisá la conexión).'); return }
  const contenido = await zip.generateAsync({ type: 'blob' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(contenido)
  a.download = `${obraNombre}_poliza_${nroPoliza}.zip`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
  toast(ok < items.length ? `Zip descargado (${ok}/${items.length} archivos — algunos fallaron).` : 'Zip descargado con todos los documentos.', 'ok')
}

// ── Hooks de datos ───────────────────────────────────────────────
function useObrasSeguros() {
  const [obras, setObras] = useState([])
  const [loading, setLoading] = useState(true)
  // Failsafe de 12s (mismo patrón que useObras/useGastos en GestorObras.jsx): si la lectura de
  // Supabase cuelga o tira una excepción no capturada, el spinner no se queda pensando para siempre.
  const cargar = useCallback(async () => {
    setLoading(true)
    const failsafe = setTimeout(() => setLoading(false), 12000)
    try {
      const { data, error } = await supabase.from('obras').select('*, clientes(nombre)').order('created_at', { ascending: false })
      if (!error && data) setObras(data)
      // Antes un error "prolijo" (sin throw) acá se tragaba en silencio: la lista de obras se
      // quedaba vacía para siempre y no había ninguna pista de por qué (bug reportado octubre 2026:
      // tras volver a iniciar sesión, Seguros mostraba "0 obras" sin explicación, en ningún lado).
      else if (error) { console.error('useObrasSeguros:', error); toast(`No se pudieron cargar las obras — ${error.message || error.code || 'error desconocido'}.`) }
    } catch (e) { console.error(e) }
    clearTimeout(failsafe)
    setLoading(false)
  }, [])
  useEffect(() => { cargar() }, [cargar])
  return { obras, setObras, loading, recargar: cargar }
}

function usePolizas() {
  const [polizas, setPolizas] = useState([])
  const [loading, setLoading] = useState(true)
  const cargar = useCallback(async () => {
    setLoading(true)
    const failsafe = setTimeout(() => setLoading(false), 12000)
    try {
      const { data, error } = await supabase
        .from('polizas')
        // clientes(nombre) agregado acá (setiembre 2026): el comitente real de la obra casi siempre
        // viene del cliente vinculado (obras.cliente_id → clientes.nombre), no del campo `organismo`
        // (legacy, casi nunca cargado) — ver nombreOrganismoObra(). Sin este join, el Excel exportaba
        // la celda "Comitente" vacía para cualquier obra que tuviera cliente vinculado en vez de
        // organismo en texto libre (que es el caso normal).
        .select('*, obras(nombre, organismo, etapa, estado_licitacion, monto_contrato, clientes(nombre)), poliza_documentos(*)')
        .order('created_at', { ascending: false })
      if (!error && data) setPolizas(data)
      else if (error) { console.error('usePolizas:', error); toast(`No se pudieron cargar las pólizas — ${error.message || error.code || 'error desconocido'}.`) }
    } catch (e) { console.error(e) }
    clearTimeout(failsafe)
    setLoading(false)
  }, [])
  useEffect(() => { cargar() }, [cargar])
  return { polizas, setPolizas, loading, recargar: cargar }
}

function usePagosPoliza() {
  const [pagos, setPagos] = useState([])
  const [loading, setLoading] = useState(true)
  const cargar = useCallback(async () => {
    setLoading(true)
    const failsafe = setTimeout(() => setLoading(false), 12000)
    try {
      const { data, error } = await supabase.from('pagos_poliza').select('*').order('fecha_pago', { ascending: false })
      if (!error && data) setPagos(data)
      else if (error) { console.error('usePagosPoliza:', error); toast(`No se pudieron cargar los pagos de pólizas — ${error.message || error.code || 'error desconocido'}.`) }
    } catch (e) { console.error(e) }
    clearTimeout(failsafe)
    setLoading(false)
  }, [])
  useEffect(() => { cargar() }, [cargar])
  return { pagos, setPagos, loading, recargar: cargar }
}

// Renovaciones por período (el lado del CARGO/deuda): cada vez que una póliza con se_autorenueva
// cumple un período sin que se le haya presentado la recepción, la aseguradora renueva sola y
// cobra una prima nueva — que puede diferir de la original por reajuste. Se registra acá, aparte
// de polizas.prima, porque una misma póliza puede acumular varios de estos cargos en el tiempo.
function useRenovacionesPoliza() {
  const [renovaciones, setRenovaciones] = useState([])
  const [loading, setLoading] = useState(true)
  const cargar = useCallback(async () => {
    setLoading(true)
    const failsafe = setTimeout(() => setLoading(false), 12000)
    try {
      const { data, error } = await supabase.from('renovaciones_poliza').select('*').order('periodo_hasta', { ascending: false })
      if (!error && data) setRenovaciones(data)
      else if (error) { console.error('useRenovacionesPoliza:', error); toast(`No se pudieron cargar las renovaciones de pólizas — ${error.message || error.code || 'error desconocido'}.`) }
    } catch (e) { console.error(e) }
    clearTimeout(failsafe)
    setLoading(false)
  }, [])
  useEffect(() => { cargar() }, [cargar])
  return { renovaciones, setRenovaciones, loading, recargar: cargar }
}

function useBancosSeguros() {
  const [bancos, setBancos] = useState([])
  useEffect(() => { supabase.from('bancos').select('*').order('nombre').then(({ data }) => { if (data) setBancos(data) }) }, [])
  return bancos
}

// Lista de clientes para el selector de "Nueva obra" (setiembre 2026 — antes Seguros no pedía
// cliente vinculado al crear una obra, pedía "organismo" en texto libre; ver ModalObraCompartido.jsx).
function useClientesSeguros() {
  const [clientes, setClientes] = useState([])
  useEffect(() => { supabase.from('clientes').select('id, nombre').order('nombre').then(({ data }) => { if (data) setClientes(data) }) }, [])
  return clientes
}

// Proveedores (tabla compartida con Gastos/GestorObras) — Seguros no los consultaba hasta ahora
// porque los gastos que genera (factura/pago de prima) nunca llevaban proveedor_id (reportado por
// el usuario, octubre 2026: en la lista de Gastos esos movimientos aparecían sin proveedor). Acá
// solo se necesita id+nombre para poder encontrar/crear el que corresponda (ver resolverProveedorPoliza).
function useProveedoresSeguros() {
  const [proveedores, setProveedores] = useState([])
  useEffect(() => { supabase.from('proveedores').select('id, nombre').order('nombre').then(({ data }) => { if (data) setProveedores(data) }) }, [])
  return { proveedores, setProveedores }
}

// El proveedor a usar en el gasto que genera una póliza es el corredor/productor si la póliza
// tiene uno cargado, si no la aseguradora (compañía) — en ambos casos son campos de texto libre en
// la póliza (no un vínculo a `proveedores`), por eso hace falta buscar/crear por nombre.
function nombreProveedorPoliza(poliza) {
  return (poliza.corredor?.trim() || poliza.aseguradora?.trim() || '')
}

// Busca `nombre` (sin mayúsculas/espacios) en `cache` o crea un proveedor nuevo con ese nombre. NO
// toca estado de React — devuelve el proveedor (existente o recién creado) y es responsabilidad de
// quien llama actualizar su propia copia de `cache` y, al final, sincronizar el estado una sola vez.
// Esto importa cuando se resuelven varias pólizas en la misma tanda (guardarPagoPoliza con un pago
// que cubre varias pólizas de la misma aseguradora): todas deben ver los proveedores que se van
// creando DENTRO de esa misma tanda, no solo los que ya estaban en el estado al empezar — si no,
// cada póliza de la tanda termina creando su propio proveedor duplicado con el mismo nombre.
async function resolverProveedorPorNombre(nombre, cache) {
  const existente = cache.find(p => p.nombre?.trim().toLowerCase() === nombre.toLowerCase())
  if (existente) return existente
  return await dbWrite('POST', 'proveedores', {
    nombre, rubro: 'Seguros', situacion_impositiva: 'responsable_inscripto', condicion_pago: 'contado', redondear_viernes: true,
  }, null, true)
}

// ── Configuración editable de Seguros (tabla configuracion_app, clave/valor genérica) ──
// Por ahora solo guarda "dias_aviso_vencimiento_seguros" — el umbral con el que se decide si una
// póliza/renovación está "por vencer" (tanto en las alertas como en la cuenta corriente). Antes era
// una constante fija en el código (DIAS_AVISO_VENCIMIENTO); ahora se puede cambiar desde la propia
// app sin tocar código, vía guardarDiasAviso().
function useConfiguracionSeguros() {
  const [diasAviso, setDiasAviso] = useState(DIAS_AVISO_VENCIMIENTO)
  const [loadingConfig, setLoadingConfig] = useState(true)
  useEffect(() => {
    supabase.from('configuracion_app').select('valor').eq('clave', 'dias_aviso_vencimiento_seguros').maybeSingle()
      .then(({ data }) => { if (data?.valor) setDiasAviso(parseInt(data.valor, 10) || DIAS_AVISO_VENCIMIENTO) })
      .finally(() => setLoadingConfig(false))
  }, [])
  const guardarDiasAviso = async (nuevoValor) => {
    const n = parseInt(nuevoValor, 10)
    if (!Number.isFinite(n) || n < 0) { toast('Ingresá un número de días válido (0 o más)'); return }
    await dbWrite('PATCH', 'configuracion_app', { valor: String(n), actualizado_en: new Date().toISOString() }, 'clave=eq.dias_aviso_vencimiento_seguros')
    setDiasAviso(n)
    toast('Aviso de vencimiento actualizado', 'ok')
  }
  return { diasAviso, guardarDiasAviso, loadingConfig }
}

// Pólizas que necesitan atención, con el motivo y la acción sugerida:
// - 'presentar_baja': está activa pero la obra ya avanzó de estado, o el vencimiento ya pasó/está cerca
//   → hay que presentarle la recepción de obra a la aseguradora pidiendo la baja
// - 'confirmar_baja': ya se le presentó la baja a la aseguradora → falta que ELLA la confirme
function calcularAlertas(polizas, renovaciones = [], diasAviso = DIAS_AVISO_VENCIMIENTO) {
  return polizas.map(p => {
    const motivos = []
    let accion = null
    if (p.estado_admin === 'activa') {
      const o = p.obras
      if (o) {
        if (p.tipo_cobertura === 'mantenimiento_oferta' && o.etapa === 'ejecucion') motivos.push('La obra ya fue adjudicada — esta garantía de Mantenimiento de Oferta ya no corresponde.')
        if (p.tipo_cobertura === 'ejecucion_contrato' && (o.estado_licitacion === 'recepcion_provisoria' || o.estado_licitacion === 'recepcion_definitiva')) motivos.push('La obra ya llegó a recepción — esta garantía de Cumplimiento de Contrato ya no corresponde.')
        // Anticipo Financiero se amortiza contra los certificados de obra (no espera a la recepción como
        // Cumplimiento de Contrato) — si la obra ya llegó a recepción definitiva y la póliza sigue activa,
        // lo más probable es que el anticipo ya esté totalmente amortizado y falte gestionar la baja.
        if (p.tipo_cobertura === 'anticipo_financiero' && o.estado_licitacion === 'recepcion_definitiva') motivos.push('La obra llegó a Recepción Definitiva — verificar si el anticipo ya fue totalmente amortizado contra los certificados; de ser así, esta garantía debería estar reducida o cancelada.')
        if (p.tipo_cobertura === 'fondo_reparo' && o.estado_licitacion === 'recepcion_definitiva') motivos.push('La obra llegó a Recepción Definitiva — el Fondo de Reparo ya no corresponde.')
        // Chequeo independiente: la obra está marcada "Finalizada" en el panel principal de Obras
        // (campo obra.estado, de uso diario) aunque en Seguros nunca se haya tramitado formalmente
        // la recepción/baja — es una señal de que puede haber quedado un trámite pendiente.
        if (o.estado === 'finalizada') motivos.push('La obra está marcada como Finalizada en el panel de Obras — revisar si corresponde iniciar el trámite de baja de esta garantía con la aseguradora.')
      }
      // Para pólizas con auto-renovación por períodos, el "corte" vigente no siempre es
      // fecha_vencimiento — si ya se registraron renovaciones (cargos) para períodos posteriores,
      // el corte relevante es el de la última renovación NO anulada.
      const renovacionesDeLaPoliza = renovaciones.filter(r => r.poliza_id === p.id)
      const ultimaRenovacion = renovacionesDeLaPoliza.filter(r => !r.anulada).slice().sort((a, b) => (b.periodo_hasta || '').localeCompare(a.periodo_hasta || ''))[0]
      const corteVigente = corteVigentePoliza(p, renovaciones)
      const dias = diasHasta(corteVigente)
      if (dias !== null) {
        if (p.se_autorenueva) {
          // Caución con auto-renovación por períodos: no es un vencimiento "final", es el corte de
          // un período — si no se presentó la recepción antes, la aseguradora la renueva sola y
          // cobra una prima nueva por el siguiente período (y así sucesivamente).
          if (dias < 0) {
            const proximoCorte = sumarDias(corteVigente, p.duracion_periodo_dias)
            motivos.push(`Se cumplió el período hace ${Math.abs(dias)} día(s) sin presentar la recepción — lo más probable es que la aseguradora ya renovó sola la póliza y cobró una prima nueva${proximoCorte ? ` (próximo corte estimado: ${proximoCorte})` : ''}${ultimaRenovacion ? '' : ' — todavía no registraste ese cargo en el sistema'}. Si conseguís la recepción con fecha anterior al corte vencido, muchas veces se puede anular esa renovación en forma retroactiva y no te cobran esa prima.`)
            accion = 'registrar_renovacion'
          } else if (dias <= diasAviso) {
            motivos.push(`Se autorenueva sola en ${dias} día(s) si no se presenta la recepción antes de esa fecha${p.duracion_periodo_dias ? ` — la aseguradora cobrará una prima nueva por otro período de ${p.duracion_periodo_dias} días` : ''}.`)
          }
        } else {
          if (dias < 0) motivos.push(`Vencida hace ${Math.abs(dias)} día(s).`)
          else if (dias <= diasAviso) motivos.push(`Vence en ${dias} día(s) — gestionar renovación.`)
        }
      }
      if (motivos.length && !accion) accion = 'presentar_baja'
    } else if (p.estado_admin === 'baja_presentada') {
      motivos.push('Ya se presentó la recepción de obra a la aseguradora pidiendo la baja — falta la confirmación firmada por ella.')
      accion = 'confirmar_baja'
    }
    return motivos.length ? { poliza: p, motivos, accion } : null
  }).filter(Boolean)
}

// ── Modal: cargar / editar póliza (foto/PDF + IA "experta") ──────────────────
function ModalPoliza({ obras, obraIdDefecto, polizaExistente, onClose, onGuardar, onCrearObra }) {
  const esEdicion = !!polizaExistente
  const [step, setStep] = useState(esEdicion ? 'review' : 'upload')
  // Archivo local recién elegido (no la URL ya subida) — sirve para la vista previa del paso de
  // revisión (VistaPreviaArchivo), que prioriza mostrar el archivo tal cual lo eligió el usuario.
  const [archivoLocal, setArchivoLocal] = useState(null)
  const [form, setForm] = useState(() => esEdicion ? {
    id: polizaExistente.id,
    obra_id: polizaExistente.obra_id || '',
    tipo_cobertura: polizaExistente.tipo_cobertura || 'ejecucion_contrato',
    aseguradora: polizaExistente.aseguradora || '',
    corredor: polizaExistente.corredor || '',
    nro_poliza: polizaExistente.nro_poliza || '',
    monto_asegurado: polizaExistente.monto_asegurado ?? '',
    prima: polizaExistente.prima ?? '',
    prima_fuente: polizaExistente.prima_fuente || '',
    moneda: polizaExistente.moneda || 'ARS',
    tipo_cambio: polizaExistente.tipo_cambio ?? '',
    fecha_tipo_cambio: polizaExistente.fecha_tipo_cambio || '',
    fecha_emision: polizaExistente.fecha_emision || hoy(),
    fecha_inicio: polizaExistente.fecha_inicio || '',
    fecha_vencimiento: polizaExistente.fecha_vencimiento || '',
    notas: polizaExistente.notas || '',
    tipo_vigencia: polizaExistente.tipo_vigencia || null,
    requiere_final_obra: polizaExistente.requiere_final_obra,
    clausula_repeticion: polizaExistente.clausula_repeticion || 'no_especifica',
    clausulas_especiales: polizaExistente.clausulas_especiales || '',
    descripcion_ia: polizaExistente.descripcion_ia || '',
    se_autorenueva: polizaExistente.se_autorenueva,
    duracion_periodo_dias: polizaExistente.duracion_periodo_dias ?? '',
    archivo_url: '',
  } : {
    obra_id: obraIdDefecto || '', tipo_cobertura: 'ejecucion_contrato', aseguradora: '', corredor: '', nro_poliza: '',
    monto_asegurado: '', prima: '', prima_fuente: '', moneda: 'ARS', tipo_cambio: '', fecha_tipo_cambio: '',
    fecha_emision: hoy(), fecha_inicio: '', fecha_vencimiento: '', notas: '',
    tipo_vigencia: null, requiere_final_obra: null, clausula_repeticion: 'no_especifica', clausulas_especiales: '', descripcion_ia: '',
    se_autorenueva: null, duracion_periodo_dias: '',
    archivo_url: '',
  })
  const [sugerenciaObra, setSugerenciaObra] = useState(null) // { nombre, organismo } si la IA detectó una obra que no matchea ninguna existente y hay que ofrecer crear
  const [candidatasObraIA, setCandidatasObraIA] = useState([]) // obras existentes parecidas — hay que preguntar antes de asumir que es nueva
  const [nombreObraIA, setNombreObraIA] = useState('') // nombre/organismo tal como lo leyó la IA, para mostrar en la pregunta
  const [iaDetectoEndoso, setIaDetectoEndoso] = useState(false)
  const [buscandoTC, setBuscandoTC] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // Busca el tipo de cambio oficial del día y lo precarga (siempre editable después) — se llama al
  // elegir "Dólares (USD)" si todavía no hay un tipo de cambio cargado, y también con el botón
  // "🔄 Oficial hoy" para volver a buscarlo a mano.
  const buscarTC = async () => {
    setBuscandoTC(true)
    const r = await buscarTipoCambioOficial()
    if (r) { set('tipo_cambio', r.valor); set('fecha_tipo_cambio', r.fecha) }
    else toast('No se pudo buscar el tipo de cambio automático — completalo a mano')
    setBuscandoTC(false)
  }
  const setMoneda = (moneda) => {
    setForm(f => ({ ...f, moneda }))
    if (moneda === 'USD' && !form.tipo_cambio) buscarTC()
  }

  // Al cambiar el tipo de cobertura, si todavía no hay vigencia/requiere_final_obra definidos
  // (ni por la IA ni a mano), sugerimos el default de negocio para ese tipo.
  const setTipoCobertura = (tipo) => {
    setForm(f => {
      const next = { ...f, tipo_cobertura: tipo }
      if (f.tipo_vigencia == null && f.requiere_final_obra == null) {
        const inf = inferirVigenciaYFinalObra(tipo)
        next.tipo_vigencia = inf.tipo_vigencia
        next.requiere_final_obra = inf.requiere_final_obra
      }
      return next
    })
  }

  const procesarArchivo = async (file) => {
    setStep('loading')
    setArchivoLocal(file)
    let archivoUrl = ''
    try {
      let base64, mimeType
      if (file.type === 'application/pdf') {
        if (file.size > 25 * 1024 * 1024) { toast('El PDF es muy pesado (máx ~25 MB). Subí uno más liviano.'); setStep('upload'); return }
        base64 = await leerBase64(file); mimeType = 'application/pdf'
      } else {
        try { ({ base64, mimeType } = await comprimirImagen(file)) }
        catch { base64 = await leerBase64(file); mimeType = file.type }
      }
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
      const fnUrl = 'https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante'
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
      const respRaw = await Promise.race([
        fetch(fnUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}` }, body: JSON.stringify({ base64, mimeType, hoy: hoy(), tipoAnalisis: 'poliza' }) }),
        timeout,
      ])
      const data = await respRaw.json()
      const error = !respRaw.ok ? data : null
      archivoUrl = data?.imagen_url || ''
      if (!error && data?.content) {
        const text = data.content.map(i => i.text || '').join('')
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
        const tipoValido = TIPOS_COBERTURA.some(t => t.value === parsed.tipo_cobertura) ? parsed.tipo_cobertura : 'otro'
        // La regla fija por tipo de cobertura GANA por sobre lo que la IA haya leído del documento
        // (setiembre 2026, a pedido del usuario) — solo se respeta la lectura de la IA cuando no
        // hay regla fija para ese tipo (tipo_cobertura 'otro').
        const defaults = inferirVigenciaYFinalObra(tipoValido)
        const tipoVigValida = defaults.tipo_vigencia != null ? defaults.tipo_vigencia : (TIPOS_VIGENCIA.some(t => t.value === parsed.tipo_vigencia) ? parsed.tipo_vigencia : null)
        const requiereFinalObra = defaults.requiere_final_obra != null ? defaults.requiere_final_obra : (typeof parsed.requiere_final_obra === 'boolean' ? parsed.requiere_final_obra : null)
        const clausulaValida = CLAUSULAS_REPETICION.some(t => t.value === parsed.clausula_repeticion) ? parsed.clausula_repeticion : 'no_especifica'
        // Matchear obra: primero un match fuerte (substring exacto) que se auto-selecciona. Si no
        // hay match fuerte, buscamos candidatas posibles (palabra en común / mismo organismo) para
        // preguntarle al usuario en vez de asumir directamente que es una obra nueva.
        const nombreIAOriginal = parsed.obra || ''
        const orgIA = (parsed.organismo || '').toUpperCase()
        const matchObra = matchFuerteObra(obras, nombreIAOriginal)
        const candidatas = matchObra ? [] : candidatasObra(obras, nombreIAOriginal, orgIA)
        setCandidatasObraIA(candidatas)
        const monedaIA = MONEDAS.includes(parsed.moneda) ? parsed.moneda : 'ARS'
        setForm(f => ({
          ...f,
          obra_id: matchObra ? matchObra.id : f.obra_id,
          tipo_cobertura: tipoValido,
          aseguradora: parsed.aseguradora || '',
          corredor: parsed.corredor || '',
          nro_poliza: parsed.nro_poliza || '',
          monto_asegurado: parsed.monto_asegurado || '',
          prima: parsed.prima || '',
          prima_fuente: parsed.prima ? (parsed.prima_fuente || '') : '',
          moneda: monedaIA,
          fecha_emision: parsed.fecha_emision || hoy(),
          fecha_inicio: parsed.fecha_inicio || '',
          fecha_vencimiento: parsed.fecha_vencimiento || '',
          tipo_vigencia: tipoVigValida,
          requiere_final_obra: requiereFinalObra,
          clausula_repeticion: clausulaValida,
          clausulas_especiales: parsed.clausulas_especiales || '',
          descripcion_ia: parsed.descripcion_ia || '',
          se_autorenueva: typeof parsed.se_autorenueva === 'boolean' ? parsed.se_autorenueva : null,
          duracion_periodo_dias: Number.isFinite(parsed.duracion_periodo_dias) ? parsed.duracion_periodo_dias : '',
          archivo_url: archivoUrl,
        }))
        setIaDetectoEndoso(!!parsed.tiene_endoso)
        // La IA solo identifica la MONEDA del documento — el tipo de cambio nunca lo inventa ni lo
        // calcula ella (mismo principio que con "prima"): si detectó USD, buscamos el oficial del
        // día como punto de partida cómodo, siempre editable antes de guardar.
        if (monedaIA === 'USD') buscarTC()
        if (!matchObra && (parsed.obra || parsed.organismo)) {
          setNombreObraIA(parsed.obra || parsed.organismo || '')
          setSugerenciaObra({ nombre: parsed.obra || '', organismo: orgIA && ORGANISMOS.includes(orgIA) ? orgIA : 'Otro' })
        }
      } else {
        setForm(f => ({ ...f, archivo_url: archivoUrl }))
        if (error) toast('IA no disponible — completá los datos manualmente')
      }
    } catch (e) {
      console.error('procesarArchivo poliza error:', e)
      setForm(f => ({ ...f, archivo_url: archivoUrl }))
      toast(e?.message === 'timeout' ? 'IA tardó demasiado — completá los datos manualmente' : 'Error al analizar el archivo — completá los datos manualmente')
    } finally {
      setStep('review')
    }
  }

  const usarSugerencia = async () => {
    const nueva = await onCrearObra({ nombre: sugerenciaObra.nombre, organismo: sugerenciaObra.organismo, monto_contrato: '' })
    if (nueva?.id) { set('obra_id', nueva.id); setSugerenciaObra(null); setCandidatasObraIA([]) }
  }

  return (
    <Modal title={esEdicion ? `Editar póliza ${polizaExistente.nro_poliza || ''}` : 'Cargar póliza'} wide onClose={onClose} guardarLabel={esEdicion ? 'Guardar cambios' : 'Guardar póliza'} onGuardar={step === 'review' ? () => {
      if (!form.obra_id) throw new Error('Elegí a qué obra corresponde la póliza')
      if (form.moneda === 'USD' && (parseFloat(form.monto_asegurado) > 0 || parseFloat(form.prima) > 0) && !(parseFloat(form.tipo_cambio) > 0)) {
        throw new Error('Esta póliza está en USD — ingresá el tipo de cambio (se busca solo, pero hay que confirmarlo)')
      }
      return onGuardar({
        ...form,
        monto_asegurado: parseFloat(form.monto_asegurado) || null,
        prima: parseFloat(form.prima) || null,
        tipo_cambio: form.moneda === 'USD' ? (parseFloat(form.tipo_cambio) || null) : null,
        fecha_tipo_cambio: form.moneda === 'USD' ? (form.fecha_tipo_cambio || null) : null,
      })
    } : null}>
      {step === 'upload' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, border: `1.5px solid ${C.purple}`, borderRadius: 12, padding: '18px 24px', textAlign: 'center', cursor: 'pointer', background: C.purpleDim }}>
            <span style={{ fontSize: 24 }}>📸</span>
            <div><div style={{ fontSize: 14, color: C.purple, fontWeight: 600 }}>Tomar foto con cámara</div><div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>Abre la cámara directamente</div></div>
            <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => e.target.files[0] && procesarArchivo(e.target.files[0])} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, border: `1.5px dashed ${C.border}`, borderRadius: 12, padding: '18px 24px', textAlign: 'center', cursor: 'pointer', background: '#FAFAFA' }}>
            <span style={{ fontSize: 24 }}>🖼️📄</span>
            <div><div style={{ fontSize: 14, color: C.textMuted, fontWeight: 500 }}>Elegir foto o PDF</div><div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>La IA (experta en seguros) completa los datos automáticamente</div></div>
            <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={e => e.target.files[0] && procesarArchivo(e.target.files[0])} />
          </label>
          <button onClick={() => setStep('review')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 12, cursor: 'pointer', marginTop: 4, fontFamily: "'Outfit', sans-serif" }}>Completar manualmente sin subir archivo</button>
        </div>
      )}
      {step === 'loading' && <div style={{ textAlign: 'center', padding: '30px 0' }}><Spinner /><div style={{ fontSize: 13, color: C.textMuted, marginTop: 8 }}>Analizando póliza con IA…</div></div>}
      {step === 'review' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {form.archivo_url && <div style={{ fontSize: 11, color: C.green, background: C.greenDim, padding: '6px 10px', borderRadius: 8 }}>✓ Archivo subido. Revisá y completá los datos detectados.</div>}
          <VistaPreviaArchivo file={archivoLocal} url={form.archivo_url} />
          {iaDetectoEndoso && <div style={{ fontSize: 11, color: C.purple, background: C.purpleDim, padding: '6px 10px', borderRadius: 8 }}>📎 La IA detectó que este documento es un endoso — subilo también como "Endoso" desde "+ Documento" en la póliza una vez guardada.</div>}
          {sugerenciaObra && candidatasObraIA.length > 0 && (
            <div style={{ fontSize: 12, background: '#FFF8ED', color: '#8A5200', padding: '10px 12px', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span>La IA leyó "{nombreObraIA}" — no es un match exacto con ninguna obra cargada, pero se parece a {candidatasObraIA.length === 1 ? 'esta' : 'estas'}. ¿Es alguna de estas la misma obra?</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {candidatasObraIA.map(o => (
                  <BtnSecondary key={o.id} onClick={() => { set('obra_id', o.id); setSugerenciaObra(null); setCandidatasObraIA([]) }}>Sí, es "{o.nombre}"</BtnSecondary>
                ))}
                <BtnSecondary onClick={usarSugerencia}>No, es una obra nueva → + Crear obra</BtnSecondary>
              </div>
            </div>
          )}
          {sugerenciaObra && candidatasObraIA.length === 0 && (
            <div style={{ fontSize: 12, background: C.purpleDim, color: C.purple, padding: '10px 12px', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span>La IA detectó "{sugerenciaObra.nombre || sugerenciaObra.organismo}" pero no encontré ninguna obra parecida ya cargada.</span>
              <BtnSecondary onClick={usarSugerencia}>+ Crear obra</BtnSecondary>
            </div>
          )}
          <Campo label="Obra">
            <select style={inputSt} value={form.obra_id} onChange={e => set('obra_id', e.target.value)}>
              <option value="">-- Elegí una obra --</option>
              {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}{nombreOrganismoObra(o) ? ` (${nombreOrganismoObra(o)})` : ''}{o.etapa === 'oferta' ? ' — en oferta' : ''}</option>)}
            </select>
          </Campo>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Campo label="Tipo de cobertura">
              <select style={inputSt} value={form.tipo_cobertura} onChange={e => setTipoCobertura(e.target.value)}>
                {TIPOS_COBERTURA.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Campo>
            <Campo label="Nro. de póliza"><input style={inputSt} value={form.nro_poliza} onChange={e => set('nro_poliza', e.target.value)} placeholder="Ej. 356622 (o 356622/3 si ya tiene endoso)" /></Campo>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Campo label="Aseguradora (compañía)"><input style={inputSt} value={form.aseguradora} onChange={e => set('aseguradora', e.target.value)} placeholder="Ej. Berkley Argentina Seguros" /></Campo>
            <Campo label="Corredor / Productor"><input style={inputSt} value={form.corredor} onChange={e => set('corredor', e.target.value)} placeholder="Opcional — el broker, si lo hay" /></Campo>
          </div>
          <Campo label="Moneda de la póliza">
            <select style={inputSt} value={form.moneda} onChange={e => setMoneda(e.target.value)}>
              {MONEDAS.map(m => <option key={m} value={m}>{MONEDA_LABELS[m]}</option>)}
            </select>
          </Campo>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Campo label={`Monto asegurado ${form.moneda === 'USD' ? '(U$S)' : '($)'}`}><input type="number" style={inputSt} value={form.monto_asegurado} onChange={e => set('monto_asegurado', e.target.value)} /></Campo>
            <Campo label={`Prima / costo de la póliza ${form.moneda === 'USD' ? '(U$S)' : '($)'}`}>
              <input type="number" style={inputSt} value={form.prima} onChange={e => set('prima', e.target.value)} placeholder="Lo que cobra la aseguradora" />
              {form.prima && (
                /PRIMA|PREMIO/i.test(form.prima_fuente || '')
                  ? <div style={{ fontSize: 10, color: C.textFaint, marginTop: 3 }}>Fuente: "{form.prima_fuente}" en el documento.</div>
                  : <div style={{ fontSize: 10, color: '#8A5200', marginTop: 3 }}>⚠️ {form.prima_fuente ? `Extraído de "${form.prima_fuente}" — no es una etiqueta explícita de prima/premio, verificá contra la factura o cuponera de la aseguradora.` : 'Verificá este monto — no encontré una etiqueta explícita de "Prima"/"Premio" en el documento.'}</div>
              )}
            </Campo>
          </div>
          {form.moneda === 'USD' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'end', background: '#EAF4FF', padding: 10, borderRadius: 10 }}>
              <Campo label="Tipo de cambio oficial ($/US$)"><input type="number" style={inputSt} value={form.tipo_cambio} onChange={e => set('tipo_cambio', e.target.value)} placeholder="Se busca solo, pero podés corregirlo" /></Campo>
              <Campo label="Fecha del TC"><input type="date" style={inputSt} value={form.fecha_tipo_cambio} onChange={e => set('fecha_tipo_cambio', e.target.value)} /></Campo>
              <BtnSecondary onClick={buscarTC}>{buscandoTC ? 'Buscando…' : '🔄 Oficial hoy'}</BtnSecondary>
              {form.tipo_cambio > 0 && (form.monto_asegurado || form.prima) && (
                <div style={{ gridColumn: '1 / -1', fontSize: 10, color: C.textFaint }}>
                  ≈ en pesos: {form.monto_asegurado ? `Asegurado ${fmt(enPesos(form.monto_asegurado, 'USD', form.tipo_cambio))}` : ''}{form.monto_asegurado && form.prima ? ' · ' : ''}{form.prima ? `Prima ${fmt(enPesos(form.prima, 'USD', form.tipo_cambio))}` : ''}
                </div>
              )}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <Campo label="Emisión"><input type="date" style={inputSt} value={form.fecha_emision} onChange={e => set('fecha_emision', e.target.value)} /></Campo>
            <Campo label="Inicio vigencia"><input type="date" style={inputSt} value={form.fecha_inicio} onChange={e => set('fecha_inicio', e.target.value)} /></Campo>
            <Campo label="Vencimiento"><input type="date" style={inputSt} value={form.fecha_vencimiento} onChange={e => set('fecha_vencimiento', e.target.value)} /></Campo>
          </div>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, background: '#FBFBFD', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>🎓 Datos de experto en seguros</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Campo label="Vigencia">
                <select style={inputSt} value={form.tipo_vigencia || ''} onChange={e => set('tipo_vigencia', e.target.value || null)}>
                  <option value="">-- No especifica --</option>
                  {TIPOS_VIGENCIA.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </Campo>
              <Campo label="¿Requiere recepción de obra para dar de baja?">
                <select style={inputSt} value={form.requiere_final_obra === null || form.requiere_final_obra === undefined ? '' : String(form.requiere_final_obra)} onChange={e => set('requiere_final_obra', e.target.value === '' ? null : e.target.value === 'true')}>
                  <option value="">-- No especifica --</option>
                  <option value="true">Sí</option>
                  <option value="false">No</option>
                </select>
              </Campo>
            </div>
            <Campo label="Cláusula de repetición">
              <select style={inputSt} value={form.clausula_repeticion} onChange={e => set('clausula_repeticion', e.target.value)}>
                {CLAUSULAS_REPETICION.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Campo>
            <Campo label="Cláusulas especiales"><textarea style={{ ...inputSt, minHeight: 44 }} value={form.clausulas_especiales} onChange={e => set('clausulas_especiales', e.target.value)} placeholder="Ajuste por inflación, franquicias, exclusiones, etc. (opcional)" /></Campo>
            {APLICA_AUTORENOVACION_PERIODOS.includes(form.tipo_cobertura) && (
              <div style={{ display: 'grid', gridTemplateColumns: form.se_autorenueva ? '1fr 1fr' : '1fr', gap: 10 }}>
                <Campo label="¿Se autorenueva sola por períodos si no se presenta la recepción?">
                  <select style={inputSt} value={form.se_autorenueva === null || form.se_autorenueva === undefined ? '' : String(form.se_autorenueva)} onChange={e => set('se_autorenueva', e.target.value === '' ? null : e.target.value === 'true')}>
                    <option value="">-- No especifica --</option>
                    <option value="true">Sí — la aseguradora la renueva sola y cobra prima nueva cada período hasta que se presente la recepción</option>
                    <option value="false">No — vencimiento fijo, no se renueva sola</option>
                  </select>
                </Campo>
                {form.se_autorenueva && (
                  <Campo label="Duración de cada período (días)">
                    <input type="number" style={inputSt} value={form.duracion_periodo_dias} onChange={e => set('duracion_periodo_dias', e.target.value)} placeholder="Ej. 90 = trimestral, 180 = semestral" />
                  </Campo>
                )}
              </div>
            )}
            <Campo label="Descripción de la póliza (auto-generada, editable)"><textarea style={{ ...inputSt, minHeight: 54 }} value={form.descripcion_ia} onChange={e => set('descripcion_ia', e.target.value)} placeholder="La completa la IA al leer el documento — también la podés escribir/corregir a mano." /></Campo>
          </div>
          <Campo label="Notas"><textarea style={{ ...inputSt, minHeight: 50 }} value={form.notas} onChange={e => set('notas', e.target.value)} /></Campo>
        </div>
      )}
    </Modal>
  )
}

// ── Modal: agregar documento adicional a una póliza ya cargada ──
// Comprobante de pago y factura NO son tipos seleccionables acá — tienen su propio botón:
// "+ Registrar pago" (ModalPagoPoliza) y "+ Factura" (ModalFacturaPoliza) respectivamente. Este
// modal genérico queda para el resto: póliza, endoso, cuponera, certificación, legalización, baja, otro.
const TIPOS_DOCUMENTO_POLIZA_SELECCIONABLES = TIPOS_DOCUMENTO_POLIZA.filter(t => t.value !== 'comprobante_pago' && t.value !== 'factura')
function ModalDocumentoPoliza({ poliza, tipoInicial = 'poliza', onClose, onGuardar }) {
  const [tipo, setTipo] = useState(tipoInicial)
  const [file, setFile] = useState(null)
  const [subiendo, setSubiendo] = useState(false)
  return (
    <Modal title={`Agregar documento — Póliza ${poliza.nro_poliza || ''}`} onClose={onClose} guardarLabel={subiendo ? 'Subiendo...' : 'Guardar'} onGuardar={async () => {
      if (!file) throw new Error('Elegí un archivo')
      setSubiendo(true)
      const url = await subirDocumentoStorage(file, 'polizas')
      setSubiendo(false)
      if (!url) throw new Error('No se pudo subir el archivo')
      await onGuardar({ tipo, archivo_url: url, nombre_archivo: file.name })
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Campo label="Tipo de documento">
          <select style={inputSt} value={tipo} onChange={e => setTipo(e.target.value)}>
            {TIPOS_DOCUMENTO_POLIZA_SELECCIONABLES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Campo>
        <Campo label="Archivo (foto o PDF)">
          <input type="file" accept="image/*,application/pdf" onChange={e => setFile(e.target.files[0] || null)} />
        </Campo>
        <div style={{ fontSize: 11, color: C.textFaint }}>El comprobante de un pago se adjunta desde "+ Registrar pago" y la factura desde "+ Factura", no acá.</div>
      </div>
    </Modal>
  )
}

// ── Modal: cargar la factura de una póliza (genera un gasto PENDIENTE en la obra) ──
// La factura del corredor/aseguradora es la fuente real del monto a pagar — no siempre coincide
// con el número que la IA extrajo de la carátula de la póliza (que muchas veces ni siquiera trae
// la prima discriminada con una etiqueta clara). Al cargarla acá se genera un gasto pendiente
// (pagado=false) en la obra; cuando después se registre el pago real con "+ Registrar pago", ese
// gasto pendiente se liquida en vez de crear uno nuevo, para no duplicar el gasto de la obra.
function ModalFacturaPoliza({ poliza, onClose, onGuardar }) {
  const [file, setFile] = useState(null)
  const [monto, setMonto] = useState(poliza.prima || '')
  const [fecha, setFecha] = useState(hoy())
  const [nroFactura, setNroFactura] = useState('')
  const [tipoComprobante, setTipoComprobante] = useState('otro')
  const [subiendo, setSubiendo] = useState(false)
  const [analizando, setAnalizando] = useState(false)
  const [analizado, setAnalizado] = useState(false)

  // Al elegir el archivo, la analizamos con la misma IA que lee comprobantes de gasto (modo
  // "comprobante", no "poliza") para autocompletar fecha/monto/nro — el usuario siempre puede
  // corregir el resultado antes de guardar.
  const onFile = async (f) => {
    setFile(f); setAnalizado(false)
    if (!f) return
    setAnalizando(true)
    try {
      let base64, mimeType
      if (f.type === 'application/pdf') {
        base64 = await leerBase64(f); mimeType = 'application/pdf'
      } else {
        try { ({ base64, mimeType } = await comprimirImagen(f)) }
        catch { base64 = await leerBase64(f); mimeType = f.type }
      }
      const fnUrl = 'https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante'
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
      const respRaw = await Promise.race([
        fetch(fnUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}` }, body: JSON.stringify({ base64, mimeType, hoy: hoy(), tipoAnalisis: 'comprobante' }) }),
        timeout,
      ])
      const data = await respRaw.json()
      if (respRaw.ok && data?.content) {
        const text = data.content.map(i => i.text || '').join('')
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
        if (parsed.monto) setMonto(parsed.monto)
        if (parsed.fecha) setFecha(parsed.fecha)
        if (parsed.nro_comprobante) setNroFactura(parsed.nro_comprobante)
        if (parsed.tipo_comprobante) setTipoComprobante(parsed.tipo_comprobante)
        setAnalizado(true)
      }
    } catch (e) {
      console.warn('ModalFacturaPoliza: no se pudo analizar con IA', e)
      // No es bloqueante — el usuario completa el monto a mano.
    } finally {
      setAnalizando(false)
    }
  }

  return (
    <Modal title={`Cargar factura — Póliza ${poliza.nro_poliza || ''}`} onClose={onClose} guardarLabel={subiendo ? 'Subiendo...' : 'Guardar factura'} onGuardar={async () => {
      if (!file) throw new Error('Elegí el archivo de la factura')
      const montoNum = parseFloat(monto) || 0
      if (!montoNum) throw new Error('Ingresá el monto de la factura')
      setSubiendo(true)
      const url = await subirDocumentoStorage(file, 'polizas')
      setSubiendo(false)
      if (!url) throw new Error('No se pudo subir el archivo')
      await onGuardar({ archivo_url: url, nombre_archivo: file.name, monto: montoNum, fecha, nro_factura: nroFactura || null, tipo_comprobante: tipoComprobante })
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: C.textMuted }}>Esto genera un gasto pendiente de pago en la obra por el monto de la factura — cuando registrés el pago real, se liquida ese gasto en vez de crear uno nuevo.</div>
        <Campo label="Archivo de la factura (foto o PDF)">
          <input type="file" accept="image/*,application/pdf" onChange={e => onFile(e.target.files[0] || null)} />
          {analizando && <div style={{ fontSize: 11, color: C.purple, marginTop: 4 }}>🔎 Leyendo la factura con IA...</div>}
          {analizado && !analizando && <div style={{ fontSize: 11, color: C.green, marginTop: 4 }}>✓ Datos autocompletados por IA — revisalos antes de guardar.</div>}
        </Campo>
        <VistaPreviaArchivo file={file} url={null} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Campo label="Fecha de factura"><input type="date" style={inputSt} value={fecha} onChange={e => setFecha(e.target.value)} /></Campo>
          <Campo label="Monto de la factura ($)"><input type="number" style={inputSt} value={monto} onChange={e => setMonto(e.target.value)} /></Campo>
        </div>
        <Campo label="Nro. de factura (opcional)"><input style={inputSt} value={nroFactura} onChange={e => setNroFactura(e.target.value)} /></Campo>
      </div>
    </Modal>
  )
}

// ── Modal: marcar Recepción Provisoria/Definitiva, con foto/PDF opcional de la recepción de obra ──
function ModalRecepcionObra({ obra, tipoRecepcion, onClose, onGuardar }) {
  const [file, setFile] = useState(null)
  const [subiendo, setSubiendo] = useState(false)
  const titulo = tipoRecepcion === 'recepcion_provisoria' ? 'Recepción Provisoria' : 'Recepción Definitiva'
  return (
    <Modal title={`Marcar ${titulo} — ${obra.nombre}`} onClose={onClose} guardarLabel={subiendo ? 'Subiendo...' : 'Confirmar'} onGuardar={async () => {
      let url = null
      if (file) { setSubiendo(true); url = await subirDocumentoStorage(file, 'recepciones'); setSubiendo(false); if (!url) throw new Error('No se pudo subir el archivo') }
      await onGuardar({ estado_licitacion: tipoRecepcion, url })
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: C.textMuted }}>Subí la foto o el PDF del acta de {titulo.toLowerCase()} firmada con el organismo. Este es el documento que después se le presenta a la aseguradora para pedir la baja de la garantía correspondiente.</div>
        <Campo label="Acta de recepción (opcional, recomendado)">
          <input type="file" accept="image/*,application/pdf" onChange={e => setFile(e.target.files[0] || null)} />
        </Campo>
      </div>
    </Modal>
  )
}

// ── Modal: confirmar que la aseguradora ya dio de baja una póliza ──
function ModalConfirmarBaja({ poliza, onClose, onGuardar }) {
  const [file, setFile] = useState(null)
  const [subiendo, setSubiendo] = useState(false)
  return (
    <Modal title={`Confirmar baja — Póliza ${poliza.nro_poliza || ''}`} onClose={onClose} guardarLabel={subiendo ? 'Subiendo...' : 'Confirmar baja'} onGuardar={async () => {
      let url = null
      if (file) { setSubiendo(true); url = await subirDocumentoStorage(file, 'polizas'); setSubiendo(false); if (!url) throw new Error('No se pudo subir el archivo') }
      await onGuardar({ url })
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: C.textMuted }}>Adjuntá la nota o el documento donde la aseguradora confirma la baja de esta póliza (si te lo mandaron firmado).</div>
        <Campo label="Confirmación de la aseguradora (opcional)">
          <input type="file" accept="image/*,application/pdf" onChange={e => setFile(e.target.files[0] || null)} />
        </Campo>
      </div>
    </Modal>
  )
}

// ── Modal: registrar un pago de prima (impacta la cuenta corriente con la aseguradora Y el gasto de la obra) ──
// Saldo pendiente teórico de una póliza (suma de saldoMonto de todos sus movimientos no anulados).
// Para una póliza en USD este número está calculado al tipo de cambio CARGADO en la póliza —
// el monto real transferido casi siempre va a diferir un poco (dólar comprador/vendedor, un día
// antes o después, cotización del día del pago) — es normal (confirmado por el usuario, octubre
// 2026) y por eso el campo de monto de abajo es editable: se precarga con este valor pero el
// usuario lo ajusta al monto real para que la póliza quede exactamente en $0, sin dejar un
// residuo que se va acumulando sin ningún significado real (era el bug reportado: saldos como
// "-475,65" que no salían de ningún lado, puro arrastre del tipo de cambio).
function saldoPendientePoliza(poliza, renovaciones, pagos) {
  return movimientosPoliza(poliza, renovaciones, pagos).filter(m => !m.anulada).reduce((s, m) => s + m.saldoMonto, 0)
}

// Registra el pago de UNA O MÁS pólizas con los mismos datos de transferencia/comprobante. Antes
// solo se podía pagar una póliza por vez — pero es común que la aseguradora facture varias
// coberturas juntas y el usuario haga UNA sola transferencia que cubre varios seguros (reportado
// por el usuario con un caso real: una transferencia, tres pólizas). Cada póliza seleccionada
// genera su propio gasto/pago (o liquida su factura pendiente si ya había una cargada) pero todas
// comparten fecha, medio de pago, banco, comprobante y observaciones — porque físicamente fue un
// solo movimiento bancario.
function ModalPagoPoliza({ polizas, polizaIdDefecto, bancos, renovaciones = [], pagos = [], onClose, onGuardar }) {
  const defId = polizaIdDefecto || polizas[0]?.id
  const [montos, setMontos] = useState(() => {
    const ini = {}
    polizas.forEach(p => {
      // Si hay una sola póliza candidata (o es la que vino preseleccionada), se precarga con el
      // saldo pendiente teórico — así el usuario ve de entrada "esto es lo que falta" y solo tiene
      // que confirmarlo o ajustarlo, en vez de arrancar de un campo vacío.
      const precargar = polizas.length === 1 || p.id === defId
      ini[p.id] = precargar ? String(Math.round(saldoPendientePoliza(p, renovaciones, pagos) * 100) / 100 || '') : ''
    })
    return ini
  })
  const [common, setCommon] = useState({ fecha_pago: hoy(), medio_pago: 'transferencia', banco_id: '', nro_operacion: '', observaciones: '' })
  const [file, setFile] = useState(null)
  const [subiendo, setSubiendo] = useState(false)
  const [analizando, setAnalizando] = useState(false)
  const [analizado, setAnalizado] = useState(false)
  const [montoLeido, setMontoLeido] = useState(null)
  const setC = (k, v) => setCommon(c => ({ ...c, [k]: v }))
  const setMonto = (id, v) => setMontos(m => ({ ...m, [id]: v }))
  const necesitaBanco = ['transferencia', 'cheque', 'tarjeta', 'tarjeta_credito', 'tarjeta_debito'].includes(common.medio_pago)

  // El "comprobante de pago" acá puede ser una transferencia, pero también una CUPONERA de la
  // aseguradora (a veces se paga directo con el cupón, sin que exista una factura aparte). Al
  // elegir el archivo lo leemos con la misma IA de comprobantes de gasto para autocompletar
  // fecha/monto. Si hay una sola póliza en juego se lo aplica directo; si hay varias, el monto
  // leído se muestra como dato de referencia (no sabemos a cuál de las pólizas corresponde).
  const onFile = async (f) => {
    setFile(f); setAnalizado(false); setMontoLeido(null)
    if (!f) return
    setAnalizando(true)
    try {
      let base64, mimeType
      if (f.type === 'application/pdf') {
        base64 = await leerBase64(f); mimeType = 'application/pdf'
      } else {
        try { ({ base64, mimeType } = await comprimirImagen(f)) }
        catch { base64 = await leerBase64(f); mimeType = f.type }
      }
      const fnUrl = 'https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante'
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
      const respRaw = await Promise.race([
        fetch(fnUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}` }, body: JSON.stringify({ base64, mimeType, hoy: hoy(), tipoAnalisis: 'comprobante' }) }),
        timeout,
      ])
      const data = await respRaw.json()
      if (respRaw.ok && data?.content) {
        const text = data.content.map(i => i.text || '').join('')
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
        if (parsed.fecha) setC('fecha_pago', parsed.fecha)
        if (parsed.monto) {
          if (polizas.length === 1) setMonto(polizas[0].id, parsed.monto)
          setMontoLeido(parsed.monto)
        }
        setAnalizado(true)
      }
    } catch (e) {
      console.warn('ModalPagoPoliza: no se pudo analizar con IA', e)
    } finally {
      setAnalizando(false)
    }
  }

  const filas = polizas.map(p => ({ poliza: p, saldo: saldoPendientePoliza(p, renovaciones, pagos) }))
  const totalIngresado = Object.values(montos).reduce((s, v) => s + (parseFloat(v) || 0), 0)
  const cantSeleccionadas = Object.values(montos).filter(v => (parseFloat(v) || 0) > 0).length
  const hayUSD = polizas.some(p => p.moneda === 'USD')

  return (
    <Modal title={polizas.length > 1 ? 'Registrar pago — una o más pólizas' : 'Registrar pago de póliza'} onClose={onClose} guardarLabel={subiendo ? 'Subiendo...' : 'Guardar pago'} onGuardar={async () => {
      const seleccion = polizas
        .map(p => ({ poliza_id: p.id, monto: Math.round((parseFloat(montos[p.id]) || 0) * 100) / 100 }))
        .filter(x => x.monto > 0)
      if (seleccion.length === 0) throw new Error('Ingresá el monto a pagar en al menos una póliza')
      let comprobante_url = null
      if (file) { setSubiendo(true); comprobante_url = await subirDocumentoStorage(file, 'pagos_poliza'); setSubiendo(false); if (!comprobante_url) throw new Error('No se pudo subir el comprobante') }
      await onGuardar({ polizas: seleccion, ...common, banco_id: common.banco_id || null, comprobante_url })
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Campo label="Comprobante de pago o cuponera (opcional, se lee con IA)">
          <input type="file" accept="image/*,application/pdf" onChange={e => onFile(e.target.files[0] || null)} />
          {analizando && <div style={{ fontSize: 11, color: C.purple, marginTop: 4 }}>🔎 Leyendo con IA...</div>}
          {analizado && !analizando && polizas.length === 1 && <div style={{ fontSize: 11, color: C.green, marginTop: 4 }}>✓ Fecha y monto autocompletados por IA — revisalos antes de guardar.</div>}
          {analizado && !analizando && polizas.length > 1 && montoLeido && <div style={{ fontSize: 11, color: C.purple, marginTop: 4 }}>ℹ️ La IA leyó $ {fmt(montoLeido)} en el comprobante — repartilo entre las pólizas que corresponda, abajo.</div>}
        </Campo>
        <VistaPreviaArchivo file={file} url={null} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {polizas.length > 1 ? 'Elegí a qué póliza(s) corresponde esta transferencia' : 'Póliza'}
          </div>
          {filas.map(({ poliza: p, saldo }) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: `1px solid ${C.border}`, borderRadius: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{p.nro_poliza || 's/n'} — {p.obras?.nombre}</div>
                <div style={{ fontSize: 11, color: C.textFaint }}>Saldo pendiente (teórico): $ {fmtDec(saldo)}{p.moneda === 'USD' ? ' · en pesos, según t.c. cargado' : ''}</div>
              </div>
              <input type="number" style={{ ...inputSt, width: 130 }} placeholder="0" value={montos[p.id]} onChange={e => setMonto(p.id, e.target.value)} />
              {saldo > 0 && <button type="button" onClick={() => setMonto(p.id, String(Math.round(saldo * 100) / 100))} style={{ ...btnIconSt, fontSize: 11 }} title="Completar con el saldo pendiente — deja esta póliza en $0">= saldo</button>}
            </div>
          ))}
          {polizas.length > 1 && <div style={{ fontSize: 11, color: C.textMuted, textAlign: 'right' }}>Total a registrar: $ {fmtDec(totalIngresado)}{cantSeleccionadas > 1 ? ` — en ${cantSeleccionadas} pólizas` : ''}</div>}
          {hayUSD && <div style={{ fontSize: 11, color: '#8A5200' }}>💡 El saldo de una póliza en USD es teórico (al tipo de cambio cargado en la póliza) — es normal que difiera un poco del monto real transferido (dólar comprador/vendedor, cotización de otro día). Ajustá el monto de esa póliza al valor real para que quede en $0 y no se acumule una diferencia sin sentido.</div>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Campo label="Fecha de pago"><input type="date" style={inputSt} value={common.fecha_pago} onChange={e => setC('fecha_pago', e.target.value)} /></Campo>
          <Campo label="Medio de pago">
            <select style={inputSt} value={common.medio_pago} onChange={e => setC('medio_pago', e.target.value)}>
              {MEDIOS_PAGO.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Campo>
        </div>
        {necesitaBanco && (
          <Campo label="Banco">
            <select style={inputSt} value={common.banco_id} onChange={e => setC('banco_id', e.target.value)}>
              <option value="">-- Elegir --</option>
              {bancos.map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}
            </select>
          </Campo>
        )}
        <Campo label="Nro. de operación (opcional)"><input style={inputSt} value={common.nro_operacion} onChange={e => setC('nro_operacion', e.target.value)} /></Campo>
        <Campo label="Observaciones"><textarea style={{ ...inputSt, minHeight: 50 }} value={common.observaciones} onChange={e => setC('observaciones', e.target.value)} /></Campo>
        <div style={{ fontSize: 11, color: C.textFaint }}>{polizas.length > 1 ? 'Si pagás más de una póliza acá, se registra un gasto "Seguros / Pólizas" por cada una (misma fecha, medio de pago y comprobante) — cada póliza queda con su cuenta corriente al día, aunque haya sido una sola transferencia.' : 'Este pago se registra también como gasto (concepto "Seguros / Pólizas") en la obra correspondiente. Si había una factura pendiente cargada para esta póliza, se liquida esa en vez de crear un gasto nuevo.'}</div>
      </div>
    </Modal>
  )
}

// ── Modal: registrar el cargo de una renovación automática por período ──
// Ojo: el monto de la renovación NO se copia automáticamente de la prima original — puede diferir
// por reajuste (ej. "reajustable trimestralmente") — por eso se pide como dato aparte.
// ── Modal: confirmar (y opcionalmente corregir) una renovación cargada como estimación ──
function ModalConfirmarRenovacion({ renovacion, onClose, onGuardar }) {
  const [monto, setMonto] = useState(renovacion.monto ?? '')
  return (
    <Modal title={`Confirmar renovación — hasta ${fmtFechaAR(renovacion.periodo_hasta)}`} onClose={onClose} guardarLabel="Confirmar" onGuardar={async () => {
      const montoNum = parseFloat(monto) || 0
      if (!montoNum) throw new Error('Ingresá el monto confirmado')
      await onGuardar({ monto: montoNum })
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: C.textMuted }}>Corregí el monto si la aseguradora te informó un valor distinto al estimado, y confirmalo — deja de aparecer como "provisorio, a confirmar".</div>
        <Campo label="Monto confirmado"><input type="number" style={inputSt} value={monto} onChange={e => setMonto(e.target.value)} autoFocus /></Campo>
      </div>
    </Modal>
  )
}

function ModalRenovacionPoliza({ poliza, renovaciones = [], onClose, onGuardar }) {
  const corteAnterior = poliza.fecha_vencimiento
  const esUSD = poliza.moneda === 'USD'
  // Monto sugerido = el último conocido: la renovación previa más reciente (no anulada) si ya hay
  // alguna, si no primaRealPoliza() (que ya prioriza la factura real por sobre poliza.prima — ver
  // más arriba). Es una ESTIMACIÓN: por eso el formulario arranca con "confirmado" destildado.
  const renovacionesDeLaPoliza = renovaciones.filter(r => r.poliza_id === poliza.id && !r.anulada)
  const ultimaRenovacion = renovacionesDeLaPoliza.slice().sort((a, b) => (b.periodo_hasta || '').localeCompare(a.periodo_hasta || ''))[0]
  const montoSugerido = ultimaRenovacion?.monto ?? primaRealPoliza(poliza)
  const [form, setForm] = useState({
    periodo_desde: corteAnterior || hoy(),
    periodo_hasta: sumarDias(corteAnterior, poliza.duracion_periodo_dias) || '',
    monto: montoSugerido || '',
    tipo_cambio: '',
    fecha_tipo_cambio: hoy(),
    observaciones: '',
    confirmado: false,
  })
  const [buscandoTC, setBuscandoTC] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const buscarTC = async () => {
    setBuscandoTC(true)
    const r = await buscarTipoCambioOficial()
    if (r) { set('tipo_cambio', r.valor); set('fecha_tipo_cambio', r.fecha) }
    else toast('No se pudo buscar el tipo de cambio automático — completalo a mano')
    setBuscandoTC(false)
  }
  return (
    <Modal title={`Registrar renovación — Póliza ${poliza.nro_poliza || ''}`} onClose={onClose} guardarLabel="Guardar renovación" onGuardar={async () => {
      if (!form.periodo_hasta) throw new Error('Ingresá hasta cuándo va este nuevo período')
      const montoNum = parseFloat(form.monto) || 0
      if (!montoNum) throw new Error('Ingresá el monto de la prima cobrada por este período')
      if (esUSD && !(parseFloat(form.tipo_cambio) > 0)) throw new Error('Esta póliza está en USD — ingresá el tipo de cambio de esta renovación')
      await onGuardar({ ...form, monto: montoNum, tipo_cambio: esUSD ? parseFloat(form.tipo_cambio) : null, fecha_tipo_cambio: esUSD ? (form.fecha_tipo_cambio || null) : null })
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: C.textMuted }}>La aseguradora renovó sola esta póliza por otro período (no se presentó la recepción a tiempo) y cobró una prima nueva. Registrá acá ese cargo — el monto puede ser distinto al original por reajuste.</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Campo label="Período desde"><input type="date" style={inputSt} value={form.periodo_desde} onChange={e => set('periodo_desde', e.target.value)} /></Campo>
          <Campo label="Período hasta (nuevo corte)"><input type="date" style={inputSt} value={form.periodo_hasta} onChange={e => set('periodo_hasta', e.target.value)} /></Campo>
        </div>
        <Campo label={`Monto de la prima de este período ${esUSD ? '(U$S)' : '($)'}`}>
          <input type="number" style={inputSt} value={form.monto} onChange={e => set('monto', e.target.value)} />
          <div style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}>Sugerido = último monto conocido ({fmtDec(montoSugerido)}). Corregilo si ya sabés el monto real.</div>
        </Campo>
        {esUSD && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'end' }}>
            <Campo label="Tipo de cambio de esta renovación ($/US$)"><input type="number" style={inputSt} value={form.tipo_cambio} onChange={e => set('tipo_cambio', e.target.value)} placeholder="Se busca solo, pero podés corregirlo" /></Campo>
            <Campo label="Fecha del TC"><input type="date" style={inputSt} value={form.fecha_tipo_cambio} onChange={e => set('fecha_tipo_cambio', e.target.value)} /></Campo>
            <BtnSecondary onClick={buscarTC}>{buscandoTC ? 'Buscando…' : '🔄 Oficial hoy'}</BtnSecondary>
          </div>
        )}
        <Campo label="Observaciones (opcional)"><textarea style={{ ...inputSt, minHeight: 50 }} value={form.observaciones} onChange={e => set('observaciones', e.target.value)} placeholder="Ej. reajuste del 8% por inflación" /></Campo>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.text, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.confirmado} onChange={e => set('confirmado', e.target.checked)} />
          Ya tengo este monto confirmado por la aseguradora (no es una estimación)
        </label>
        {!form.confirmado && (
          <div style={{ fontSize: 11, color: '#8A5200', background: '#FFF8ED', padding: '6px 9px', borderRadius: 8 }}>
            ⚠️ Va a quedar marcada "provisorio — a confirmar" hasta que la tildes o corrijas el monto cuando te llegue el estado de cuenta real de la aseguradora.
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── Lista de documentos adjuntos de una póliza (ver / descargar) ──────────
function ListaDocumentos({ documentos }) {
  const [abierto, setAbierto] = useState(false)
  if (!documentos || documentos.length === 0) return <div style={{ fontSize: 11, color: C.textFaint }}>Sin documentos adjuntos todavía.</div>
  return (
    <div>
      <button onClick={() => setAbierto(v => !v)} style={{ background: 'none', border: 'none', color: C.purple, fontSize: 11, cursor: 'pointer', padding: 0, fontFamily: "'Outfit', sans-serif" }}>
        {abierto ? '▾' : '▸'} 📎 {documentos.length} documento(s)
      </button>
      {abierto && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
          {documentos.map(d => (
            <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 11, background: '#FBFBFD', padding: '5px 8px', borderRadius: 6 }}>
              <span style={{ color: C.textMuted }}>{DOC_LABELS[d.tipo] || d.tipo}{d.nombre_archivo ? ` — ${d.nombre_archivo}` : ''}</span>
              <a href={d.archivo_url} target="_blank" rel="noreferrer" download style={{ color: C.purple, fontWeight: 600, whiteSpace: 'nowrap' }}>⬇️ Descargar</a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Fila de póliza (anidada dentro de la obra) — colapsada por defecto: mientras está plegada
// solo muestra lo esencial para identificarla (tipo de seguro y vencimiento, si tiene); el resto
// del detalle (descripción, montos, cláusulas, documentos, acciones) aparece al desplegar. Las
// alertas rojas (vencimiento/renovación/baja) se muestran siempre, estén o no desplegadas.
function FilaPoliza({ poliza, alertaInfo, advertencias, pagos, renovaciones = [], diasAviso = DIAS_AVISO_VENCIMIENTO, onMarcarBajaPresentada, onConfirmarBaja, onAgregarDocumento, onAgregarFactura, onRegistrarPago, onRegistrarRenovacion, onAnularRenovacion, onConfirmarRenovacion, onEditar, onEliminar }) {
  const [expandido, setExpandido] = useState(false)
  const totalPagado = pagos.reduce((s, p) => s + (parseFloat(p.monto) || 0), 0)
  const renovacionesVigentes = renovaciones.filter(r => !r.anulada)
  const totalRenovaciones = renovacionesVigentes.length > 0 ? primaConRenovaciones(poliza, renovaciones) - enPesos(poliza.prima, poliza.moneda, poliza.tipo_cambio) : 0
  const prima = primaConRenovaciones(poliza, renovaciones)
  const saldo = prima - totalPagado
  return (
    <div style={{ ...cardSt, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: '#FBFBFD' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', cursor: 'pointer' }} onClick={() => setExpandido(v => !v)}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{expandido ? '▾' : '▸'} Póliza {poliza.nro_poliza || 's/n'}</div>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
            🏢 Aseguradora: {poliza.aseguradora || 'sin especificar'}{poliza.corredor ? ` · 🧑‍💼 Corredor: ${poliza.corredor}` : ' · Sin corredor'}
          </div>
        </div>
        <EstadoAdminBadge estado={poliza.estado_admin} />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <Badge bg={C.purpleDim} color={C.purple}>📄 {COBERTURA_LABELS[poliza.tipo_cobertura] || poliza.tipo_cobertura}</Badge>
        <MonedaBadge moneda={poliza.moneda} />
        <VencimientoBadge fecha={corteVigentePoliza(poliza, renovaciones)} diasAviso={diasAviso} />
      </div>
      {alertaInfo && (
        <div style={{ fontSize: 12, background: '#FFF0F0', color: '#C62828', padding: '8px 10px', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {alertaInfo.motivos.map((m, i) => <div key={i}>⚠️ {m}</div>)}
          <div>
            {alertaInfo.accion === 'presentar_baja' && <BtnSecondary onClick={() => onMarcarBajaPresentada(poliza)}>Marcar baja presentada a la aseguradora</BtnSecondary>}
            {alertaInfo.accion === 'confirmar_baja' && <BtnSecondary onClick={() => onConfirmarBaja(poliza)}>Confirmar baja de la aseguradora</BtnSecondary>}
            {alertaInfo.accion === 'registrar_renovacion' && <BtnSecondary onClick={() => onRegistrarRenovacion(poliza)}>Registrar cargo de renovación</BtnSecondary>}
          </div>
        </div>
      )}
      {!expandido && (
        <div style={{ fontSize: 11, color: C.purple, cursor: 'pointer' }} onClick={() => setExpandido(true)}>▸ Ver más detalle</div>
      )}
      {expandido && (
        <>
          {poliza.descripcion_ia && <div style={{ fontSize: 11, color: C.textFaint, fontStyle: 'italic', maxWidth: 480 }}>"{poliza.descripcion_ia}"</div>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <AutorenovacionBadge poliza={poliza} />
            <EndosoBadge poliza={poliza} />
            <VigenciaBadge tipo={poliza.tipo_vigencia} />
            <RepeticionBadge clausula={poliza.clausula_repeticion} />
            {poliza.requiere_final_obra && <Badge bg="#EEF4FF" color="#2D5FA8">📄 Requiere recepción de obra para baja</Badge>}
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: C.textMuted }}>
            {poliza.monto_asegurado ? (
              <span>💰 Asegurado: {poliza.moneda === 'USD' ? `U$S ${fmt(poliza.monto_asegurado)}${poliza.tipo_cambio > 0 ? ` (≈ ${fmt(enPesos(poliza.monto_asegurado, poliza.moneda, poliza.tipo_cambio))})` : ''}` : fmt(poliza.monto_asegurado)}</span>
            ) : null}
            {prima > 0 && (
              <span>🧾 Prima{totalRenovaciones > 0 ? ' total (con renovaciones)' : ''}: {poliza.moneda === 'USD' ? `U$S ${fmtDec(primaRealPoliza(poliza) + renovacionesVigentes.reduce((s, r) => s + (parseFloat(r.monto) || 0), 0))} (≈ ${fmtDec(prima)})` : fmtDec(prima)} · Pagado: {fmtDec(totalPagado)} · Saldo: {fmtDec(saldo)}</span>
            )}
            {poliza.fecha_inicio && <span>📅 Vigencia desde: {fmtFechaAR(poliza.fecha_inicio)}</span>}
          </div>
          {poliza.clausulas_especiales && <div style={{ fontSize: 11, color: C.textMuted, background: '#F3F3F3', padding: '6px 9px', borderRadius: 8 }}>📋 Cláusulas especiales: {poliza.clausulas_especiales}</div>}
          {poliza.se_autorenueva && renovaciones.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted }}>🔁 Renovaciones por período registradas</div>
              {renovaciones.map(r => {
                // Provisorio = todavía no confirmado el monto real con la aseguradora — se muestra
                // resaltado en ámbar con un botón para confirmarlo/corregirlo; una vez confirmado pasa
                // a un estilo neutro, igual que una renovación cargada ya con el monto real.
                const provisorio = !r.anulada && !r.confirmado
                return (
                  <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 11, background: r.anulada ? '#F3F3F3' : provisorio ? '#FFF8ED' : '#FBFBFD', padding: '5px 8px', borderRadius: 6, textDecoration: r.anulada ? 'line-through' : 'none', color: r.anulada ? '#888' : provisorio ? '#8A5200' : C.textMuted }}>
                    <span>Hasta {fmtFechaAR(r.periodo_hasta)} · {poliza.moneda === 'USD' ? `U$S ${fmtDec(r.monto)}${r.tipo_cambio > 0 ? ` (≈ ${fmtDec(enPesos(r.monto, poliza.moneda, r.tipo_cambio))} al TC ${r.tipo_cambio})` : ' (falta tipo de cambio)'}` : fmtDec(r.monto)}{r.anulada ? ' · anulada (retroactiva)' : provisorio ? ' · ⚠️ provisorio, a confirmar' : ''}</span>
                    {!r.anulada && (
                      <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
                        {provisorio && <button onClick={() => onConfirmarRenovacion(r)} style={{ background: 'none', border: 'none', color: '#8A5200', fontSize: 11, fontWeight: 700, cursor: 'pointer', padding: 0, fontFamily: "'Outfit', sans-serif" }}>✓ Confirmar</button>}
                        <button onClick={() => onAnularRenovacion(r)} style={{ background: 'none', border: 'none', color: C.purple, fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: "'Outfit', sans-serif" }}>Anular (retroactivo)</button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <ListaDocumentos documentos={poliza.poliza_documentos} />
            {((poliza.poliza_documentos || []).length > 0 || pagos.some(p => p.comprobante_url)) && (
              <button onClick={() => descargarDocumentosZip(poliza, pagos)} style={{ background: 'none', border: 'none', color: C.purple, fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: "'Outfit', sans-serif" }}>⬇️ Descargar todo (.zip)</button>
            )}
          </div>
          {advertencias && advertencias.length > 0 && (
            <div style={{ fontSize: 12, background: '#FFF8ED', color: '#8A5200', padding: '8px 10px', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontWeight: 700 }}>🔎 Revisión de datos</div>
              {advertencias.map((a, i) => <div key={i}>• {a}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <BtnSecondary onClick={() => onAgregarFactura(poliza)}>+ Factura</BtnSecondary>
            <BtnSecondary onClick={() => onRegistrarPago(poliza)}>+ Registrar pago</BtnSecondary>
            <BtnSecondary onClick={() => onAgregarDocumento(poliza)}>+ Documento</BtnSecondary>
            {poliza.se_autorenueva && <BtnSecondary onClick={() => onRegistrarRenovacion(poliza)}>+ Renovación</BtnSecondary>}
            <BtnSecondary onClick={() => onEditar(poliza)}>✏️ Editar</BtnSecondary>
            <BtnPeligro onClick={() => onEliminar(poliza)}>🗑️ Eliminar</BtnPeligro>
          </div>
        </>
      )}
    </div>
  )
}

// ── Fila de obra (con transición de etapa/estado de licitación y sus pólizas anidadas) ──
function FilaObra({ obra, polizasDeLaObra, pagosPoliza, renovacionesPoliza, alertas, diasAviso = DIAS_AVISO_VENCIMIENTO, onCambiarEtapa, onPedirRecepcion, onNuevaPoliza, onMarcarBajaPresentada, onConfirmarBaja, onAgregarDocumento, onAgregarFactura, onRegistrarPago, onRegistrarRenovacion, onAnularRenovacion, onConfirmarRenovacion, onEditarPoliza, onEliminarPoliza, onEditarObra }) {
  const [expandido, setExpandido] = useState(false)
  const polizasPendientes = polizasDeLaObra.filter(p => p.estado_admin !== 'dada_de_baja')
  // Tipos de cobertura que tiene cargados esta obra ahora mismo (sin contar pólizas dadas de baja) —
  // para verlos de un vistazo en la tarjeta colapsada, sin tener que expandir y entrar póliza por
  // póliza (setiembre 2026, pedido del usuario).
  const tiposPresentes = [...new Set(polizasPendientes.map(p => p.tipo_cobertura).filter(Boolean))]
  const finalizadaConPendientes = obra.estado === 'finalizada' && polizasPendientes.length > 0
  // Adjudicada (ejecución) pero sin ninguna póliza cargada todavía — no debería haber llegado a
  // ejecución sin presentar antes la garantía de oferta (setiembre 2026, detectado por el usuario).
  const sinGarantiaAdjudicada = obra.etapa === 'ejecucion' && obra.requiere_poliza !== false && polizasDeLaObra.length === 0
  return (
    <div style={{ ...cardSt, padding: 14, display: 'flex', flexDirection: 'column', gap: 8, ...((finalizadaConPendientes || sinGarantiaAdjudicada) ? { border: '1px solid #FFB0B0' } : {}) }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ cursor: 'pointer', flex: 1, minWidth: 0 }} onClick={() => setExpandido(v => !v)}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{expandido ? '▾' : '▸'} {obra.nombre}</div>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{nombreOrganismoObra(obra) || 'Sin cliente vinculado'}{obra.monto_contrato ? ` · $${fmt(obra.monto_contrato)}` : ''} · {polizasDeLaObra.length} póliza(s)</div>
          {/* Descripción oficial completa (objeto del pliego/contrato) — separada del nombre corto
              que se usa para identificar la obra de un vistazo en listados (octubre 2026). */}
          {obra.detalle && <div style={{ fontSize: 11, color: C.textFaint, fontStyle: 'italic', marginTop: 3, maxWidth: 520 }}>{obra.detalle}</div>}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {obra.estado === 'finalizada' && <Badge bg="#F3F3F3" color="#555">🏁 Finalizada (panel Obras)</Badge>}
          {obra.estado === 'pausada' && <Badge bg="#FFF8ED" color="#8A5200">⏸️ Pausada</Badge>}
          {obra.requiere_poliza === false && <Badge bg="#F3F3F3" color="#888">Sin póliza requerida</Badge>}
          <EtapaBadge etapa={obra.etapa} />
          <EstadoLicitacionBadge estado={obra.estado_licitacion} />
          {onEditarObra && <button onClick={() => onEditarObra(obra)} style={{ ...btnIconSt, fontSize: 11 }} title="Editar obra">✏️</button>}
        </div>
      </div>
      {tiposPresentes.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {tiposPresentes.map(t => (
            <Badge key={t} bg={C.purpleDim} color={C.purple}>{COBERTURA_ICONS[t] || '📎'} {COBERTURA_LABELS[t] || t}</Badge>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <BtnSecondary onClick={() => onNuevaPoliza(obra.id)}>+ Póliza</BtnSecondary>
        {obra.etapa === 'oferta' && <BtnSecondary onClick={() => onCambiarEtapa(obra, 'ejecucion')}>Marcar adjudicada</BtnSecondary>}
        {obra.etapa === 'ejecucion' && obra.estado_licitacion === 'en_curso' && <BtnSecondary onClick={() => onPedirRecepcion(obra, 'recepcion_provisoria')}>Marcar Recepción Provisoria</BtnSecondary>}
        {obra.etapa === 'ejecucion' && obra.estado_licitacion === 'recepcion_provisoria' && <BtnSecondary onClick={() => onPedirRecepcion(obra, 'recepcion_definitiva')}>Marcar Recepción Definitiva</BtnSecondary>}
        {obra.recepcion_provisoria_url && <a href={obra.recepcion_provisoria_url} target="_blank" rel="noreferrer" download style={{ fontSize: 11, color: C.purple, alignSelf: 'center' }}>⬇️ Recepción provisoria</a>}
        {obra.recepcion_definitiva_url && <a href={obra.recepcion_definitiva_url} target="_blank" rel="noreferrer" download style={{ fontSize: 11, color: C.purple, alignSelf: 'center' }}>⬇️ Recepción definitiva</a>}
      </div>
      {obra.etapa === 'oferta' && (
        <div style={{ fontSize: 11, color: '#8A5200', background: '#FFF8ED', padding: '6px 9px', borderRadius: 8 }}>📋 Esta obra todavía está en oferta — al marcarla "adjudicada" pasa a Ejecución y ahí sí aparece en el panel de Obras, gastos y finanzas de la app.</div>
      )}
      {finalizadaConPendientes && (
        <div style={{ fontSize: 11, color: '#C62828', background: '#FFF0F0', padding: '6px 9px', borderRadius: 8, fontWeight: 600 }}>🏁 Esta obra está marcada Finalizada en el panel de Obras pero tiene {polizasPendientes.length} póliza(s) sin dar de baja — revisar si corresponde presentar/confirmar la baja con la aseguradora.</div>
      )}
      {sinGarantiaAdjudicada && (
        <div style={{ fontSize: 11, color: '#C62828', background: '#FFF0F0', padding: '6px 9px', borderRadius: 8, fontWeight: 600 }}>⚠️ Esta obra está adjudicada (en ejecución) pero todavía no tiene ninguna póliza cargada — revisar si se presentó la garantía de oferta y falta cargarla en el sistema, o si en realidad todavía no se presentó.</div>
      )}
      {expandido && (
        polizasDeLaObra.length === 0
          ? <EmptyState texto={obra.requiere_poliza === false
              ? 'Esta obra está marcada como que no requiere garantías de seguro — no hace falta cargarle pólizas.'
              : 'Esta obra todavía no tiene pólizas cargadas.'} />
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              {polizasDeLaObra.map(p => (
                <FilaPoliza key={p.id} poliza={p} alertaInfo={alertas.find(a => a.poliza.id === p.id) || null}
                  advertencias={detectarAdvertencias(p)}
                  pagos={pagosPoliza.filter(pg => pg.poliza_id === p.id)}
                  renovaciones={renovacionesPoliza.filter(r => r.poliza_id === p.id)}
                  diasAviso={diasAviso}
                  onMarcarBajaPresentada={onMarcarBajaPresentada} onConfirmarBaja={onConfirmarBaja}
                  onAgregarDocumento={onAgregarDocumento} onAgregarFactura={onAgregarFactura} onRegistrarPago={onRegistrarPago}
                  onRegistrarRenovacion={onRegistrarRenovacion} onAnularRenovacion={onAnularRenovacion} onConfirmarRenovacion={onConfirmarRenovacion}
                  onEditar={onEditarPoliza} onEliminar={onEliminarPoliza} />
              ))}
            </div>
          )
      )}
    </div>
  )
}

// ── Cuenta corriente con las aseguradoras (o corredores) — agrupa pólizas ──
// Monto real de la prima para la cuenta corriente: `poliza.prima` es lo que la IA pudo leer de la
// carátula de la póliza al cargarla (a veces no trae el monto neto, o directamente no figura ahí —
// está en la cuponera o la factura, ver ModalFacturaPoliza) — es una ESTIMACIÓN provisoria. En
// cuanto se carga la factura real ("+ Factura"), ese monto (guardado en poliza_documentos.monto)
// es la fuente de verdad de lo que realmente hay que pagarle a la aseguradora — reemplaza a
// poliza.prima en vez de sumarse, porque es el mismo cargo visto con más precisión, no uno nuevo.
// Si hay más de una factura cargada (distintos períodos/endosos), se suman todas (setiembre 2026,
// antes la cuenta corriente quedaba en $0 si nunca se había completado poliza.prima a mano).
function primaRealPoliza(poliza) {
  const facturas = (poliza.poliza_documentos || []).filter(d => d.tipo === 'factura' && parseFloat(d.monto) > 0)
  if (facturas.length > 0) return facturas.reduce((s, d) => s + (parseFloat(d.monto) || 0), 0)
  return parseFloat(poliza.prima) || 0
}
// Prima "vigente" de una póliza para efectos de cuenta corriente, YA CONVERTIDA A PESOS (ver
// enPesos más arriba — si la póliza es ARS, es el monto tal cual): la original (o la de factura,
// ver primaRealPoliza) + toda renovación por período que NO haya sido anulada retroactivamente
// (puede diferir de la prima original por reajuste — cada renovación trae su propio monto Y su
// propio tipo de cambio, si la póliza es USD).
function primaConRenovaciones(poliza, renovaciones) {
  const propias = renovaciones.filter(r => r.poliza_id === poliza.id && !r.anulada)
  const primaPesos = enPesos(primaRealPoliza(poliza), poliza.moneda, poliza.tipo_cambio)
  return primaPesos + propias.reduce((s, r) => s + enPesos(r.monto, poliza.moneda, r.tipo_cambio), 0)
}

// Lista de "movimientos" de una póliza (la prima original + cada renovación por período) en orden
// cronológico, cada uno con su propio estado de PAGO. Como pagos_poliza registra los pagos contra
// la póliza como un todo (no contra un período puntual), el estado de cada movimiento se deriva
// repartiendo el total pagado en orden — primero se cubre la prima, después la renovación más
// vieja, y así siguiendo (FIFO). Una renovación anulada retroactivamente no entra en el reparto
// (no es deuda real) y se muestra aparte, marcada como tal.
// `monto` de cada ítem queda YA CONVERTIDO A PESOS (con lo que se suma/compara/reparte el FIFO);
// `montoOriginal`/`moneda`/`tipoCambio` se conservan aparte para poder mostrar en pantalla "U$S 1.000
// (≈ $1.234.000 al TC 1.234)" en vez de perder el dato de en qué moneda estaba realmente el documento.
function movimientosPoliza(poliza, renovaciones, pagos) {
  const moneda = poliza.moneda || 'ARS'
  const renovacionesDeLaPoliza = (renovaciones || []).filter(r => r.poliza_id === poliza.id)
  // Si ya hay factura(s) real(es) cargada(s), usamos su monto (y su fecha, más precisa que
  // fecha_emision) en vez de poliza.prima — ver primaRealPoliza.
  const facturasPoliza = (poliza.poliza_documentos || []).filter(d => d.tipo === 'factura' && parseFloat(d.monto) > 0)
  const primaReal = primaRealPoliza(poliza)
  const items = [
    { tipo: 'prima', id: `prima-${poliza.id}`, fecha: (facturasPoliza[0]?.fecha) || poliza.fecha_emision || poliza.fecha_inicio || null,
      montoOriginal: primaReal, moneda, tipoCambio: poliza.tipo_cambio,
      monto: enPesos(primaReal, moneda, poliza.tipo_cambio), anulada: false,
      label: facturasPoliza.length > 0 ? 'Prima (según factura)' : 'Prima original' },
    ...renovacionesDeLaPoliza.map(r => ({
      tipo: 'renovacion', id: r.id, fecha: r.periodo_hasta,
      montoOriginal: parseFloat(r.monto) || 0, moneda, tipoCambio: r.tipo_cambio,
      monto: enPesos(r.monto, moneda, r.tipo_cambio), anulada: !!r.anulada,
      label: `Renovación hasta ${fmtFechaAR(r.periodo_hasta)}${!r.anulada && !r.confirmado ? ' (provisorio, a confirmar)' : ''}`, observaciones: r.observaciones, motivo_anulacion: r.motivo_anulacion,
    })),
  ].sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''))

  let restante = (pagos || []).filter(pg => pg.poliza_id === poliza.id).reduce((s, pg) => s + (parseFloat(pg.monto) || 0), 0)
  return items.map(item => {
    if (item.anulada) return { ...item, estadoPago: 'anulada', pagadoMonto: 0, saldoMonto: 0 }
    if (item.monto <= 0) return { ...item, estadoPago: 'pagado', pagadoMonto: 0, saldoMonto: 0 }
    let pagadoMonto, estadoPago
    if (restante >= item.monto) { pagadoMonto = item.monto; estadoPago = 'pagado'; restante -= item.monto }
    else if (restante > 0) { pagadoMonto = restante; estadoPago = 'parcial'; restante = 0 }
    else { pagadoMonto = 0; estadoPago = 'pendiente' }
    return { ...item, estadoPago, pagadoMonto, saldoMonto: item.monto - pagadoMonto }
  })
}

function agruparPolizas(polizas, pagos, renovaciones, campo, diasAviso = DIAS_AVISO_VENCIMIENTO) {
  const grupos = {}
  polizas.forEach(p => {
    const raw = (p[campo] || '').trim()
    const key = raw || (campo === 'corredor' ? 'Sin corredor' : 'Sin especificar')
    if (!grupos[key]) grupos[key] = { nombre: key, polizas: [], totalPrima: 0, totalPagado: 0 }
    grupos[key].polizas.push({ ...p, movimientos: movimientosPoliza(p, renovaciones, pagos), estadoVenc: estadoVencimiento(p, renovaciones, diasAviso) })
    grupos[key].totalPrima += primaConRenovaciones(p, renovaciones)
  })
  pagos.forEach(pg => {
    for (const g of Object.values(grupos)) {
      if (g.polizas.some(p => p.id === pg.poliza_id)) { g.totalPagado += parseFloat(pg.monto) || 0; break }
    }
  })
  return Object.values(grupos).map(g => ({ ...g, saldo: g.totalPrima - g.totalPagado })).sort((a, b) => b.saldo - a.saldo)
}

// Mini-tabla de subtotales (saldo teórico) por un agrupador — se muestra siempre para aseguradora
// Y corredor a la vez arriba de la lista detallada, para no tener que ir cambiando el toggle.
function ResumenSubtotales({ titulo, icono, grupos }) {
  return (
    <div style={{ ...cardSt, padding: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>{icono} {titulo}</div>
      {grupos.length === 0 ? <div style={{ fontSize: 11, color: C.textFaint }}>Sin datos.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {grupos.map(g => (
            <div key={g.nombre} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
              <span style={{ color: C.textMuted }}>{g.nombre}</span>
              <span style={{ color: g.saldo > 0 ? '#C62828' : C.green, fontWeight: 600 }}>{fmtDec(g.saldo)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const FILTROS_CUENTA_CORRIENTE = [
  { id: 'todas', label: 'Todas' },
  { id: 'vencidas', label: '🔴 Vencidas' },
  { id: 'por_vencer', label: '🟠 Por vencer' },
  { id: 'con_saldo', label: '💳 Con saldo pendiente' },
]

// ── Modal: opciones de exportación del Excel de Cuenta Corriente ──
// Antes el botón exportaba SIEMPRE exactamente lo que estaba filtrado en pantalla, sin forma de
// pedir "todas las pólizas" ni acotar por rango de fechas (pedido del usuario, setiembre 2026).
function ModalExportarCC({ polizasTodas, polizasPantalla, pagos, renovaciones, diasAviso, agrupador, onClose }) {
  const [alcance, setAlcance] = useState('pantalla') // 'pantalla' | 'todas' | 'con_saldo'
  const [fechaDesde, setFechaDesde] = useState('')
  const [fechaHasta, setFechaHasta] = useState('')

  const exportar = () => {
    let base = alcance === 'pantalla' ? polizasPantalla : polizasTodas
    if (alcance === 'con_saldo') {
      base = polizasTodas.filter(p => movimientosPoliza(p, renovaciones, pagos).some(m => !m.anulada && m.saldoMonto > 0))
    }
    const grupos = agruparPolizas(base, pagos, renovaciones, agrupador, diasAviso)
    exportarCuentaCorrienteSeguros(grupos, agrupador, { fechaDesde: fechaDesde || null, fechaHasta: fechaHasta || null })
    onClose()
  }

  return (
    <Modal title="Exportar a Excel" onClose={onClose} guardarLabel="Exportar" onGuardar={exportar}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Campo label="Qué pólizas incluir">
          <select style={inputSt} value={alcance} onChange={e => setAlcance(e.target.value)}>
            <option value="pantalla">Lo que estoy viendo ahora (mismo filtro de pantalla)</option>
            <option value="todas">Todas las pólizas, sin filtro</option>
            <option value="con_saldo">Solo las que tienen saldo pendiente</option>
          </select>
        </Campo>
        <Campo label="Rango de fechas (opcional) — filtra los movimientos por su fecha">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <input type="date" style={inputSt} value={fechaDesde} onChange={e => setFechaDesde(e.target.value)} />
            <input type="date" style={inputSt} value={fechaHasta} onChange={e => setFechaHasta(e.target.value)} />
          </div>
          <div style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}>
            Dejalo vacío para incluir todo. Si cargás un rango, la hoja "Resumen" muestra la prima/pagado/saldo SOLO de los movimientos de ese período, no el saldo de vida completa de la póliza.
          </div>
        </Campo>
      </div>
    </Modal>
  )
}

function CuentaCorrienteAseguradoras({ polizas, pagos, renovaciones, diasAviso, onGuardarDiasAviso, onRegistrarPago }) {
  const [agrupador, setAgrupador] = useState('aseguradora') // 'aseguradora' | 'corredor'
  const [filtro, setFiltro] = useState('todas')
  const [editandoDias, setEditandoDias] = useState(false)
  const [diasInput, setDiasInput] = useState(diasAviso)
  const [modalExportar, setModalExportar] = useState(false)
  useEffect(() => { setDiasInput(diasAviso) }, [diasAviso])

  const pasaFiltro = (poliza) => {
    if (filtro === 'todas') return true
    if (filtro === 'con_saldo') return movimientosPoliza(poliza, renovaciones, pagos).some(m => !m.anulada && m.saldoMonto > 0)
    const ev = estadoVencimiento(poliza, renovaciones, diasAviso)
    if (filtro === 'vencidas') return ev.estado === 'vencida'
    if (filtro === 'por_vencer') return ev.estado === 'por_vencer'
    return true
  }
  const polizasFiltradas = polizas.filter(pasaFiltro)

  const gruposAseguradora = agruparPolizas(polizasFiltradas, pagos, renovaciones, 'aseguradora', diasAviso)
  const gruposCorredor = agruparPolizas(polizasFiltradas, pagos, renovaciones, 'corredor', diasAviso)
  const grupos = agrupador === 'aseguradora' ? gruposAseguradora : gruposCorredor
  const icono = agrupador === 'aseguradora' ? '🏢' : '🧑‍💼'

  const guardarDias = async () => { await onGuardarDiasAviso(diasInput); setEditandoDias(false) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <ResumenSubtotales titulo="Subtotales por aseguradora" icono="🏢" grupos={gruposAseguradora} />
        <ResumenSubtotales titulo="Subtotales por corredor" icono="🧑‍💼" grupos={gruposCorredor} />
      </div>

      <div style={{ ...cardSt, padding: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: C.textMuted }}>
        <span>⏰ Avisar "por vencer" con</span>
        {editandoDias ? (
          <>
            <input type="number" min="0" value={diasInput} onChange={e => setDiasInput(e.target.value)}
              style={{ width: 60, padding: '3px 6px', fontSize: 12, border: `1px solid ${C.border}`, borderRadius: 6, fontFamily: "'Outfit', sans-serif" }} />
            <span>día(s) de anticipación</span>
            <button onClick={guardarDias} style={{ background: 'none', border: 'none', color: C.purple, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>Guardar</button>
            <button onClick={() => { setDiasInput(diasAviso); setEditandoDias(false) }} style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 12, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>Cancelar</button>
          </>
        ) : (
          <>
            <strong style={{ color: C.text }}>{diasAviso}</strong>
            <span>día(s) de anticipación</span>
            <button onClick={() => setEditandoDias(true)} style={{ background: 'none', border: 'none', color: C.purple, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>✏️ Cambiar</button>
          </>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {[{ id: 'aseguradora', label: '🏢 Por aseguradora' }, { id: 'corredor', label: '🧑‍💼 Por corredor' }].map(t => (
            <button key={t.id} onClick={() => setAgrupador(t.id)} style={{ padding: '5px 12px', fontSize: 11, cursor: 'pointer', border: `1px solid ${C.border}`, borderRadius: 8, fontFamily: "'Outfit', sans-serif", fontWeight: agrupador === t.id ? 600 : 400, background: agrupador === t.id ? C.purpleDim : C.surface, color: agrupador === t.id ? C.purple : C.textMuted }}>{t.label}</button>
          ))}
        </div>
        <BtnSecondary onClick={() => setModalExportar(true)}>⬇️ Exportar a Excel</BtnSecondary>
      </div>
      {modalExportar && (
        <ModalExportarCC
          polizasTodas={polizas} polizasPantalla={polizasFiltradas} pagos={pagos} renovaciones={renovaciones}
          diasAviso={diasAviso} agrupador={agrupador} onClose={() => setModalExportar(false)}
        />
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {FILTROS_CUENTA_CORRIENTE.map(t => (
          <button key={t.id} onClick={() => setFiltro(t.id)} style={{ padding: '5px 12px', fontSize: 11, cursor: 'pointer', border: `1px solid ${C.border}`, borderRadius: 8, fontFamily: "'Outfit', sans-serif", fontWeight: filtro === t.id ? 600 : 400, background: filtro === t.id ? C.purpleDim : C.surface, color: filtro === t.id ? C.purple : C.textMuted }}>{t.label}</button>
        ))}
      </div>

      {grupos.length === 0 ? <EmptyState texto="No hay pólizas que coincidan con este filtro." /> : grupos.map(g => (
        <div key={g.nombre} style={{ ...cardSt, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{icono} {g.nombre}</div>
            <BtnSecondary onClick={() => onRegistrarPago(g.polizas)}>+ Registrar pago</BtnSecondary>
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
            <span>Prima total: <strong style={{ color: C.text }}>{fmtDec(g.totalPrima)}</strong></span>
            <span>Pagado: <strong style={{ color: C.green }}>{fmtDec(g.totalPagado)}</strong></span>
            <span>Saldo (teórico): <strong style={{ color: g.saldo > 0 ? '#C62828' : C.green }}>{fmtDec(g.saldo)}</strong></span>
            <span>{g.polizas.length} póliza(s)</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {g.polizas.map(p => (
              <div key={p.id} style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: 8, background: '#FBFBFD' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 12, marginBottom: 6 }}>
                  <span style={{ fontWeight: 600, color: C.text, display: 'flex', alignItems: 'center', gap: 6 }}>{p.nro_poliza || 's/n'} · {p.obras?.nombre}{agrupador === 'corredor' && p.aseguradora ? ` · ${p.aseguradora}` : ''} <MonedaBadge moneda={p.moneda} /></span>
                  <VencimientoBadge fecha={p.estadoVenc.corte} diasAviso={diasAviso} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {p.movimientos.map(m => (
                    <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 11, color: m.anulada ? '#AAA' : C.textMuted, textDecoration: m.anulada ? 'line-through' : 'none' }}>
                      <span>{m.label}{m.fecha ? ` (${fmtFechaAR(m.fecha)})` : ''}</span>
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        {m.moneda === 'USD'
                          ? <span>U$S {fmtDec(m.montoOriginal)} {m.tipoCambio > 0 ? <>≈ {fmtDec(m.monto)} <span style={{ color: C.textFaint }}>(TC {m.tipoCambio})</span></> : <span style={{ color: '#C62828' }}>(falta tipo de cambio)</span>}</span>
                          : fmtDec(m.monto)}
                        <EstadoPagoBadge estadoPago={m.estadoPago} />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Panel principal de Seguros ─────────────────────────────────
export default function Seguros() {
  const { obras, setObras, loading: loadingObras } = useObrasSeguros()
  const { polizas, setPolizas, loading: loadingPolizas } = usePolizas()
  const { pagos: pagosPoliza, setPagos: setPagosPoliza, loading: loadingPagos } = usePagosPoliza()
  const { renovaciones: renovacionesPoliza, setRenovaciones: setRenovacionesPoliza, loading: loadingRenovaciones } = useRenovacionesPoliza()
  const bancos = useBancosSeguros()
  const clientes = useClientesSeguros()
  const { proveedores, setProveedores } = useProveedoresSeguros()
  const { diasAviso, guardarDiasAviso } = useConfiguracionSeguros()

  const [vista, setVista] = useState('obras') // 'obras' | 'cuentaCorriente'
  const [filtroEtapa, setFiltroEtapa] = useState('todas') // 'todas' | 'oferta' | 'ejecucion'
  const [filtroPoliza, setFiltroPoliza] = useState('todas') // 'todas' | 'sin' | 'con' — setiembre 2026: separa las obras sin póliza cargada de las que ya tienen, en vez de mezclarlas todas juntas
  const [mostrarFinalizadas, setMostrarFinalizadas] = useState(false)
  const [soloFinalizadasPendientes, setSoloFinalizadasPendientes] = useState(false)
  const [modal, setModal] = useState(null) // 'nuevaObra' | 'editarObra' | 'poliza' | 'documento' | 'recepcion' | 'confirmarBaja' | 'pago' | 'renovacion' | 'confirmarRenovacion'
  const [obraParaEditar, setObraParaEditar] = useState(null)
  const [obraIdParaPoliza, setObraIdParaPoliza] = useState('')
  const [polizaParaEditar, setPolizaParaEditar] = useState(null)
  const [polizaParaDocumento, setPolizaParaDocumento] = useState(null)
  const [obraParaRecepcion, setObraParaRecepcion] = useState(null)
  const [tipoRecepcion, setTipoRecepcion] = useState(null)
  const [polizaParaBaja, setPolizaParaBaja] = useState(null)
  const [polizasParaPago, setPolizasParaPago] = useState(null)
  const [polizaParaRenovacion, setPolizaParaRenovacion] = useState(null)
  const [polizaParaFactura, setPolizaParaFactura] = useState(null)
  const [renovacionParaConfirmar, setRenovacionParaConfirmar] = useState(null)

  const alertas = calcularAlertas(polizas, renovacionesPoliza, diasAviso)
  // Obras adjudicadas (etapa 'ejecucion') que requieren póliza pero todavía tienen 0 cargadas — no
  // debería poder llegar a ejecución sin haber presentado antes la garantía de oferta (setiembre 2026,
  // detectado por el usuario). Es solo alerta visible, no bloquea nada.
  const obrasSinGarantiaAdjudicada = obras.filter(o => o.etapa === 'ejecucion' && o.requiere_poliza !== false && !polizas.some(p => p.obra_id === o.id))
  const loading = loadingObras || loadingPolizas || loadingPagos || loadingRenovaciones

  // "Vigente" = todavía no llegó a Recepción Definitiva (o está en oferta). Por defecto se ocultan
  // las obras ya finalizadas para que esta sea la lista de obras vigentes.
  const obrasVigentes = obras.filter(o => o.estado_licitacion !== 'recepcion_definitiva')
  // El filtro "Finalizadas c/ pólizas pendientes" busca en TODAS las obras (ignora vigentes/mostrarFinalizadas)
  // porque el punto es justamente encontrar las que el resto de la app ya da por terminadas.
  const esFinalizadaConPendientes = (o) => o.estado === 'finalizada' && polizas.some(p => p.obra_id === o.id && p.estado_admin !== 'dada_de_baja')
  // Las obras marcadas "sin póliza requerida" no tienen nada para hacer en esta sección — se
  // excluyen siempre (setiembre 2026, a pedido del usuario) en vez de aparecer mezcladas con badge.
  const baseObras = (soloFinalizadasPendientes ? obras : (mostrarFinalizadas ? obras : obrasVigentes))
    .filter(o => o.requiere_poliza !== false)
  const obrasFiltradas = (filtroEtapa === 'todas' ? baseObras : baseObras.filter(o => o.etapa === filtroEtapa))
    .filter(o => !soloFinalizadasPendientes || esFinalizadaConPendientes(o))
    // "Sin póliza cargada" vs "Con póliza": separa en vez de mezclar todo junto (setiembre 2026).
    .filter(o => {
      if (filtroPoliza === 'todas') return true
      const tienePoliza = polizas.some(p => p.obra_id === o.id)
      return filtroPoliza === 'con' ? tienePoliza : !tienePoliza
    })

  // `organismo` se mantiene como parámetro solo para el alta rápida desde la IA leyendo una póliza
  // (`ModalPoliza` → "+ Crear obra", que solo tiene el texto que la IA extrajo, no un cliente_id) —
  // el alta manual ("+ Obra en oferta", vía ModalObraCompartido) ya pide cliente vinculado en vez de
  // ese texto libre (setiembre 2026, ver nombreOrganismoObra()/CLAUDE.md). La etapa inicial depende
  // de si requiere garantía de OFERTA específicamente, no de que se haya creado desde este panel
  // ni de si requiere pólizas en general (`etapaInicial` — una obra puede requerir pólizas, p.ej.
  // por adjudicación directa, sin requerir garantía de oferta, y arrancar directo en ejecución).
  const crearObra = async ({ nombre, detalle, cliente_id, organismo, monto_contrato, presupuesto, requiere_poliza, requiere_garantia_oferta, excluir_gastos_generales }) => {
    if (!nombre?.trim()) { toast('El nombre es obligatorio'); return null }
    const requierePoliza = requiere_poliza !== false
    const requiereGarantiaOferta = requiere_garantia_oferta !== false
    const payload = { nombre: nombre.trim(), detalle: detalle?.trim() || null, cliente_id: cliente_id || null, organismo: organismo || null, monto_contrato: parseFloat(monto_contrato) || null, presupuesto: parseFloat(presupuesto) || 0, requiere_poliza: requierePoliza, requiere_garantia_oferta: requiereGarantiaOferta, excluir_gastos_generales: !!excluir_gastos_generales, etapa: etapaInicial(requierePoliza, requiereGarantiaOferta), estado_licitacion: 'en_curso' }
    const nueva = await dbWrite('POST', 'obras', payload, null, true)
    if (nueva?.id) { setObras(prev => [{ ...payload, ...nueva }, ...prev]); toast('Obra creada', 'ok') }
    return nueva
  }

  // Editar una obra ya creada desde Seguros — hacía falta sobre todo para las obras en etapa
  // "oferta": esas no aparecen en el panel principal de Obras (ver obrasOperativas en GestorObras.jsx)
  // hasta que se adjudican, así que hasta ahora no había ninguna forma de corregirles un dato (cliente,
  // nombre, detalle) mientras estaban en esa etapa — se detectó este gap al cargar una obra real desde
  // un pliego (octubre 2026). No toca etapa/estado_licitacion — eso sigue yendo por cambiarEtapa/onPedirRecepcion.
  const editarObra = async (obraId, { nombre, detalle, cliente_id, monto_contrato, presupuesto, requiere_poliza, requiere_garantia_oferta, excluir_gastos_generales }) => {
    if (!nombre?.trim()) { toast('El nombre es obligatorio'); return }
    const payload = { nombre: nombre.trim(), detalle: detalle?.trim() || null, cliente_id: cliente_id || null, monto_contrato: parseFloat(monto_contrato) || null, presupuesto: parseFloat(presupuesto) || 0, requiere_poliza: requiere_poliza !== false, requiere_garantia_oferta: requiere_garantia_oferta !== false, excluir_gastos_generales: !!excluir_gastos_generales }
    await dbWrite('PATCH', 'obras', payload, `id=eq.${obraId}`)
    setObras(prev => prev.map(o => o.id === obraId ? { ...o, ...payload } : o))
    toast('Obra actualizada', 'ok')
  }

  const cambiarEtapa = async (obra, etapa) => {
    if (!window.confirm(`¿Marcar "${obra.nombre}" como adjudicada / en ejecución? A partir de ahora esta obra va a aparecer también en el panel principal de Obras, gastos y finanzas.`)) return
    await dbWrite('PATCH', 'obras', { etapa }, `id=eq.${obra.id}`)
    setObras(prev => prev.map(o => o.id === obra.id ? { ...o, etapa } : o))
    toast('Obra actualizada — ya aparece en el resto de la app', 'ok')
  }

  const guardarRecepcion = async ({ estado_licitacion, url }) => {
    const obra = obraParaRecepcion
    const payload = { estado_licitacion }
    if (url) payload[estado_licitacion === 'recepcion_provisoria' ? 'recepcion_provisoria_url' : 'recepcion_definitiva_url'] = url
    await dbWrite('PATCH', 'obras', payload, `id=eq.${obra.id}`)
    setObras(prev => prev.map(o => o.id === obra.id ? { ...o, ...payload } : o))
    setModal(null); setObraParaRecepcion(null); setTipoRecepcion(null)
    toast('Obra actualizada', 'ok')
  }

  const marcarBajaPresentada = async (poliza) => {
    if (!window.confirm('¿Confirmás que ya le presentaste la recepción de obra a la aseguradora pidiendo la baja?')) return
    await dbWrite('PATCH', 'polizas', { estado_admin: 'baja_presentada' }, `id=eq.${poliza.id}`)
    setPolizas(prev => prev.map(p => p.id === poliza.id ? { ...p, estado_admin: 'baja_presentada' } : p))
    toast('Póliza marcada como baja presentada', 'ok')
  }

  const guardarConfirmacionBaja = async ({ url }) => {
    const poliza = polizaParaBaja
    await dbWrite('PATCH', 'polizas', { estado_admin: 'dada_de_baja' }, `id=eq.${poliza.id}`)
    let doc = null
    if (url) doc = await dbWrite('POST', 'poliza_documentos', { poliza_id: poliza.id, tipo: 'baja_aseguradora', archivo_url: url, nombre_archivo: null }, null, true)
    setPolizas(prev => prev.map(p => p.id === poliza.id ? { ...p, estado_admin: 'dada_de_baja', poliza_documentos: doc ? [...(p.poliza_documentos || []), doc] : p.poliza_documentos } : p))
    setModal(null); setPolizaParaBaja(null)
    toast('Baja confirmada', 'ok')
  }

  // Crea una póliza nueva, o actualiza una existente si form.id está presente (edición).
  const guardarPoliza = async (form) => {
    const { id, archivo_url, obra_id, tipo_cobertura, aseguradora, corredor, nro_poliza, monto_asegurado, prima, prima_fuente,
      moneda, tipo_cambio, fecha_tipo_cambio,
      fecha_emision, fecha_inicio, fecha_vencimiento, notas, tipo_vigencia, requiere_final_obra,
      clausula_repeticion, clausulas_especiales, descripcion_ia, se_autorenueva, duracion_periodo_dias } = form
    const campos = {
      obra_id, tipo_cobertura, aseguradora: aseguradora || null, corredor: corredor || null, nro_poliza: nro_poliza || null,
      monto_asegurado, prima, prima_fuente: prima ? (prima_fuente || null) : null,
      moneda: moneda || 'ARS', tipo_cambio: moneda === 'USD' ? (tipo_cambio ?? null) : null, fecha_tipo_cambio: moneda === 'USD' ? (fecha_tipo_cambio || null) : null,
      fecha_emision: fecha_emision || null, fecha_inicio: fecha_inicio || null, fecha_vencimiento: fecha_vencimiento || null,
      notas: notas || null, tipo_vigencia: tipo_vigencia || null, requiere_final_obra: requiere_final_obra === undefined ? null : requiere_final_obra,
      clausula_repeticion: clausula_repeticion || 'no_especifica', clausulas_especiales: clausulas_especiales || null, descripcion_ia: descripcion_ia || null,
      se_autorenueva: se_autorenueva === undefined ? null : se_autorenueva,
      duracion_periodo_dias: duracion_periodo_dias === '' || duracion_periodo_dias == null ? null : parseInt(duracion_periodo_dias, 10),
    }
    if (id) {
      await dbWrite('PATCH', 'polizas', campos, `id=eq.${id}`)
      setPolizas(prev => prev.map(p => p.id === id ? { ...p, ...campos, obras: obras.find(o => o.id === obra_id) || p.obras } : p))
      setModal(null); setPolizaParaEditar(null)
      toast('Póliza actualizada', 'ok')
      return
    }
    const nueva = await dbWrite('POST', 'polizas', { ...campos, estado_admin: 'activa' }, null, true)
    if (!nueva?.id) throw new Error('No se pudo guardar la póliza')
    let documentos = []
    if (archivo_url) {
      const doc = await dbWrite('POST', 'poliza_documentos', { poliza_id: nueva.id, tipo: 'poliza', archivo_url, nombre_archivo: null }, null, true)
      if (doc) documentos = [doc]
    }
    setPolizas(prev => [{ ...nueva, obras: obras.find(o => o.id === obra_id), poliza_documentos: documentos }, ...prev])
    setModal(null)
    toast('Póliza guardada', 'ok')
  }

  // Elimina una póliza y sus documentos. Los pagos ya registrados se desvinculan (los gastos que ya
  // generaron NO se borran — la plata realmente se gastó, sigue en la contabilidad de la obra).
  const eliminarPoliza = async (poliza) => {
    const pagosDeEsta = pagosPoliza.filter(pg => pg.poliza_id === poliza.id)
    const msg = pagosDeEsta.length
      ? `Esta póliza tiene ${pagosDeEsta.length} pago(s) registrado(s) en la cuenta corriente. Al eliminarla se desvinculan esos pagos (los gastos que ya generaron en la obra NO se borran) y se borra la póliza junto con sus documentos. ¿Confirmás?`
      : `¿Eliminar la póliza ${poliza.nro_poliza || 's/n'}? Se borran también sus documentos adjuntos. Esta acción no se puede deshacer.`
    if (!window.confirm(msg)) return
    await dbWrite('DELETE', 'poliza_documentos', null, `poliza_id=eq.${poliza.id}`)
    await dbWrite('DELETE', 'pagos_poliza', null, `poliza_id=eq.${poliza.id}`)
    // renovaciones_poliza tiene ON DELETE CASCADE desde polizas, pero igual la limpiamos acá
    // explícitamente para no depender de eso y mantener el estado local consistente al toque.
    await dbWrite('DELETE', 'renovaciones_poliza', null, `poliza_id=eq.${poliza.id}`)
    await dbWrite('DELETE', 'polizas', null, `id=eq.${poliza.id}`)
    setPolizas(prev => prev.filter(p => p.id !== poliza.id))
    setPagosPoliza(prev => prev.filter(pg => pg.poliza_id !== poliza.id))
    setRenovacionesPoliza(prev => prev.filter(r => r.poliza_id !== poliza.id))
    toast('Póliza eliminada', 'ok')
  }

  const guardarDocumento = async ({ tipo, archivo_url, nombre_archivo }) => {
    const doc = await dbWrite('POST', 'poliza_documentos', { poliza_id: polizaParaDocumento.id, tipo, archivo_url, nombre_archivo }, null, true)
    setPolizas(prev => prev.map(p => p.id === polizaParaDocumento.id ? { ...p, poliza_documentos: [...(p.poliza_documentos || []), doc] } : p))
    setModal(null); setPolizaParaDocumento(null)
    toast('Documento agregado', 'ok')
  }

  // Cargar la factura de una póliza: sube el documento (tipo 'factura') y genera un gasto
  // PENDIENTE (pagado=false) en la obra por ese monto — la factura es la fuente real de lo que
  // hay que pagar, no siempre coincide con lo que la IA leyó de la carátula de la póliza.
  const guardarFactura = async (form) => {
    if (!polizaParaFactura) return
    const { archivo_url, nombre_archivo, monto, fecha, nro_factura, tipo_comprobante } = form
    let proveedor_id = null
    const nombreProv = nombreProveedorPoliza(polizaParaFactura)
    if (nombreProv) {
      const prov = await resolverProveedorPorNombre(nombreProv, proveedores)
      if (prov) { proveedor_id = prov.id; if (!proveedores.some(p => p.id === prov.id)) setProveedores(prev => [...prev, prov]) }
    }
    const nuevoGasto = await dbWrite('POST', 'gastos', {
      obra_id: polizaParaFactura.obra_id,
      proveedor_id,
      fecha,
      concepto: 'seguros',
      descripcion: `Factura prima póliza ${polizaParaFactura.nro_poliza || 's/n'} — ${polizaParaFactura.aseguradora || 'aseguradora s/e'}${nro_factura ? ` (Fact. ${nro_factura})` : ''}`,
      monto,
      tipo_comprobante: tipo_comprobante || 'otro',
      discrimina_iva: false,
      pagado: false,
    }, null, true)
    // monto/fecha quedan guardados acá (no solo en el gasto) porque son los que usa primaRealPoliza()
    // para la cuenta corriente con la aseguradora — así no depende de ir a buscar el gasto vinculado.
    const doc = await dbWrite('POST', 'poliza_documentos', {
      poliza_id: polizaParaFactura.id, tipo: 'factura', archivo_url, nombre_archivo, gasto_id: nuevoGasto?.id || null,
      monto, fecha,
    }, null, true)
    setPolizas(prev => prev.map(p => p.id === polizaParaFactura.id ? { ...p, poliza_documentos: [...(p.poliza_documentos || []), doc] } : p))
    setModal(null); setPolizaParaFactura(null)
    toast('Factura cargada — se generó un gasto pendiente de pago en la obra', 'ok')
  }

  // Registrar un pago de prima: impacta la cuenta corriente con la aseguradora Y se refleja como
  // gasto (+ pago) en la obra correspondiente. Si esta póliza tiene una factura pendiente (gasto
  // pagado=false, generado por guardarFactura), liquidamos ESE gasto en vez de crear uno nuevo —
  // así no se duplica el gasto de la obra cuando primero se cargó la factura y después se pagó.
  // `form.polizas` es un array de { poliza_id, monto } — una o más (ver ModalPagoPoliza: desde
  // octubre 2026 una sola transferencia puede liquidar varias pólizas a la vez). El resto de los
  // datos (fecha, medio de pago, banco, comprobante, observaciones) es común a todas porque
  // físicamente fue un solo movimiento bancario — cada póliza genera su propio gasto/pago (o
  // liquida su factura pendiente si ya tenía una cargada), pero todos comparten esos datos.
  const guardarPagoPoliza = async (form) => {
    const { polizas: seleccion, fecha_pago, medio_pago, banco_id, nro_operacion, observaciones, comprobante_url } = form
    if (!seleccion || seleccion.length === 0) throw new Error('No hay ninguna póliza con monto a pagar')
    const pagosNuevos = []
    let liquidaronFactura = 0
    // Copia local de los proveedores conocidos — se va actualizando DENTRO de este loop a medida
    // que se crean nuevos, para que si dos pólizas de esta misma tanda comparten aseguradora/corredor
    // (el caso típico: una transferencia que paga varias pólizas de la misma compañía) la segunda
    // encuentre el proveedor que acaba de crear la primera en vez de duplicarlo. Recién al final se
    // sincroniza el estado de React una sola vez con los que realmente se crearon.
    let proveedoresCache = proveedores
    const proveedoresNuevos = []
    for (const { poliza_id, monto } of seleccion) {
      const poliza = polizas.find(p => p.id === poliza_id)
      if (!poliza) continue

      // Buscamos el gasto pendiente vinculado a alguna factura de esta póliza consultando directo,
      // porque `poliza.poliza_documentos` no trae el estado `pagado` del gasto (solo el gasto_id).
      let gastoAUsar = null
      const docsFactura = (poliza.poliza_documentos || []).filter(d => d.tipo === 'factura' && d.gasto_id)
      if (docsFactura.length > 0) {
        const { data: gastosPendientes } = await supabase.from('gastos').select('id, pagado, proveedor_id').in('id', docsFactura.map(d => d.gasto_id)).eq('pagado', false)
        if (gastosPendientes && gastosPendientes.length > 0) gastoAUsar = gastosPendientes[0]
      }

      // Se resuelve el proveedor (corredor/aseguradora) salvo que ya se vaya a liquidar un gasto
      // pendiente que YA tenga uno cargado — si es uno viejo (de antes de este arreglo, octubre
      // 2026) sin proveedor_id, se lo completamos acá mismo al liquidarlo.
      let proveedor_id = null
      if (!gastoAUsar || !gastoAUsar.proveedor_id) {
        const nombreProv = nombreProveedorPoliza(poliza)
        if (nombreProv) {
          const prov = await resolverProveedorPorNombre(nombreProv, proveedoresCache)
          if (prov) {
            proveedor_id = prov.id
            if (!proveedoresCache.some(p => p.id === prov.id)) { proveedoresCache = [...proveedoresCache, prov]; proveedoresNuevos.push(prov) }
          }
        }
      }

      let gastoId
      if (gastoAUsar) {
        await dbWrite('PATCH', 'gastos', { pagado: true, monto, fecha: fecha_pago, tipo_comprobante: comprobante_url ? 'recibo' : undefined, proveedor_id: gastoAUsar.proveedor_id || proveedor_id }, `id=eq.${gastoAUsar.id}`)
        gastoId = gastoAUsar.id
        liquidaronFactura++
      } else {
        const nuevoGasto = await dbWrite('POST', 'gastos', {
          obra_id: poliza.obra_id,
          proveedor_id,
          fecha: fecha_pago,
          concepto: 'seguros',
          descripcion: `Prima póliza ${poliza.nro_poliza || 's/n'} — ${poliza.aseguradora || 'aseguradora s/e'}`,
          monto,
          tipo_comprobante: comprobante_url ? 'recibo' : 'sin_comprobante',
          discrimina_iva: false,
          pagado: true,
        }, null, true)
        gastoId = nuevoGasto?.id || null
      }
      if (gastoId) {
        await dbWrite('POST', 'pagos', { gasto_id: gastoId, fecha_pago, medio_pago: medio_pago || 'transferencia', monto, banco_id: banco_id || null, nro_operacion: nro_operacion || null, comprobante_url: comprobante_url || null, observaciones: observaciones || null })
      }
      const nuevoPago = await dbWrite('POST', 'pagos_poliza', {
        poliza_id: poliza.id, fecha_pago, monto, medio_pago: medio_pago || 'transferencia',
        banco_id: banco_id || null, nro_operacion: nro_operacion || null, comprobante_url: comprobante_url || null,
        observaciones: observaciones || null, gasto_id: gastoId || null,
      }, null, true)
      if (nuevoPago) pagosNuevos.push(nuevoPago)
    }
    if (pagosNuevos.length > 0) setPagosPoliza(prev => [...pagosNuevos, ...prev])
    if (proveedoresNuevos.length > 0) setProveedores(prev => [...prev, ...proveedoresNuevos])
    setModal(null); setPolizasParaPago(null)
    const msg = seleccion.length > 1
      ? `Pago registrado en ${seleccion.length} pólizas${liquidaronFactura > 0 ? ` (${liquidaronFactura} liquidó factura pendiente)` : ''}`
      : (liquidaronFactura > 0 ? 'Pago registrado — se liquidó la factura pendiente de esta póliza' : 'Pago registrado y reflejado como gasto de la obra')
    toast(msg, 'ok')
  }

  // Registrar el cargo de una renovación automática por período (aumenta la deuda con la
  // aseguradora en la cuenta corriente, aparte de la prima original — no genera un gasto por sí
  // solo, igual que la prima original tampoco lo hace; el gasto se genera recién al pagarla con
  // "+ Registrar pago").
  const guardarRenovacion = async (form) => {
    if (!polizaParaRenovacion) return
    const nueva = await dbWrite('POST', 'renovaciones_poliza', {
      poliza_id: polizaParaRenovacion.id,
      periodo_desde: form.periodo_desde || null,
      periodo_hasta: form.periodo_hasta,
      monto: form.monto,
      tipo_cambio: form.tipo_cambio ?? null,
      fecha_tipo_cambio: form.fecha_tipo_cambio || null,
      observaciones: form.observaciones || null,
      confirmado: !!form.confirmado,
    }, null, true)
    if (nueva) setRenovacionesPoliza(prev => [nueva, ...prev])
    setModal(null); setPolizaParaRenovacion(null)
    toast(form.confirmado ? 'Renovación registrada — se sumó a la deuda con la aseguradora' : 'Renovación registrada como provisorio — confirmala cuando tengas el monto real', 'ok')
  }

  // Anular retroactivamente una renovación ya registrada: la recepción de obra tenía fecha
  // anterior al corte de ese período, así que la aseguradora anuló la renovación y no corresponde
  // que siga contando como deuda.
  const anularRenovacion = async (renovacion) => {
    const motivo = window.prompt('¿Por qué se anula esta renovación? (ej. "Recepción provisoria del 12/05, anterior al corte del 15/05")', '')
    if (motivo === null) return
    await dbWrite('PATCH', 'renovaciones_poliza', { anulada: true, motivo_anulacion: motivo || null }, `id=eq.${renovacion.id}`)
    setRenovacionesPoliza(prev => prev.map(r => r.id === renovacion.id ? { ...r, anulada: true, motivo_anulacion: motivo || null } : r))
    toast('Renovación anulada — ya no cuenta como deuda', 'ok')
  }

  // Confirmar (y opcionalmente corregir) el monto de una renovación cargada como estimación —
  // "provisorio, a confirmar" — apenas llega el estado de cuenta real de la aseguradora. Deja de
  // mostrarse como pendiente de confirmar en todos lados (FilaPoliza y Cuenta Corriente).
  const confirmarRenovacion = async (renovacion, form) => {
    await dbWrite('PATCH', 'renovaciones_poliza', { monto: form.monto, confirmado: true }, `id=eq.${renovacion.id}`)
    setRenovacionesPoliza(prev => prev.map(r => r.id === renovacion.id ? { ...r, monto: form.monto, confirmado: true } : r))
    setModal(null); setRenovacionParaConfirmar(null)
    toast('Renovación confirmada', 'ok')
  }

  if (loading) return <Spinner />

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>Seguros</h1>
          <p style={{ fontSize: 12, color: C.textMuted, margin: '3px 0 0' }}>{obrasVigentes.length} obra(s) vigente(s) · Control de pólizas y garantías por obra</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <BtnSecondary onClick={() => setModal('nuevaObra')}>+ Obra en oferta</BtnSecondary>
          <BtnPrimary onClick={() => { setObraIdParaPoliza(''); setPolizaParaEditar(null); setModal('poliza') }}>+ Cargar póliza</BtnPrimary>
        </div>
      </div>

      {(alertas.length > 0 || obrasSinGarantiaAdjudicada.length > 0) && (
        <div style={{ background: '#FFF0F0', border: '1px solid #FFDCDC', borderRadius: 12, padding: 14, marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#C62828', marginBottom: 6 }}>⚠️ {alertas.length + obrasSinGarantiaAdjudicada.length} situación(es) necesitan atención</div>
          <div style={{ fontSize: 12, color: '#8A3030' }}>Porque la obra ya cambió de estado, el vencimiento ya pasó o está cerca{obrasSinGarantiaAdjudicada.length > 0 ? `, o hay ${obrasSinGarantiaAdjudicada.length} obra(s) en ejecución sin ninguna póliza cargada todavía` : ''}. El detalle y la acción a tomar están en cada obra/póliza más abajo.</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {[{ id: 'obras', label: 'Obras y pólizas' }, { id: 'cuentaCorriente', label: '💳 Cuenta corriente' }].map(t => (
          <button key={t.id} onClick={() => setVista(t.id)} style={{ padding: '6px 14px', fontSize: 12, cursor: 'pointer', border: `1px solid ${C.border}`, borderRadius: 8, fontFamily: "'Outfit', sans-serif", fontWeight: vista === t.id ? 600 : 400, background: vista === t.id ? C.purpleDim : C.surface, color: vista === t.id ? C.purple : C.textMuted }}>{t.label}</button>
        ))}
      </div>

      {vista === 'obras' && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            {[{ id: 'todas', label: 'Todas' }, { id: 'oferta', label: '📋 En oferta' }, { id: 'ejecucion', label: '🏗️ En ejecución' }].map(t => (
              <button key={t.id} onClick={() => setFiltroEtapa(t.id)} style={{ padding: '6px 14px', fontSize: 12, cursor: 'pointer', border: `1px solid ${C.border}`, borderRadius: 8, fontFamily: "'Outfit', sans-serif", fontWeight: filtroEtapa === t.id ? 600 : 400, background: filtroEtapa === t.id ? C.purpleDim : C.surface, color: filtroEtapa === t.id ? C.purple : C.textMuted }}>{t.label}</button>
            ))}
            <div style={{ width: 1, alignSelf: 'stretch', background: C.border, margin: '0 2px' }} />
            {[{ id: 'todas', label: 'Con o sin póliza' }, { id: 'sin', label: '⚠️ Sin póliza cargada' }, { id: 'con', label: '✅ Con póliza' }].map(t => (
              <button key={t.id} onClick={() => setFiltroPoliza(t.id)} style={{ padding: '6px 14px', fontSize: 12, cursor: 'pointer', border: `1px solid ${C.border}`, borderRadius: 8, fontFamily: "'Outfit', sans-serif", fontWeight: filtroPoliza === t.id ? 600 : 400, background: filtroPoliza === t.id ? C.purpleDim : C.surface, color: filtroPoliza === t.id ? C.purple : C.textMuted }}>{t.label}</button>
            ))}
            <label style={{ marginLeft: 8, fontSize: 12, color: C.textMuted, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={mostrarFinalizadas} onChange={e => setMostrarFinalizadas(e.target.checked)} /> Mostrar obras finalizadas (Recepción Definitiva)
            </label>
            <label style={{ fontSize: 12, color: '#C62828', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontWeight: 600 }}>
              <input type="checkbox" checked={soloFinalizadasPendientes} onChange={e => setSoloFinalizadasPendientes(e.target.checked)} /> 🏁 Solo finalizadas (panel Obras) con pólizas pendientes de baja
            </label>
          </div>

          {obrasFiltradas.length === 0 ? <EmptyState texto="No hay obras en esta vista." /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {obrasFiltradas.map(o => (
                <FilaObra key={o.id} obra={o} polizasDeLaObra={polizas.filter(p => p.obra_id === o.id)}
                  pagosPoliza={pagosPoliza} renovacionesPoliza={renovacionesPoliza} alertas={alertas} diasAviso={diasAviso}
                  onCambiarEtapa={cambiarEtapa}
                  onPedirRecepcion={(obra, tipo) => { setObraParaRecepcion(obra); setTipoRecepcion(tipo); setModal('recepcion') }}
                  onNuevaPoliza={id => { setObraIdParaPoliza(id); setPolizaParaEditar(null); setModal('poliza') }}
                  onMarcarBajaPresentada={marcarBajaPresentada}
                  onConfirmarBaja={pz => { setPolizaParaBaja(pz); setModal('confirmarBaja') }}
                  onAgregarDocumento={pz => { setPolizaParaDocumento(pz); setModal('documento') }}
                  onAgregarFactura={pz => { setPolizaParaFactura(pz); setModal('factura') }}
                  onRegistrarPago={pz => { setPolizasParaPago([pz]); setModal('pago') }}
                  onRegistrarRenovacion={pz => { setPolizaParaRenovacion(pz); setModal('renovacion') }}
                  onAnularRenovacion={anularRenovacion}
                  onConfirmarRenovacion={r => { setRenovacionParaConfirmar(r); setModal('confirmarRenovacion') }}
                  onEditarPoliza={pz => { setPolizaParaEditar(pz); setModal('poliza') }}
                  onEliminarPoliza={eliminarPoliza}
                  onEditarObra={o => { setObraParaEditar(o); setModal('editarObra') }} />
              ))}
            </div>
          )}
        </>
      )}

      {vista === 'cuentaCorriente' && (
        <CuentaCorrienteAseguradoras polizas={polizas} pagos={pagosPoliza} renovaciones={renovacionesPoliza}
          diasAviso={diasAviso} onGuardarDiasAviso={guardarDiasAviso}
          onRegistrarPago={polizasGrupo => { setPolizasParaPago(polizasGrupo); setModal('pago') }} />
      )}

      {modal === 'nuevaObra' && <ModalObra clientes={clientes} onClose={() => setModal(null)} onGuardar={async d => { const n = await crearObra(d); if (n) setModal(null) }} />}
      {modal === 'editarObra' && obraParaEditar && <ModalObra itemEdit={obraParaEditar} clientes={clientes} onClose={() => { setModal(null); setObraParaEditar(null) }} onGuardar={async d => { await editarObra(obraParaEditar.id, d); setModal(null); setObraParaEditar(null) }} />}
      {modal === 'poliza' && <ModalPoliza obras={obras} obraIdDefecto={obraIdParaPoliza} polizaExistente={polizaParaEditar} onClose={() => { setModal(null); setPolizaParaEditar(null) }} onGuardar={guardarPoliza} onCrearObra={crearObra} />}
      {modal === 'documento' && polizaParaDocumento && <ModalDocumentoPoliza poliza={polizaParaDocumento} onClose={() => { setModal(null); setPolizaParaDocumento(null) }} onGuardar={guardarDocumento} />}
      {modal === 'factura' && polizaParaFactura && <ModalFacturaPoliza poliza={polizaParaFactura} onClose={() => { setModal(null); setPolizaParaFactura(null) }} onGuardar={guardarFactura} />}
      {modal === 'recepcion' && obraParaRecepcion && <ModalRecepcionObra obra={obraParaRecepcion} tipoRecepcion={tipoRecepcion} onClose={() => { setModal(null); setObraParaRecepcion(null); setTipoRecepcion(null) }} onGuardar={guardarRecepcion} />}
      {modal === 'confirmarBaja' && polizaParaBaja && <ModalConfirmarBaja poliza={polizaParaBaja} onClose={() => { setModal(null); setPolizaParaBaja(null) }} onGuardar={guardarConfirmacionBaja} />}
      {modal === 'pago' && polizasParaPago && <ModalPagoPoliza polizas={polizasParaPago} polizaIdDefecto={polizasParaPago[0]?.id} bancos={bancos} renovaciones={renovacionesPoliza} pagos={pagosPoliza} onClose={() => { setModal(null); setPolizasParaPago(null) }} onGuardar={guardarPagoPoliza} />}
      {modal === 'renovacion' && polizaParaRenovacion && <ModalRenovacionPoliza poliza={polizaParaRenovacion} renovaciones={renovacionesPoliza} onClose={() => { setModal(null); setPolizaParaRenovacion(null) }} onGuardar={guardarRenovacion} />}
      {modal === 'confirmarRenovacion' && renovacionParaConfirmar && <ModalConfirmarRenovacion renovacion={renovacionParaConfirmar} onClose={() => { setModal(null); setRenovacionParaConfirmar(null) }} onGuardar={form => confirmarRenovacion(renovacionParaConfirmar, form)} />}
    </div>
  )
}
