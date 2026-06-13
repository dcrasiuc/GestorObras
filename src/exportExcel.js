// ── Exportación a Excel ───────────────────────────────────────
// Genera un .xlsx con 3 hojas (Gastos, Obras, Pagos) a partir del estado actual.
// Cada vez que se llama, produce un archivo actualizado al día.
import * as XLSX from 'xlsx'
import { CONCEPTO_LABELS, MEDIOS_PAGO, TIPOS_COMPROBANTE, IVA } from './constants'

const labelConcepto = c => CONCEPTO_LABELS[c] ?? c ?? ''
const labelComprobante = t => (TIPOS_COMPROBANTE.find(x => x.value === t)?.label) ?? t ?? ''
const labelMedio = m => (MEDIOS_PAGO.find(x => x.value === m)?.label) ?? m ?? ''
const num = v => Math.round((parseFloat(v) || 0) * 100) / 100
// Crédito fiscal: SOLO Factura A a nombre de SEATE (CUIT 30715138022). Usa IVA real si está.
const creditoFiscal = g => (g.tipo_comprobante === 'factura_a' && g.a_nombre_seate)
  ? (num(g.iva_monto) > 0 ? Math.round(num(g.iva_monto)) : Math.round(num(g.monto) * IVA / (1 + IVA)))
  : 0

// Ajusta el ancho de columnas según el contenido
function autoAnchos(rows) {
  if (!rows.length) return []
  return Object.keys(rows[0]).map(k => {
    const max = Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length))
    return { wch: Math.min(Math.max(max + 2, 10), 50) }
  })
}

export function exportarExcel(obras = [], gastos = [], bancos = []) {
  const bancoNombre = id => (bancos.find(b => b.id === id)?.nombre) ?? ''

  // ── Hoja Gastos ──
  const filasGastos = [...gastos]
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
    .map(g => ({
      'Fecha': g.fecha ?? '',
      'Obra': g.obras?.nombre ?? '',
      'Proveedor': g.proveedores?.nombre ?? '',
      'Concepto': labelConcepto(g.concepto),
      'Comprobante': labelComprobante(g.tipo_comprobante),
      'Nº Comprobante': g.nro_comprobante ?? '',
      'Descripción': g.descripcion ?? '',
      'Monto': num(g.monto),
      'A nombre SEATE': g.tipo_comprobante === 'factura_a' ? (g.a_nombre_seate ? 'Sí' : 'No') : '',
      'Crédito fiscal IVA': creditoFiscal(g),
      'Estado': g.pagado ? 'Pagado' : 'Pendiente',
    }))

  // ── Hoja Obras ──
  const filasObras = [...obras]
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)))
    .map(o => {
      const gastosObra = gastos.filter(g => g.obra_id === o.id)
      const totalGastado = gastosObra.reduce((s, g) => s + num(g.monto), 0)
      const credito = gastosObra.reduce((s, g) => s + creditoFiscal(g), 0)
      const presupuesto = num(o.presupuesto)
      return {
        'Obra': o.nombre ?? '',
        'Cliente': o.cliente ?? '',
        'Estado': o.estado ?? '',
        'Presupuesto': presupuesto,
        'Total gastado': totalGastado,
        'Saldo presupuesto': presupuesto > 0 ? presupuesto - totalGastado : '',
        '% Avance': presupuesto > 0 ? Math.round(totalGastado / presupuesto * 100) : '',
        'Cant. gastos': gastosObra.length,
        'Impago': gastosObra.filter(g => !g.pagado).reduce((s, g) => s + num(g.monto), 0),
        'Crédito fiscal IVA': credito,
      }
    })

  // ── Hoja Pagos ──
  const filasPagos = []
  gastos.forEach(g => {
    ;(g.pagos ?? []).forEach(p => {
      filasPagos.push({
        'Fecha pago': p.fecha_pago ?? '',
        'Obra': g.obras?.nombre ?? '',
        'Proveedor': g.proveedores?.nombre ?? '',
        'Medio de pago': labelMedio(p.medio_pago),
        'Banco': bancoNombre(p.banco_id),
        'Monto pagado': num(p.monto),
        'Nº Comprobante gasto': g.nro_comprobante ?? '',
      })
    })
  })
  filasPagos.sort((a, b) => String(b['Fecha pago']).localeCompare(String(a['Fecha pago'])))

  // ── Armar libro ──
  const wb = XLSX.utils.book_new()
  const agregar = (nombre, filas, vacio) => {
    const datos = filas.length ? filas : [vacio]
    const ws = XLSX.utils.json_to_sheet(datos)
    ws['!cols'] = autoAnchos(datos)
    XLSX.utils.book_append_sheet(wb, ws, nombre)
  }

  agregar('Gastos', filasGastos, { 'Fecha': 'Sin datos' })
  agregar('Obras', filasObras, { 'Obra': 'Sin datos' })
  agregar('Pagos', filasPagos, { 'Fecha pago': 'Sin datos' })

  const fecha = new Date().toISOString().slice(0, 10)
  XLSX.writeFile(wb, `gestor-obras_${fecha}.xlsx`)
}
