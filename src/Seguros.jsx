import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'
import { C, MEDIOS_PAGO } from './constants'
import { fmt, hoy, dbWrite } from './utils'
import { toast } from './toast'

// ── Constantes propias de Seguros ───────────────────────────────
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

// Por tipo de cobertura, valores por defecto de vigencia / si requiere recepción de obra para la
// baja. Son reglas del negocio (no dependen del documento) — la IA puede sugerir otra cosa si el
// texto de la póliza lo indica explícitamente, y el usuario siempre puede corregir a mano.
function inferirVigenciaYFinalObra(tipo_cobertura) {
  switch (tipo_cobertura) {
    case 'mantenimiento_oferta':  return { tipo_vigencia: 'unica_vez', requiere_final_obra: false }
    case 'ejecucion_contrato':    return { tipo_vigencia: 'unica_vez', requiere_final_obra: true }
    // Anticipo Financiero se amortiza contra los certificados de obra, no espera a la recepción.
    case 'anticipo_financiero':   return { tipo_vigencia: 'unica_vez', requiere_final_obra: false }
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
const DIAS_AVISO_VENCIMIENTO = 30
function VencimientoBadge({ fecha }) {
  const dias = diasHasta(fecha)
  if (dias === null) return <Badge bg="#F3F3F3" color="#888">Sin vencimiento cargado</Badge>
  if (dias < 0) return <Badge bg="#FFF0F0" color="#C62828">🔴 Vencida hace {Math.abs(dias)}d</Badge>
  if (dias <= DIAS_AVISO_VENCIMIENTO) return <Badge bg="#FFF8ED" color="#8A5200">🟠 Vence en {dias}d ({fecha})</Badge>
  return <Badge bg={C.greenDim} color={C.green}>⏳ Vence {fecha}</Badge>
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
    if (res?.error) { await new Promise(r => setTimeout(r, 1500)); res = await intentar() }
    if (res?.error) { toast('No se pudo subir el archivo. Verificá la conexión e intentá de nuevo.'); return null }
    return supabase.storage.from('polizas-documentos').getPublicUrl(path).data.publicUrl
  } catch (e) {
    console.warn('subirDocumentoStorage:', e?.message || e)
    toast('No se pudo subir el archivo.')
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
  const cargar = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.from('obras').select('*, clientes(nombre)').order('created_at', { ascending: false })
    if (!error && data) setObras(data)
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
    const { data, error } = await supabase
      .from('polizas')
      .select('*, obras(nombre, organismo, etapa, estado_licitacion, monto_contrato), poliza_documentos(*)')
      .order('created_at', { ascending: false })
    if (!error && data) setPolizas(data)
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
    const { data, error } = await supabase.from('pagos_poliza').select('*').order('fecha_pago', { ascending: false })
    if (!error && data) setPagos(data)
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
    const { data, error } = await supabase.from('renovaciones_poliza').select('*').order('periodo_hasta', { ascending: false })
    if (!error && data) setRenovaciones(data)
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

// Pólizas que necesitan atención, con el motivo y la acción sugerida:
// - 'presentar_baja': está activa pero la obra ya avanzó de estado, o el vencimiento ya pasó/está cerca
//   → hay que presentarle la recepción de obra a la aseguradora pidiendo la baja
// - 'confirmar_baja': ya se le presentó la baja a la aseguradora → falta que ELLA la confirme
function calcularAlertas(polizas, renovaciones = []) {
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
      const renovacionesVigentes = renovacionesDeLaPoliza.filter(r => !r.anulada)
      const ultimaRenovacion = renovacionesVigentes.slice().sort((a, b) => (b.periodo_hasta || '').localeCompare(a.periodo_hasta || ''))[0]
      const corteVigente = ultimaRenovacion?.periodo_hasta || p.fecha_vencimiento
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
          } else if (dias <= DIAS_AVISO_VENCIMIENTO) {
            motivos.push(`Se autorenueva sola en ${dias} día(s) si no se presenta la recepción antes de esa fecha${p.duracion_periodo_dias ? ` — la aseguradora cobrará una prima nueva por otro período de ${p.duracion_periodo_dias} días` : ''}.`)
          }
        } else {
          if (dias < 0) motivos.push(`Vencida hace ${Math.abs(dias)} día(s).`)
          else if (dias <= DIAS_AVISO_VENCIMIENTO) motivos.push(`Vence en ${dias} día(s) — gestionar renovación.`)
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

// ── Modal: nueva obra (licitación/oferta) rápida ──────────────────
function ModalNuevaObraLicitacion({ inicial, onClose, onGuardar }) {
  const [form, setForm] = useState({ nombre: inicial?.nombre || '', organismo: inicial?.organismo || 'IPRODA', monto_contrato: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <Modal title="Nueva obra (en oferta)" onClose={onClose} onGuardar={() => onGuardar(form)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Campo label="Nombre según pliego"><input style={inputSt} value={form.nombre} onChange={e => set('nombre', e.target.value)} placeholder="Ej. Repavimentación Ruta 12" /></Campo>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Campo label="Organismo">
            <select style={inputSt} value={form.organismo} onChange={e => set('organismo', e.target.value)}>
              {ORGANISMOS.map(o => <option key={o} value={o}>{ORGANISMO_LABELS[o]}</option>)}
            </select>
          </Campo>
          <Campo label="Monto contrato ($)"><input type="number" style={inputSt} value={form.monto_contrato} onChange={e => set('monto_contrato', e.target.value)} placeholder="Opcional" /></Campo>
        </div>
      </div>
    </Modal>
  )
}

// ── Modal: cargar / editar póliza (foto/PDF + IA "experta") ──────────────────
function ModalPoliza({ obras, obraIdDefecto, polizaExistente, onClose, onGuardar, onCrearObra }) {
  const esEdicion = !!polizaExistente
  const [step, setStep] = useState(esEdicion ? 'review' : 'upload')
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
    monto_asegurado: '', prima: '', prima_fuente: '', fecha_emision: hoy(), fecha_inicio: '', fecha_vencimiento: '', notas: '',
    tipo_vigencia: null, requiere_final_obra: null, clausula_repeticion: 'no_especifica', clausulas_especiales: '', descripcion_ia: '',
    se_autorenueva: null, duracion_periodo_dias: '',
    archivo_url: '',
  })
  const [sugerenciaObra, setSugerenciaObra] = useState(null) // { nombre, organismo } si la IA detectó una obra que no matchea ninguna existente y hay que ofrecer crear
  const [candidatasObraIA, setCandidatasObraIA] = useState([]) // obras existentes parecidas — hay que preguntar antes de asumir que es nueva
  const [nombreObraIA, setNombreObraIA] = useState('') // nombre/organismo tal como lo leyó la IA, para mostrar en la pregunta
  const [iaDetectoEndoso, setIaDetectoEndoso] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

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
        const defaults = inferirVigenciaYFinalObra(tipoValido)
        const tipoVigValida = TIPOS_VIGENCIA.some(t => t.value === parsed.tipo_vigencia) ? parsed.tipo_vigencia : defaults.tipo_vigencia
        const requiereFinalObra = typeof parsed.requiere_final_obra === 'boolean' ? parsed.requiere_final_obra : defaults.requiere_final_obra
        const clausulaValida = CLAUSULAS_REPETICION.some(t => t.value === parsed.clausula_repeticion) ? parsed.clausula_repeticion : 'no_especifica'
        // Matchear obra: primero un match fuerte (substring exacto) que se auto-selecciona. Si no
        // hay match fuerte, buscamos candidatas posibles (palabra en común / mismo organismo) para
        // preguntarle al usuario en vez de asumir directamente que es una obra nueva.
        const nombreIAOriginal = parsed.obra || ''
        const orgIA = (parsed.organismo || '').toUpperCase()
        const matchObra = matchFuerteObra(obras, nombreIAOriginal)
        const candidatas = matchObra ? [] : candidatasObra(obras, nombreIAOriginal, orgIA)
        setCandidatasObraIA(candidatas)
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
      return onGuardar({ ...form, monto_asegurado: parseFloat(form.monto_asegurado) || null, prima: parseFloat(form.prima) || null })
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Campo label="Monto asegurado ($)"><input type="number" style={inputSt} value={form.monto_asegurado} onChange={e => set('monto_asegurado', e.target.value)} /></Campo>
            <Campo label="Prima / costo de la póliza ($)">
              <input type="number" style={inputSt} value={form.prima} onChange={e => set('prima', e.target.value)} placeholder="Lo que cobra la aseguradora" />
              {form.prima && (
                /PRIMA|PREMIO/i.test(form.prima_fuente || '')
                  ? <div style={{ fontSize: 10, color: C.textFaint, marginTop: 3 }}>Fuente: "{form.prima_fuente}" en el documento.</div>
                  : <div style={{ fontSize: 10, color: '#8A5200', marginTop: 3 }}>⚠️ {form.prima_fuente ? `Extraído de "${form.prima_fuente}" — no es una etiqueta explícita de prima/premio, verificá contra la factura o cuponera de la aseguradora.` : 'Verificá este monto — no encontré una etiqueta explícita de "Prima"/"Premio" en el documento.'}</div>
              )}
            </Campo>
          </div>
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
function ModalPagoPoliza({ polizas, polizaIdDefecto, bancos, renovaciones = [], onClose, onGuardar }) {
  const [form, setForm] = useState({ poliza_id: polizaIdDefecto || polizas[0]?.id || '', fecha_pago: hoy(), monto: '', medio_pago: 'transferencia', banco_id: '', nro_operacion: '', observaciones: '' })
  const [file, setFile] = useState(null)
  const [subiendo, setSubiendo] = useState(false)
  const [analizando, setAnalizando] = useState(false)
  const [analizado, setAnalizado] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const necesitaBanco = ['transferencia', 'cheque', 'tarjeta', 'tarjeta_credito', 'tarjeta_debito'].includes(form.medio_pago)

  // El "comprobante de pago" acá puede ser una transferencia, pero también una CUPONERA de la
  // aseguradora (a veces se paga directo con el cupón, sin que exista una factura aparte). Al
  // elegir el archivo lo leemos con la misma IA de comprobantes de gasto para autocompletar
  // fecha/monto — y lo comparamos contra la prima esperada de la póliza para que el usuario note
  // cualquier diferencia antes de guardar (reajustes, cargos parciales, etc.).
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
        if (parsed.monto) set('monto', parsed.monto)
        if (parsed.fecha) set('fecha_pago', parsed.fecha)
        setAnalizado(true)
      }
    } catch (e) {
      console.warn('ModalPagoPoliza: no se pudo analizar con IA', e)
    } finally {
      setAnalizando(false)
    }
  }

  const polizaSel = polizas.find(p => p.id === form.poliza_id)
  const primaEsperada = polizaSel ? primaConRenovaciones(polizaSel, renovaciones) : 0
  const montoNum = parseFloat(form.monto) || 0
  const difiereDeLaPrima = analizado && primaEsperada > 0 && montoNum > 0 && Math.abs(montoNum - primaEsperada) / primaEsperada > 0.02

  return (
    <Modal title="Registrar pago de póliza" onClose={onClose} guardarLabel={subiendo ? 'Subiendo...' : 'Guardar pago'} onGuardar={async () => {
      if (!form.poliza_id) throw new Error('Elegí a qué póliza corresponde el pago')
      if (!montoNum) throw new Error('Ingresá un monto válido')
      let comprobante_url = null
      if (file) { setSubiendo(true); comprobante_url = await subirDocumentoStorage(file, 'pagos_poliza'); setSubiendo(false); if (!comprobante_url) throw new Error('No se pudo subir el comprobante') }
      await onGuardar({ ...form, monto: montoNum, banco_id: form.banco_id || null, comprobante_url })
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {polizas.length > 1 && (
          <Campo label="Póliza">
            <select style={inputSt} value={form.poliza_id} onChange={e => set('poliza_id', e.target.value)}>
              {polizas.map(p => <option key={p.id} value={p.id}>{p.nro_poliza || 's/n'} — {p.obras?.nombre}</option>)}
            </select>
          </Campo>
        )}
        <Campo label="Comprobante de pago o cuponera (opcional, se lee con IA)">
          <input type="file" accept="image/*,application/pdf" onChange={e => onFile(e.target.files[0] || null)} />
          {analizando && <div style={{ fontSize: 11, color: C.purple, marginTop: 4 }}>🔎 Leyendo con IA...</div>}
          {analizado && !analizando && <div style={{ fontSize: 11, color: C.green, marginTop: 4 }}>✓ Fecha y monto autocompletados por IA — revisalos antes de guardar.</div>}
          {difiereDeLaPrima && <div style={{ fontSize: 11, color: '#8A5200', marginTop: 4 }}>⚠️ El monto leído ({fmt(montoNum)}) difiere de la prima esperada de esta póliza ({fmt(primaEsperada)}) — puede ser normal (pago parcial, reajuste) pero conviene verificarlo.</div>}
        </Campo>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Campo label="Fecha de pago"><input type="date" style={inputSt} value={form.fecha_pago} onChange={e => set('fecha_pago', e.target.value)} /></Campo>
          <Campo label="Monto ($)"><input type="number" style={inputSt} value={form.monto} onChange={e => set('monto', e.target.value)} /></Campo>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: necesitaBanco ? '1fr 1fr' : '1fr', gap: 10 }}>
          <Campo label="Medio de pago">
            <select style={inputSt} value={form.medio_pago} onChange={e => set('medio_pago', e.target.value)}>
              {MEDIOS_PAGO.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Campo>
          {necesitaBanco && (
            <Campo label="Banco">
              <select style={inputSt} value={form.banco_id} onChange={e => set('banco_id', e.target.value)}>
                <option value="">-- Elegir --</option>
                {bancos.map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}
              </select>
            </Campo>
          )}
        </div>
        <Campo label="Nro. de operación (opcional)"><input style={inputSt} value={form.nro_operacion} onChange={e => set('nro_operacion', e.target.value)} /></Campo>
        <Campo label="Observaciones"><textarea style={{ ...inputSt, minHeight: 50 }} value={form.observaciones} onChange={e => set('observaciones', e.target.value)} /></Campo>
        <div style={{ fontSize: 11, color: C.textFaint }}>Este pago se registra también como gasto (concepto "Seguros / Pólizas") en la obra correspondiente. Si había una factura pendiente cargada para esta póliza, se liquida esa en vez de crear un gasto nuevo.</div>
      </div>
    </Modal>
  )
}

// ── Modal: registrar el cargo de una renovación automática por período ──
// Ojo: el monto de la renovación NO se copia automáticamente de la prima original — puede diferir
// por reajuste (ej. "reajustable trimestralmente") — por eso se pide como dato aparte.
function ModalRenovacionPoliza({ poliza, onClose, onGuardar }) {
  const corteAnterior = poliza.fecha_vencimiento
  const [form, setForm] = useState({
    periodo_desde: corteAnterior || hoy(),
    periodo_hasta: sumarDias(corteAnterior, poliza.duracion_periodo_dias) || '',
    monto: poliza.prima ?? '',
    observaciones: '',
  })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <Modal title={`Registrar renovación — Póliza ${poliza.nro_poliza || ''}`} onClose={onClose} guardarLabel="Guardar renovación" onGuardar={async () => {
      if (!form.periodo_hasta) throw new Error('Ingresá hasta cuándo va este nuevo período')
      const montoNum = parseFloat(form.monto) || 0
      if (!montoNum) throw new Error('Ingresá el monto de la prima cobrada por este período')
      await onGuardar({ ...form, monto: montoNum })
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: C.textMuted }}>La aseguradora renovó sola esta póliza por otro período (no se presentó la recepción a tiempo) y cobró una prima nueva. Registrá acá ese cargo — el monto puede ser distinto al original por reajuste.</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Campo label="Período desde"><input type="date" style={inputSt} value={form.periodo_desde} onChange={e => set('periodo_desde', e.target.value)} /></Campo>
          <Campo label="Período hasta (nuevo corte)"><input type="date" style={inputSt} value={form.periodo_hasta} onChange={e => set('periodo_hasta', e.target.value)} /></Campo>
        </div>
        <Campo label="Monto de la prima de este período ($)"><input type="number" style={inputSt} value={form.monto} onChange={e => set('monto', e.target.value)} /></Campo>
        <Campo label="Observaciones (opcional)"><textarea style={{ ...inputSt, minHeight: 50 }} value={form.observaciones} onChange={e => set('observaciones', e.target.value)} placeholder="Ej. reajuste del 8% por inflación" /></Campo>
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
function FilaPoliza({ poliza, alertaInfo, advertencias, pagos, renovaciones = [], onMarcarBajaPresentada, onConfirmarBaja, onAgregarDocumento, onAgregarFactura, onRegistrarPago, onRegistrarRenovacion, onAnularRenovacion, onEditar, onEliminar }) {
  const [expandido, setExpandido] = useState(false)
  const totalPagado = pagos.reduce((s, p) => s + (parseFloat(p.monto) || 0), 0)
  const renovacionesVigentes = renovaciones.filter(r => !r.anulada)
  const totalRenovaciones = renovacionesVigentes.reduce((s, r) => s + (parseFloat(r.monto) || 0), 0)
  const prima = (parseFloat(poliza.prima) || 0) + totalRenovaciones
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
        <VencimientoBadge fecha={poliza.fecha_vencimiento} />
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
            {poliza.monto_asegurado ? <span>💰 Asegurado: {fmt(poliza.monto_asegurado)}</span> : null}
            {prima > 0 && <span>🧾 Prima{totalRenovaciones > 0 ? ' total (con renovaciones)' : ''}: {fmt(prima)} · Pagado: {fmt(totalPagado)} · Saldo: {fmt(saldo)}</span>}
            {poliza.fecha_inicio && <span>📅 Vigencia desde: {poliza.fecha_inicio}</span>}
          </div>
          {poliza.clausulas_especiales && <div style={{ fontSize: 11, color: C.textMuted, background: '#F3F3F3', padding: '6px 9px', borderRadius: 8 }}>📋 Cláusulas especiales: {poliza.clausulas_especiales}</div>}
          {poliza.se_autorenueva && renovaciones.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted }}>🔁 Renovaciones por período registradas</div>
              {renovaciones.map(r => (
                <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 11, background: r.anulada ? '#F3F3F3' : '#FFF8ED', padding: '5px 8px', borderRadius: 6, textDecoration: r.anulada ? 'line-through' : 'none', color: r.anulada ? '#888' : '#8A5200' }}>
                  <span>Hasta {r.periodo_hasta} · {fmt(r.monto)}{r.anulada ? ' · anulada (retroactiva)' : ''}</span>
                  {!r.anulada && <button onClick={() => onAnularRenovacion(r)} style={{ background: 'none', border: 'none', color: C.purple, fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: "'Outfit', sans-serif" }}>Anular (retroactivo)</button>}
                </div>
              ))}
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
function FilaObra({ obra, polizasDeLaObra, pagosPoliza, renovacionesPoliza, alertas, onCambiarEtapa, onPedirRecepcion, onNuevaPoliza, onMarcarBajaPresentada, onConfirmarBaja, onAgregarDocumento, onAgregarFactura, onRegistrarPago, onRegistrarRenovacion, onAnularRenovacion, onEditarPoliza, onEliminarPoliza }) {
  const [expandido, setExpandido] = useState(false)
  const polizasPendientes = polizasDeLaObra.filter(p => p.estado_admin !== 'dada_de_baja')
  const finalizadaConPendientes = obra.estado === 'finalizada' && polizasPendientes.length > 0
  return (
    <div style={{ ...cardSt, padding: 14, display: 'flex', flexDirection: 'column', gap: 8, ...(finalizadaConPendientes ? { border: '1px solid #FFB0B0' } : {}) }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ cursor: 'pointer' }} onClick={() => setExpandido(v => !v)}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{expandido ? '▾' : '▸'} {obra.nombre}</div>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{nombreOrganismoObra(obra) || 'Sin cliente vinculado'}{obra.monto_contrato ? ` · $${fmt(obra.monto_contrato)}` : ''} · {polizasDeLaObra.length} póliza(s)</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {obra.estado === 'finalizada' && <Badge bg="#F3F3F3" color="#555">🏁 Finalizada (panel Obras)</Badge>}
          {obra.estado === 'pausada' && <Badge bg="#FFF8ED" color="#8A5200">⏸️ Pausada</Badge>}
          {obra.requiere_poliza === false && <Badge bg="#F3F3F3" color="#888">Sin póliza requerida</Badge>}
          <EtapaBadge etapa={obra.etapa} />
          <EstadoLicitacionBadge estado={obra.estado_licitacion} />
        </div>
      </div>
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
                  onMarcarBajaPresentada={onMarcarBajaPresentada} onConfirmarBaja={onConfirmarBaja}
                  onAgregarDocumento={onAgregarDocumento} onAgregarFactura={onAgregarFactura} onRegistrarPago={onRegistrarPago}
                  onRegistrarRenovacion={onRegistrarRenovacion} onAnularRenovacion={onAnularRenovacion}
                  onEditar={onEditarPoliza} onEliminar={onEliminarPoliza} />
              ))}
            </div>
          )
      )}
    </div>
  )
}

