import { SITUACIONES, TIPOS_COMPROBANTE } from './constants'

const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

// Edge Function que hace de proxy para escrituras — el mobile llama a Cloudflare
// y Cloudflare escribe en Supabase server-side (evita el bloqueo de POST en mobile)
// Reutilizamos analizar-comprobante (ya deployada y funcional en mobile)
// Si viene { table } en el body → modo write proxy; si viene { base64 } → modo IA
const DB_WRITE_URL = 'https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante'

// Lee el JWT de localStorage sin hacer network
function getTokenSync() {
  try {
    const parsed = JSON.parse(localStorage.getItem('seate-auth') || '{}')
    return parsed?.access_token
      || parsed?.currentSession?.access_token
      || parsed?.session?.access_token
      || SUPA_KEY
  } catch { return SUPA_KEY }
}

/**
 * Escribe en Supabase a través de la Edge Function db-write.
 * El request va mobile → Cloudflare → Supabase (evita bloqueo de POST en mobile).
 */
export async function dbWrite(method, table, payload, filter = null, returning = false) {
  const token = getTokenSync()
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('Sin respuesta del servidor. Verificá tu conexión.')), 20000)
  )
  const respRaw = await Promise.race([
    fetch(DB_WRITE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPA_KEY,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ table, method, payload, filter, returning }),
    }),
    timeout,
  ])
  const result = await respRaw.json()
  if (!respRaw.ok || result?.error) throw new Error(result?.error || `HTTP ${respRaw.status}`)
  return returning ? result.data : null
}

// ── Formateo de números ──────────────────────────────────────
// `fmt` redondea a pesos enteros — sirve para totales grandes (dashboards, tarjetas resumen)
// donde mostrar centavos es ruido visual. NO USAR donde el usuario tiene que verificar el
// importe EXACTO antes de confirmar algo (pagos) — ahí hace falta `fmtDec`, ver abajo.
export const fmt = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'decimal', maximumFractionDigits: 0 }).format(n ?? 0)

// `fmtDec` SIEMPRE muestra los centavos (2 decimales), con coma decimal y punto de miles
// (formato argentino). Usar en cualquier pantalla de conciliación de pagos — registrar un
// pago (individual o múltiple), historial de pagos, comprobantes — donde el proveedor necesita
// el importe EXACTO. `fmt` (sin decimales) en esos lugares hacía que la app "pareciera" redondear
// el monto, aunque el valor guardado en la base siempre tuvo los centavos correctos: el problema
// no era el dato, era que no se mostraba completo en la pantalla donde el usuario más lo necesita.
export const fmtDec = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'decimal', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n ?? 0)

export const fmtK = (n) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000   ? `$${Math.round(n / 1_000)}k`
  : `$${fmt(n)}`

// ── Parseo de un monto tecleado por el usuario (acepta "," o "." como decimal) ──
// Los inputs de monto son type="number" (value siempre en formato con punto, por spec del
// navegador, sin importar qué caracter haya tecleado el usuario) — pero por las dudas de que
// algún dato llegue como texto con coma decimal (pegado desde otro lado, un campo de texto, etc.)
// esta función normaliza antes de parsear, para no perder los centavos por una coma mal leída.
export const parseMonto = (v) => {
  if (v === null || v === undefined || v === '') return 0
  let s = String(v).trim()
  const tieneComa = s.includes(',')
  const tienePunto = s.includes('.')
  if (tieneComa && tienePunto) {
    // Formato argentino completo: "." de miles, "," decimal → "15.450,75" → "15450.75"
    s = s.replace(/\./g, '').replace(',', '.')
  } else if (tieneComa) {
    // Solo coma: es el separador decimal → "15450,75" → "15450.75"
    s = s.replace(',', '.')
  }
  // Solo punto (o ninguno de los dos): ya es el formato que entiende parseFloat, se deja igual
  // (cubre tanto "15450.75" como miles-con-punto-sin-decimales tipo "15450.", que no es un caso real)
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : 0
}

