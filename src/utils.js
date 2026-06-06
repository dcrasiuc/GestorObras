import { SITUACIONES, TIPOS_COMPROBANTE } from './constants'

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
