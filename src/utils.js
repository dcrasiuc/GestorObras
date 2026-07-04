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
export const fmt = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'decimal', maximumFractionDigits: 0 }).format(n ?? 0)

export const fmtK = (n) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000   ? `$${Math.round(n / 1_000)}k`
  : `$${fmt(n)}`

// ── Fecha de hoy en YYYY-MM-DD ───────────────────────────────
export const hoy = () => new Date().toISOString().slice(0, 10)

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
