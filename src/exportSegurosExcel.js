// ── Exportación a Excel de la cuenta corriente de Seguros ───────────────────
// Genera un .xlsx con el mismo desglose que se ve en pantalla en "💳 Cuenta corriente":
// una hoja con cada movimiento (prima original + cada renovación) de cada póliza, con su estado
// de pago individual (pagado / parcial / pendiente / anulada), y una hoja de resumen por grupo
// (aseguradora o corredor, según se esté viendo al exportar).
import * as XLSX from 'xlsx'

// Copia local de las etiquetas (NO importar TIPOS_COBERTURA desde './Seguros' acá): Seguros.jsx ya
// importa este archivo, así que importar de vuelta desde acá crea un ciclo de módulos ES — al
// evaluarse Seguros.jsx llega a este import ANTES de que su propio `export const TIPOS_COBERTURA`
// se haya inicializado, y JS tira "Cannot access 'TIPOS_COBERTURA' before initialization" al cargar
// el bundle entero, dejando toda la app en blanco (bug real detectado y corregido — setiembre 2026).
const COBERTURA_LABELS = {
  mantenimiento_oferta: 'Mantenimiento de Oferta',
  ejecucion_contrato: 'Cumplimiento de Contrato',
  anticipo_financiero: 'Anticipo Financiero',
  fondo_reparo: 'Fondo de Reparo',
  responsabilidad_civil: 'Responsabilidad Civil',
  otro: 'Otro',
}
const num = v => Math.round((parseFloat(v) || 0) * 100) / 100

const ESTADO_PAGO_LABELS = {
  pagado: 'Pagado',
  parcial: 'Parcial',
  pendiente: 'Pendiente de pago',
  anulada: 'Anulada (retroactivo)',
}

// Ajusta el ancho de columnas según el contenido
function autoAnchos(rows) {
  if (!rows.length) return []
  return Object.keys(rows[0]).map(k => {
    const max = Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length))
    return { wch: Math.min(Math.max(max + 2, 10), 50) }
  })
}

// `grupos` es el array ya agrupado (por aseguradora o por corredor, según `agrupador`) tal como lo
// devuelve agruparPolizas() en Seguros.jsx — cada póliza ya trae sus `movimientos` (con estadoPago
// y saldoMonto calculados) y su `estadoVenc`. Por defecto (sin `opciones`) se exporta exactamente lo
// que se está viendo en pantalla (mismo filtro y agrupador activos) — pero desde setiembre 2026 el
// botón "Exportar a Excel" abre un modal que arma `grupos` a partir de TODAS las pólizas (o solo las
// que tienen saldo pendiente) cuando el usuario lo pide, y puede pasar acá un rango de fechas.
// `opciones.fechaDesde`/`opciones.fechaHasta` (strings 'YYYY-MM-DD' u null) filtran los MOVIMIENTOS
// por su fecha — sirve para un reporte de "qué se generó/cobró entre tal y tal fecha".
export function exportarCuentaCorrienteSeguros(grupos = [], agrupador = 'aseguradora', opciones = {}) {
  const { fechaDesde = null, fechaHasta = null } = opciones
  const hayRangoFechas = !!(fechaDesde || fechaHasta)
  // Un movimiento sin fecha cargada (pasa con vigencia/prima sin fecha_emision) solo se incluye si
  // no se pidió ningún rango — no hay forma de saber si "cae" dentro de un rango sin fecha.
  const enRango = (fecha) => {
    if (!fecha) return !hayRangoFechas
    if (fechaDesde && fecha < fechaDesde) return false
    if (fechaHasta && fecha > fechaHasta) return false
    return true
  }
  const columnaGrupo = agrupador === 'aseguradora' ? 'Aseguradora' : 'Corredor'

  // ── Hoja Movimientos ──
  const filasMovimientos = []
  grupos.forEach(g => {
    g.polizas.forEach(p => {
      ;(p.movimientos || []).filter(m => enRango(m.fecha)).forEach(m => {
        filasMovimientos.push({
          [columnaGrupo]: g.nombre,
          'Obra': p.obras?.nombre ?? '',
          'Comitente': p.obras?.organismo ?? '',
          'Póliza': p.nro_poliza || 's/n',
          'Tipo de cobertura': COBERTURA_LABELS[p.tipo_cobertura] || p.tipo_cobertura || '',
          'Movimiento': m.label,
          'Fecha': m.fecha ?? '',
          'Moneda': m.moneda || 'ARS',
          'Monto original': num(m.montoOriginal ?? m.monto),
          'Tipo de cambio': m.moneda === 'USD' ? (num(m.tipoCambio) || '') : '',
          'Monto ($)': num(m.monto),
          'Estado': ESTADO_PAGO_LABELS[m.estadoPago] || m.estadoPago || '',
          'Pagado ($)': num(m.pagadoMonto),
          'Saldo pendiente ($)': num(m.saldoMonto),
          'Motivo anulación': m.anulada ? (m.motivo_anulacion || '') : '',
        })
      })
    })
  })
  filasMovimientos.sort((a, b) => String(a['Fecha']).localeCompare(String(b['Fecha'])))

  // ── Hoja Resumen por grupo ──
  // Sin rango de fechas: el saldo "de vida completa" de la póliza (g.totalPrima/totalPagado/saldo,
  // como siempre). Con rango: hay que recalcular sumando SOLO los movimientos que quedaron dentro del
  // rango (filasMovimientos ya viene filtrada) — si no, el resumen no coincidiría con el detalle.
  const filasResumen = grupos.map(g => {
    if (!hayRangoFechas) {
      return {
        [columnaGrupo]: g.nombre,
        'Cant. pólizas': g.polizas.length,
        'Prima total': num(g.totalPrima),
        'Pagado': num(g.totalPagado),
        'Saldo (teórico)': num(g.saldo),
      }
    }
    const movsGrupo = filasMovimientos.filter(f => f[columnaGrupo] === g.nombre)
    const primaPeriodo = movsGrupo.reduce((s, f) => s + f['Monto ($)'], 0)
    const pagadoPeriodo = movsGrupo.reduce((s, f) => s + f['Pagado ($)'], 0)
    return {
      [columnaGrupo]: g.nombre,
      'Cant. pólizas': g.polizas.length,
      'Prima del período': num(primaPeriodo),
      'Pagado del período': num(pagadoPeriodo),
      'Saldo del período': num(primaPeriodo - pagadoPeriodo),
    }
  })

  const wb = XLSX.utils.book_new()
  const agregar = (nombre, filas, vacio) => {
    const datos = filas.length ? filas : [vacio]
    const ws = XLSX.utils.json_to_sheet(datos)
    ws['!cols'] = autoAnchos(datos)
    XLSX.utils.book_append_sheet(wb, ws, nombre)
  }
  agregar('Movimientos', filasMovimientos, { [columnaGrupo]: 'Sin datos' })
  agregar('Resumen', filasResumen, { [columnaGrupo]: 'Sin datos' })

  const fecha = new Date().toISOString().slice(0, 10)
  const sufijoRango = hayRangoFechas ? `_${fechaDesde || 'inicio'}_a_${fechaHasta || fecha}` : ''
  XLSX.writeFile(wb, `cuenta-corriente-seguros${sufijoRango}_${fecha}.xlsx`)
}
