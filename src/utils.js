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