// ── Fecha de hoy en YYYY-MM-DD ───────────────────────────────
export const hoy = () => new Date().toISOString().slice(0, 10)

// ── Fecha para MOSTRAR en pantalla: siempre día/mes/año ──────
// Las fechas se guardan en la base como YYYY-MM-DD (ISO, lo que necesita el
// <input type="date"> y lo que evita líos de huso horario al comparar/ordenar).
// Pero mostrar ese string ISO tal cual en una lista se LEE "mes antes que
// día" (YYYY-MM-DD pone el mes en el medio, antes del día) — el dato no está
// mal, es el orden de visualización el que no es el que usamos en Argentina.
// Esta función SOLO reordena el texto (nunca usa `new Date(...)`, así no hay
// riesgo de que un huso horario corra el día) para mostrar siempre DD/MM/AAAA.
// Usar en cualquier lugar donde una fecha se muestre como texto; NO usar como
// `value` de un <input type="date"> (ese sigue necesitando el string ISO).
export const fmtFechaAR = (iso) => {
  if (!iso) return '—'
  const [y, m, d] = String(iso).slice(0, 10).split('-')
  if (!y || !m || !d) return iso
  return `${d}/${m}/${y}`
}

// ── Helpers de situación impositiva ─────────────────────────
export const getSituacion = (val) => SITUACIONES.find(s => s.value === val) ?? SITUACIONES[0]

export const getTipoLabel = (val) => TIPOS_COMPROBANTE.find(t => t.value === val)?.label ?? val

// ── CUIT helpers ─────────────────────────────────────────────

/** Normaliza un CUIT: saca guiones, espacios, puntos → solo dígitos */
export const normCuit = (s) => (s ?? '').replace(/\D/g, '')

/**
 * Valida un CUIT argentino por dígito verificador.
 * Retorna true si los 11 dígitos son correctos.
 */
export function validarCuit(cuit) {
  const n = normCuit(cuit)
  if (n.length !== 11) return false
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(n[i]), 0)
  const resto = suma % 11
  const dv = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto
  return Number(n[10]) === dv
}

/**
 * Compara dos CUITs con tolerancia inteligente:
 * 1. Normaliza (quita guiones, espacios, puntos)
 * 2. Exacto → match inmediato
 * 3. Si uno tiene 10 dígitos y el otro 11 (OCR perdió un dígito):
 *    prueba omitir cada posición del largo para ver si coincide con el corto,
 *    o insertar dígitos en el corto hasta obtener el largo con dígito verificador válido.
 * Retorna { match: bool, advertencia?: string }
 */
export function cuitMatch(a, b) {
  const na = normCuit(a)
  const nb = normCuit(b)
  if (!na || !nb) return { match: false }
  if (na === nb) return { match: true }

  // Fuzzy: diferencia de exactamente 1 dígito (posible OCR cortó un carácter)
  const [long, short] = na.length >= nb.length ? [na, nb] : [nb, na]
  if (long.length === 11 && short.length === 10) {
    // Caso A: omitir cada posición del largo → comparar con el corto
    for (let i = 0; i < long.length; i++) {
      if (long.slice(0, i) + long.slice(i + 1) === short) {
        return { match: true, advertencia: `CUIT leído puede estar incompleto (${a} → ${b}). Verificá.` }
      }
    }
    // Caso B: insertar dígito 0-9 en cada posición del corto para obtener el largo válido
    for (let i = 0; i <= short.length; i++) {
      for (let d = 0; d <= 9; d++) {
        const candidato = short.slice(0, i) + String(d) + short.slice(i)
        if (candidato === long && validarCuit(candidato)) {
          return { match: true, advertencia: `CUIT leído puede tener un dígito faltante (${a}). Verificá.` }
        }
      }
    }
  }
  return { match: false }
}
