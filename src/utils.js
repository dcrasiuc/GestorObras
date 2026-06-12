import { SITUACIONES, TIPOS_COMPROBANTE } from './constants'

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Escritura directa a Supabase via fetch (bypasea el cliente JS para evitar
 * bugs de auth en mobile). Usa el JWT del usuario logueado.
 * @param {'POST'|'PATCH'|'DELETE'} method
 * @param {string} table  nombre de la tabla
 * @param {object|null} payload  datos a enviar (null para DELETE)
 * @param {string|null} filter  ej: "id=eq.123" (se pone en query string)
 * @param {boolean} returning  si true devuelve la fila insertada/actualizada
 */
// Lee el JWT directamente de localStorage — sin network, sin posibles cuelgues de getSession()
function getTokenSync() {
  try {
    const raw = localStorage.getItem('seate-auth')
    if (!raw) return SUPA_KEY
    const parsed = JSON.parse(raw)
    // Supabase v2 guarda { access_token, ... } o { currentSession: { access_token } }
    return parsed?.access_token
      || parsed?.currentSession?.access_token
      || parsed?.session?.access_token
      || SUPA_KEY
  } catch {
    return SUPA_KEY
  }
}

export async function dbWrite(method, table, payload, filter = null, returning = false) {
  const token = getTokenSync()
  let url = `${SUPA_URL}/rest/v1/${table}`
  if (filter) url += `?${filter}`
  const resp = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${token}`,
      'Prefer': returning ? 'return=representation' : 'return=minimal',
    },
    // PATCH espera objeto plano; POST acepta array; DELETE no lleva body
    body: payload != null ? JSON.stringify(
      method === 'PATCH' ? payload : (Array.isArray(payload) ? payload : [payload])
    ) : undefined,
  })
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`
    try { const e = await resp.json(); msg = e.message || e.hint || e.details || msg } catch {}
    throw new Error(msg)
  }
  if (returning) {
    const rows = await resp.json()
    return Array.isArray(rows) ? rows[0] : rows
  }
  return null
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
