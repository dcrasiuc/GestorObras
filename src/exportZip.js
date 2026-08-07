// ── Exportación de comprobantes a ZIP para el contador ──────────
// Arma un .zip con las facturas (imagen_url de cada gasto) y los comprobantes de pago
// (comprobante_url de cada pago) de los gastos dentro de un rango de fechas, más un listado en
// Excel con el detalle contable de lo que se está incluyendo — pedido explícito de los usuarios
// para no tener que mandarle los comprobantes al contador uno por uno.
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { getTipoLabel, fmt } from './utils'
import { CONCEPTO_LABELS } from './constants'

// Nombre de archivo seguro dentro del zip: sin acentos ni caracteres inválidos.
function nombreSeguro(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'archivo'
}

// Las URLs de Storage no siempre indican la extensión — se infiere del Content-Type real.
function extPorContentType(ct) {
  if (!ct) return 'jpg'
  if (ct.includes('pdf')) return 'pdf'
  if (ct.includes('png')) return 'png'
  if (ct.includes('webp')) return 'webp'
  return 'jpg'
}

async function descargarYAgregar(carpeta, url, nombreBase) {
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const blob = await resp.blob()
    const ext = extPorContentType(resp.headers.get('content-type'))
    const nombre = `${nombreBase}.${ext}`
    carpeta.file(nombre, blob)
    return nombre
  } catch (e) {
    console.warn('No se pudo descargar', url, e?.message || e)
    return null
  }
}

/**
 * Arma y descarga un .zip con las facturas/comprobantes de pago de los gastos cuya fecha cae
 * dentro de [fechaDesde, fechaHasta] (ambos YYYY-MM-DD, cualquiera puede venir vacío = sin límite),
 * más un "Listado para el contador.xlsx" con el detalle de cada gasto incluido.
 * onProgress(i, total) opcional, para reflejar avance en la UI mientras se descargan los archivos.
 * Devuelve { count, incluidos, faltantes }: count = gastos en el rango, incluidos = archivos que
 * se pudieron sumar al zip, faltantes = comprobantes que no se pudieron descargar/no existían.
 */
export async function exportarZipComprobantes(gastos, fechaDesde, fechaHasta, onProgress) {
  const enRango = (gastos || []).filter(g =>
    (!fechaDesde || g.fecha >= fechaDesde) && (!fechaHasta || g.fecha <= fechaHasta)
  )
  if (enRango.length === 0) return { count: 0, incluidos: 0, faltantes: 0 }

  const zip = new JSZip()
  const carpetaFacturas = zip.folder('Facturas')
  const carpetaPagos = zip.folder('Comprobantes de pago')
  const listado = []
  let incluidos = 0
  let faltantes = 0
  let i = 0

  for (const g of enRango) {
    i++
    onProgress?.(i, enRango.length)
    const proveedor = g.proveedores?.nombre || 'Sin proveedor'
    const base = `${g.fecha}_${nombreSeguro(proveedor)}${g.nro_comprobante ? '_' + nombreSeguro(g.nro_comprobante) : ''}`

    let archivoFactura = ''
    if (g.imagen_url) {
      const nombre = await descargarYAgregar(carpetaFacturas, g.imagen_url, base)
      if (nombre) { archivoFactura = `Facturas/${nombre}`; incluidos++ } else faltantes++
    }

    const pagosConComprobante = (g.pagos || []).filter(p => p.comprobante_url)
    const archivosPago = []
    for (let idx = 0; idx < pagosConComprobante.length; idx++) {
      const sufijo = pagosConComprobante.length > 1 ? `_pago${idx + 1}` : '_pago'
      const nombre = await descargarYAgregar(carpetaPagos, pagosConComprobante[idx].comprobante_url, base + sufijo)
      if (nombre) { archivosPago.push(`Comprobantes de pago/${nombre}`); incluidos++ } else faltantes++
    }

    listado.push({
      'Fecha': g.fecha,
      'Obra': g.obras?.nombre ?? (g.es_gasto_general ? 'Gasto general' : '—'),
      'Proveedor': proveedor,
      'Concepto': CONCEPTO_LABELS[g.concepto] ?? g.concepto ?? '',
      'Tipo comprobante': getTipoLabel(g.tipo_comprobante),
      'Nº comprobante': g.nro_comprobante || '',
      'Monto': fmt(g.monto),
      'Estado': g.pagado ? 'Pagado' : 'Pendiente',
      'Archivo factura': archivoFactura || 'Sin adjuntar',
      'Archivo(s) de pago': archivosPago.join(' | ') || 'Sin adjuntar',
    })
  }

  // Listado en Excel (mismo patrón que exportExcel.js) — queda dentro del zip junto a los archivos.
  const wb = XLSX.utils.book_new()
  const datosHoja = listado.length ? listado : [{ 'Fecha': 'Sin datos' }]
  const ws = XLSX.utils.json_to_sheet(datosHoja)
  ws['!cols'] = Object.keys(datosHoja[0]).map(k => ({
    wch: Math.min(Math.max(k.length, ...datosHoja.map(r => String(r[k] ?? '').length)) + 2, 45),
  }))
  XLSX.utils.book_append_sheet(wb, ws, 'Listado')
  const excelBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  zip.file('Listado para el contador.xlsx', excelBuffer)

  const zipBlob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(zipBlob)
  const a = document.createElement('a')
  a.href = url
  a.download = `comprobantes_${fechaDesde || 'inicio'}_a_${fechaHasta || 'hoy'}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)

  return { count: enRango.length, incluidos, faltantes }
}