// ── Cuenta corriente con las aseguradoras (o corredores) — agrupa pólizas ──
// Prima "vigente" de una póliza para efectos de cuenta corriente: la original + toda renovación
// por período que NO haya sido anulada retroactivamente (puede diferir de la prima original por
// reajuste — cada renovación trae su propio monto).
function primaConRenovaciones(poliza, renovaciones) {
  const propias = renovaciones.filter(r => r.poliza_id === poliza.id && !r.anulada)
  return (parseFloat(poliza.prima) || 0) + propias.reduce((s, r) => s + (parseFloat(r.monto) || 0), 0)
}

function agruparPolizas(polizas, pagos, renovaciones, campo) {
  const grupos = {}
  polizas.forEach(p => {
    const raw = (p[campo] || '').trim()
    const key = raw || (campo === 'corredor' ? 'Sin corredor' : 'Sin especificar')
    if (!grupos[key]) grupos[key] = { nombre: key, polizas: [], totalPrima: 0, totalPagado: 0 }
    grupos[key].polizas.push(p)
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
              <span style={{ color: g.saldo > 0 ? '#C62828' : C.green, fontWeight: 600 }}>{fmt(g.saldo)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CuentaCorrienteAseguradoras({ polizas, pagos, renovaciones, onRegistrarPago }) {
  const [agrupador, setAgrupador] = useState('aseguradora') // 'aseguradora' | 'corredor'
  const gruposAseguradora = agruparPolizas(polizas, pagos, renovaciones, 'aseguradora')
  const gruposCorredor = agruparPolizas(polizas, pagos, renovaciones, 'corredor')
  const grupos = agrupador === 'aseguradora' ? gruposAseguradora : gruposCorredor
  const icono = agrupador === 'aseguradora' ? '🏢' : '🧑‍💼'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <ResumenSubtotales titulo="Subtotales por aseguradora" icono="🏢" grupos={gruposAseguradora} />
        <ResumenSubtotales titulo="Subtotales por corredor" icono="🧑‍💼" grupos={gruposCorredor} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {[{ id: 'aseguradora', label: '🏢 Por aseguradora' }, { id: 'corredor', label: '🧑‍💼 Por corredor' }].map(t => (
          <button key={t.id} onClick={() => setAgrupador(t.id)} style={{ padding: '5px 12px', fontSize: 11, cursor: 'pointer', border: `1px solid ${C.border}`, borderRadius: 8, fontFamily: "'Outfit', sans-serif", fontWeight: agrupador === t.id ? 600 : 400, background: agrupador === t.id ? C.purpleDim : C.surface, color: agrupador === t.id ? C.purple : C.textMuted }}>{t.label}</button>
        ))}
      </div>
      {grupos.length === 0 ? <EmptyState texto="Todavía no hay pólizas cargadas." /> : grupos.map(g => (
        <div key={g.nombre} style={{ ...cardSt, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{icono} {g.nombre}</div>
            <BtnSecondary onClick={() => onRegistrarPago(g.polizas)}>+ Registrar pago</BtnSecondary>
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
            <span>Prima total: <strong style={{ color: C.text }}>{fmt(g.totalPrima)}</strong></span>
            <span>Pagado: <strong style={{ color: C.green }}>{fmt(g.totalPagado)}</strong></span>
            <span>Saldo (teórico): <strong style={{ color: g.saldo > 0 ? '#C62828' : C.green }}>{fmt(g.saldo)}</strong></span>
            <span>{g.polizas.length} póliza(s)</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {g.polizas.map(p => {
              const pagosP = pagos.filter(pg => pg.poliza_id === p.id)
              const pagadoP = pagosP.reduce((s, pg) => s + (parseFloat(pg.monto) || 0), 0)
              const primaP = primaConRenovaciones(p, renovaciones)
              return (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, fontSize: 12, padding: '6px 8px', background: '#FBFBFD', borderRadius: 8 }}>
                  <span>{p.nro_poliza || 's/n'} · {p.obras?.nombre}{agrupador === 'corredor' && p.aseguradora ? ` · ${p.aseguradora}` : ''}</span>
                  <span style={{ color: C.textMuted }}>Prima {fmt(primaP)} · Pagado {fmt(pagadoP)} · Saldo {fmt(primaP - pagadoP)}</span>
                </div>
              )
            })}
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

  const [vista, setVista] = useState('obras') // 'obras' | 'cuentaCorriente'
  const [filtroEtapa, setFiltroEtapa] = useState('todas') // 'todas' | 'oferta' | 'ejecucion'
  const [mostrarFinalizadas, setMostrarFinalizadas] = useState(false)
  const [soloFinalizadasPendientes, setSoloFinalizadasPendientes] = useState(false)
  const [modal, setModal] = useState(null) // 'nuevaObra' | 'poliza' | 'documento' | 'recepcion' | 'confirmarBaja' | 'pago' | 'renovacion'
  const [obraIdParaPoliza, setObraIdParaPoliza] = useState('')
  const [polizaParaEditar, setPolizaParaEditar] = useState(null)
  const [polizaParaDocumento, setPolizaParaDocumento] = useState(null)
  const [obraParaRecepcion, setObraParaRecepcion] = useState(null)
  const [tipoRecepcion, setTipoRecepcion] = useState(null)
  const [polizaParaBaja, setPolizaParaBaja] = useState(null)
  const [polizasParaPago, setPolizasParaPago] = useState(null)
  const [polizaParaRenovacion, setPolizaParaRenovacion] = useState(null)
  const [polizaParaFactura, setPolizaParaFactura] = useState(null)

  const alertas = calcularAlertas(polizas, renovacionesPoliza)
  const loading = loadingObras || loadingPolizas || loadingPagos || loadingRenovaciones

  // "Vigente" = todavía no llegó a Recepción Definitiva (o está en oferta). Por defecto se ocultan
  // las obras ya finalizadas para que esta sea la lista de obras vigentes.
  const obrasVigentes = obras.filter(o => o.estado_licitacion !== 'recepcion_definitiva')
  // El filtro "Finalizadas c/ pólizas pendientes" busca en TODAS las obras (ignora vigentes/mostrarFinalizadas)
  // porque el punto es justamente encontrar las que el resto de la app ya da por terminadas.
  const esFinalizadaConPendientes = (o) => o.estado === 'finalizada' && polizas.some(p => p.obra_id === o.id && p.estado_admin !== 'dada_de_baja')
  const baseObras = soloFinalizadasPendientes ? obras : (mostrarFinalizadas ? obras : obrasVigentes)
  const obrasFiltradas = (filtroEtapa === 'todas' ? baseObras : baseObras.filter(o => o.etapa === filtroEtapa))
    .filter(o => !soloFinalizadasPendientes || esFinalizadaConPendientes(o))

  const crearObra = async ({ nombre, organismo, monto_contrato }) => {
    if (!nombre?.trim()) { toast('El nombre es obligatorio'); return null }
    const payload = { nombre: nombre.trim(), organismo: organismo || null, monto_contrato: parseFloat(monto_contrato) || null, etapa: 'oferta', estado_licitacion: 'en_curso' }
    const nueva = await dbWrite('POST', 'obras', payload, null, true)
    if (nueva?.id) { setObras(prev => [nueva, ...prev]); toast('Obra creada', 'ok') }
    return nueva
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
      fecha_emision, fecha_inicio, fecha_vencimiento, notas, tipo_vigencia, requiere_final_obra,
      clausula_repeticion, clausulas_especiales, descripcion_ia, se_autorenueva, duracion_periodo_dias } = form
    const campos = {
      obra_id, tipo_cobertura, aseguradora: aseguradora || null, corredor: corredor || null, nro_poliza: nro_poliza || null,
      monto_asegurado, prima, prima_fuente: prima ? (prima_fuente || null) : null, fecha_emision: fecha_emision || null, fecha_inicio: fecha_inicio || null, fecha_vencimiento: fecha_vencimiento || null,
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
    const nuevoGasto = await dbWrite('POST', 'gastos', {
      obra_id: polizaParaFactura.obra_id,
      fecha,
      concepto: 'seguros',
      descripcion: `Factura prima póliza ${polizaParaFactura.nro_poliza || 's/n'} — ${polizaParaFactura.aseguradora || 'aseguradora s/e'}${nro_factura ? ` (Fact. ${nro_factura})` : ''}`,
      monto,
      tipo_comprobante: tipo_comprobante || 'otro',
      discrimina_iva: false,
      pagado: false,
    }, null, true)
    const doc = await dbWrite('POST', 'poliza_documentos', {
      poliza_id: polizaParaFactura.id, tipo: 'factura', archivo_url, nombre_archivo, gasto_id: nuevoGasto?.id || null,
    }, null, true)
    setPolizas(prev => prev.map(p => p.id === polizaParaFactura.id ? { ...p, poliza_documentos: [...(p.poliza_documentos || []), doc] } : p))
    setModal(null); setPolizaParaFactura(null)
    toast('Factura cargada — se generó un gasto pendiente de pago en la obra', 'ok')
  }

  // Registrar un pago de prima: impacta la cuenta corriente con la aseguradora Y se refleja como
  // gasto (+ pago) en la obra correspondiente. Si esta póliza tiene una factura pendiente (gasto
  // pagado=false, generado por guardarFactura), liquidamos ESE gasto en vez de crear uno nuevo —
  // así no se duplica el gasto de la obra cuando primero se cargó la factura y después se pagó.
  const guardarPagoPoliza = async (form) => {
    const poliza = polizas.find(p => p.id === form.poliza_id)
    if (!poliza) throw new Error('No encontré la póliza')
    const { fecha_pago, monto, medio_pago, banco_id, nro_operacion, observaciones, comprobante_url } = form

    // Buscamos el gasto pendiente vinculado a alguna factura de esta póliza consultando directo,
    // porque `poliza.poliza_documentos` no trae el estado `pagado` del gasto (solo el gasto_id).
    let gastoAUsar = null
    const docsFactura = (poliza.poliza_documentos || []).filter(d => d.tipo === 'factura' && d.gasto_id)
    if (docsFactura.length > 0) {
      const { data: gastosPendientes } = await supabase.from('gastos').select('id, pagado').in('id', docsFactura.map(d => d.gasto_id)).eq('pagado', false)
      if (gastosPendientes && gastosPendientes.length > 0) gastoAUsar = gastosPendientes[0]
    }

    let gastoId
    if (gastoAUsar) {
      await dbWrite('PATCH', 'gastos', { pagado: true, monto, fecha: fecha_pago, tipo_comprobante: comprobante_url ? 'recibo' : undefined }, `id=eq.${gastoAUsar.id}`)
      gastoId = gastoAUsar.id
    } else {
      const nuevoGasto = await dbWrite('POST', 'gastos', {
        obra_id: poliza.obra_id,
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
    if (nuevoPago) setPagosPoliza(prev => [nuevoPago, ...prev])
    setModal(null); setPolizasParaPago(null)
    toast(gastoAUsar ? 'Pago registrado — se liquidó la factura pendiente de esta póliza' : 'Pago registrado y reflejado como gasto de la obra', 'ok')
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
      observaciones: form.observaciones || null,
    }, null, true)
    if (nueva) setRenovacionesPoliza(prev => [nueva, ...prev])
    setModal(null); setPolizaParaRenovacion(null)
    toast('Renovación registrada — se sumó a la deuda con la aseguradora', 'ok')
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

      {alertas.length > 0 && (
        <div style={{ background: '#FFF0F0', border: '1px solid #FFDCDC', borderRadius: 12, padding: 14, marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#C62828', marginBottom: 6 }}>⚠️ {alertas.length} póliza(s) necesitan atención</div>
          <div style={{ fontSize: 12, color: '#8A3030' }}>Porque la obra ya cambió de estado o el vencimiento ya pasó o está cerca. El detalle y la acción a tomar están en cada póliza más abajo.</div>
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
                  pagosPoliza={pagosPoliza} renovacionesPoliza={renovacionesPoliza} alertas={alertas}
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
                  onEditarPoliza={pz => { setPolizaParaEditar(pz); setModal('poliza') }}
                  onEliminarPoliza={eliminarPoliza} />
              ))}
            </div>
          )}
        </>
      )}

      {vista === 'cuentaCorriente' && (
        <CuentaCorrienteAseguradoras polizas={polizas} pagos={pagosPoliza} renovaciones={renovacionesPoliza}
          onRegistrarPago={polizasGrupo => { setPolizasParaPago(polizasGrupo); setModal('pago') }} />
      )}

      {modal === 'nuevaObra' && <ModalNuevaObraLicitacion onClose={() => setModal(null)} onGuardar={async d => { const n = await crearObra(d); if (n) setModal(null) }} />}
      {modal === 'poliza' && <ModalPoliza obras={obras} obraIdDefecto={obraIdParaPoliza} polizaExistente={polizaParaEditar} onClose={() => { setModal(null); setPolizaParaEditar(null) }} onGuardar={guardarPoliza} onCrearObra={crearObra} />}
      {modal === 'documento' && polizaParaDocumento && <ModalDocumentoPoliza poliza={polizaParaDocumento} onClose={() => { setModal(null); setPolizaParaDocumento(null) }} onGuardar={guardarDocumento} />}
      {modal === 'factura' && polizaParaFactura && <ModalFacturaPoliza poliza={polizaParaFactura} onClose={() => { setModal(null); setPolizaParaFactura(null) }} onGuardar={guardarFactura} />}
      {modal === 'recepcion' && obraParaRecepcion && <ModalRecepcionObra obra={obraParaRecepcion} tipoRecepcion={tipoRecepcion} onClose={() => { setModal(null); setObraParaRecepcion(null); setTipoRecepcion(null) }} onGuardar={guardarRecepcion} />}
      {modal === 'confirmarBaja' && polizaParaBaja && <ModalConfirmarBaja poliza={polizaParaBaja} onClose={() => { setModal(null); setPolizaParaBaja(null) }} onGuardar={guardarConfirmacionBaja} />}
      {modal === 'pago' && polizasParaPago && <ModalPagoPoliza polizas={polizasParaPago} polizaIdDefecto={polizasParaPago[0]?.id} bancos={bancos} renovaciones={renovacionesPoliza} onClose={() => { setModal(null); setPolizasParaPago(null) }} onGuardar={guardarPagoPoliza} />}
      {modal === 'renovacion' && polizaParaRenovacion && <ModalRenovacionPoliza poliza={polizaParaRenovacion} onClose={() => { setModal(null); setPolizaParaRenovacion(null) }} onGuardar={guardarRenovacion} />}
    </div>
  )
}
