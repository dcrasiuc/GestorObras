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
// y saldoMonto calculados) y su `estadoVenc`. Se exporta exactamente lo que se está viendo en
// pantalla (mismo filtro y agrupador activos).
export function exportarCuentaCorrienteSeguros(grupos = [], agrupador = 'aseguradora') {
  const columnaGrupo = agrupador === 'aseguradora' ? 'Aseguradora' : 'Corredor'

  // ── Hoja Movimientos ──
  const filasMovimientos = []
  grupos.forEach(g => {
    g.polizas.forEach(p => {
      ;(p.movimientos || []).forEach(m => {
        filasMovimientos.push({
          [columnaGrupo]: g.nombre,
          'Obra': p.obras?.nombre ?? '',
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
  const filasResumen = grupos.map(g => ({
    [columnaGrupo]: g.nombre,
    'Cant. pólizas': g.polizas.length,
    'Prima total': num(g.totalPrima),
    'Pagado': num(g.totalPagado),
    'Saldo (teórico)': num(g.saldo),
  }))

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
  XLSX.writeFile(wb, `cuenta-corriente-seguros_${fecha}.xlsx`)
}
