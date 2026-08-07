// ── Exportación de comprobantes a ZIP para el contador ──────────
// Arma un .zip con las facturas (imagen_url de cada gasto) de los gastos dentro de un rango de
// fechas, más un listado en Excel con el detalle contable de lo que se está incluyendo — pedido
// explícito de los usuarios para no tener que mandarle los comprobantes al contador uno por uno.
// Nota: a pedido de los usuarios, este export NO incluye comprobantes de pago (ni la carpeta ni
// la columna de archivo de pago) ni la obra/estado de pago — solo las facturas y sus datos.
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

// ── Excel formato ARCA "Mis Comprobantes" (planilla modelo que usa el contador para subir a
// ARCA, replicando exactamente PRE005 8.xls) ──────────────────────────────────────────────
// Solo se completan las columnas para las que gestor-obras tiene datos reales — el resto queda
// en blanco a propósito, tal cual pidió el usuario, para que el contador lo complete a mano.
// Nunca se inventa un código, un CUIT o un importe que no esté respaldado por datos cargados.

// Códigos oficiales de "Tipo de Comprobante" del servicio ARCA "Mis Comprobantes" — son números
// simples SIN ceros a la izquierda (Factura A = 1, no "001"). Ese otro formato con ceros
// (001, 002...) pertenece a un sistema distinto de AFIP (comprobantes preimpresos) y NO es el
// que usa esta planilla de importación de "Mis Comprobantes".
const CODIGO_ARCA_POR_TIPO = {
  factura_a: 1,
  factura_b: 6,
  factura_c: 11,
}

// gestor-obras no distingue la letra (A/B/C) de un "Recibo" — se infiere según la situación
// impositiva del proveedor, el mismo criterio que ya usa la app para sugerir el tipo de
// comprobante al cargar un proveedor nuevo (ver SITUACIONES en constants.js). Si no hay
// proveedor cargado o no tiene situación impositiva, se deja en blanco: mejor que lo complete
// el contador a que la app invente la letra.
const CODIGO_RECIBO_POR_SITUACION = {
  responsable_inscripto: 4, // Recibo A
  exento: 9,                // Recibo B
  monotributo: 15,          // Recibo C
  consumidor_final: 15,     // Recibo C (no hay código específico para consumidor final)
}

// "Ticket" en gestor-obras siempre se mapea al código 83 ("Tique" genérico) — los códigos 81/82
// son para tique-factura A/B emitidos por controlador fiscal, distinción que la app no registra.
const CODIGO_TICKET = 83

function codigoTipoComprobanteARCA(g) {
  if (g.tipo_comprobante === 'ticket') return CODIGO_TICKET
  if (g.tipo_comprobante === 'recibo') {
    return CODIGO_RECIBO_POR_SITUACION[g.proveedores?.situacion_impositiva] ?? ''
  }
  return CODIGO_ARCA_POR_TIPO[g.tipo_comprobante] ?? ''
}

// "YYYY-MM-DD" (formato interno) → "DD/MM/YYYY" (formato de fecha de la planilla de ARCA).
function fechaARCA(fechaISO) {
  const [y, m, d] = String(fechaISO || '').split('-')
  if (!y || !m || !d) return fechaISO || ''
  return `${d}/${m}/${y}`
}

// El número de comprobante suele venir como "0001-00012345" (punto de venta - número), pero al
// venir muchas veces de una extracción por IA desde una foto no siempre respeta ese formato
// exacto. Si no se puede separar con confianza, se dejan ambas columnas en blanco — mejor que el
// contador las complete a mano a que gestor-obras invente un punto de venta o un número.
function separarPuntoVentaNumero(nroComprobante) {
  const m = String(nroComprobante || '').trim().match(/^(\d{1,5})\s*[-/]\s*(\d{1,10})$/)
  if (!m) return { puntoVenta: '', numero: '' }
  return { puntoVenta: m[1].padStart(4, '0'), numero: m[2].padStart(8, '0') }
}

// Deja solo dígitos del CUIT (la planilla de ARCA lo espera como número, sin guiones).
function cuitSoloDigitos(cuit) {
  return String(cuit || '').replace(/\D/g, '')
}

// Encabezados EXACTOS de la planilla modelo del contador (PRE005 8.xls) — se replican tal cual,
// incluyendo las columnas en blanco que ya trae la planilla original, para que el archivo
// generado sea 100% compatible con lo que el contador usa para subir a ARCA.
const ENCABEZADOS_VENTAS_ARCA = [
  'Fecha de Emisión', 'Tipo de Comprobante (AFIP - Mis Comprobantes)', 'Punto de Venta', 'Número',
  'Número Hasta', 'Número de CAI', 'Tipo de Documento del Cliente', 'Número de Documento del Cliente',
  'Razón social del Cliente', 'Cotización', 'Moneda', 'Neto Grav. IVA 0%', 'IVA 2,5%',
  'Neto Grav. IVA 2,5%', 'IVA 5%', 'Neto Grav. IVA 5%', 'IVA 10,5%', 'Neto Grav. IVA 10,5%',
  'IVA 21%', 'Neto Grav. IVA 21%', 'IVA 27%', 'Neto Grav. IVA 27%', 'Importe Neto',
  'Impuestos Internos / No Gravado', 'Importe Exento', '', 'IVA Inscripto',
  'Importe Total del Comprobante', 'Importe Reg Esp 1 (AFIP - Mis Comprobantes)',
  'Importe Reg Esp 2 (AFIP - Mis Comprobantes)', 'Importe Reg Esp 3 (AFIP - Mis Comprobantes)',
  'Importe Reg Esp 4 (AFIP - Mis Comprobantes)', 'Código de Concepto/Artículo', 'Provincia IIBB',
]

const ENCABEZADOS_COMPRAS_ARCA = [
  'Fecha de Emisión', 'Tipo de Comprobante (AFIP - Mis Comprobantes)', 'Punto de Venta', 'Número',
  'Número Hasta', 'Número de CAI', '', 'CUIT del Proveedor', 'Razón social del Provedor', '', '',
  'Cotización', 'Moneda', 'Neto Grav. IVA 0%', 'IVA 2,5%', 'Neto Grav. IVA 2,5%', 'IVA 5%',
  'Neto Grav. IVA 5%', 'IVA 10,5%', 'Neto Grav. IVA 10,5%', 'IVA 21%', 'Neto Grav. IVA 21%',
  'IVA 27%', 'Neto Grav. IVA 27%', 'Importe Neto', 'Impuestos Internos / No Gravado',
  'Importe Exento', '', 'IVA Inscripto', 'Importe Total del Comprobante',
  'Importe Reg Esp 1 (AFIP - Mis Comprobantes)', 'Importe Reg Esp 2 (AFIP - Mis Comprobantes)',
  'Importe Reg Esp 3 (AFIP - Mis Comprobantes)', 'Importe Reg Esp 4 (AFIP - Mis Comprobantes)',
  'Código de Concepto / Artículo', 'Provincia IIBB',
]

// Arma la fila de la hoja "Compras" para un gasto, en el mismo orden de columnas que la planilla
// modelo del contador.
function filaCompraARCA(g) {
  const monto = parseFloat(g.monto) || 0
  const tieneIva = !!g.discrimina_iva
  const ivaMonto = tieneIva ? (parseFloat(g.iva_monto) || 0) : ''
  const neto = tieneIva ? +(monto - (parseFloat(g.iva_monto) || 0)).toFixed(2) : ''
  const importeNeto = tieneIva ? neto : monto
  const { puntoVenta, numero } = separarPuntoVentaNumero(g.nro_comprobante)
  return [
    fechaARCA(g.fecha),                                              // Fecha de Emisión
    codigoTipoComprobanteARCA(g),                                    // Tipo de Comprobante
    puntoVenta,                                                      // Punto de Venta
    numero,                                                          // Número
    numero,                                                          // Número Hasta (mismo comprobante)
    '',                                                              // Número de CAI
    '',                                                              // (blanco en la planilla modelo)
    g.proveedores?.cuit ? cuitSoloDigitos(g.proveedores.cuit) : '',  // CUIT del Proveedor
    g.proveedores?.nombre || '',                                     // Razón social del Provedor
    '', '',                                                          // (blanco en la planilla modelo)
    1,                                                                // Cotización (siempre pesos)
    '$',                                                              // Moneda
    '',                                                              // Neto Grav. IVA 0%
    '', '',                                                          // IVA 2,5% / Neto Grav. IVA 2,5%
    '', '',                                                          // IVA 5% / Neto Grav. IVA 5%
    '', '',                                                          // IVA 10,5% / Neto Grav. IVA 10,5%
    ivaMonto, neto,                                                  // IVA 21% / Neto Grav. IVA 21%
    '', '',                                                          // IVA 27% / Neto Grav. IVA 27%
    importeNeto,                                                     // Importe Neto
    '',                                                              // Impuestos Internos / No Gravado
    '',                                                              // Importe Exento
    '',                                                              // (blanco en la planilla modelo)
    '',                                                              // IVA Inscripto
    monto,                                                           // Importe Total del Comprobante
    '', '', '', '',                                                  // Importe Reg Esp 1-4
    '',                                                              // Código de Concepto / Artículo
    '',                                                              // Provincia IIBB
  ]
}

// Genera el Excel "Compras para ARCA (Mis Comprobantes).xlsx" con hojas "Ventas" (solo
// encabezados, tal cual la planilla modelo — SEATE no factura ventas por este circuito) y
// "Compras" (encabezados + una fila por cada gasto del rango exportado).
function generarExcelARCA(gastos) {
  const wb = XLSX.utils.book_new()
  const wsVentas = XLSX.utils.aoa_to_sheet([ENCABEZADOS_VENTAS_ARCA])
  XLSX.utils.book_append_sheet(wb, wsVentas, 'Ventas')
  const wsCompras = XLSX.utils.aoa_to_sheet([ENCABEZADOS_COMPRAS_ARCA, ...gastos.map(filaCompraARCA)])
  XLSX.utils.book_append_sheet(wb, wsCompras, 'Compras')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}

/**
 * Arma y descarga un .zip con las facturas de los gastos cuya fecha cae dentro de
 * [fechaDesde, fechaHasta] (ambos YYYY-MM-DD, cualquiera puede venir vacío = sin límite),
 * más un "Listado para el contador.xlsx" con el detalle de cada gasto incluido.
 * No incluye comprobantes de pago ni datos de obra/estado de pago (a pedido de los usuarios).
 * onProgress(i, total) opcional, para reflejar avance en la UI mientras se descargan los archivos.
 * Devuelve { count, incluidos, faltantes }: count = gastos en el rango, incluidos = facturas que
 * se pudieron sumar al zip, faltantes = facturas que no se pudieron descargar/no existían.
 */
export async function exportarZipComprobantes(gastos, fechaDesde, fechaHasta, onProgress) {
  const enRango = (gastos || []).filter(g =>
    (!fechaDesde || g.fecha >= fechaDesde) && (!fechaHasta || g.fecha <= fechaHasta)
  )
  if (enRango.length === 0) return { count: 0, incluidos: 0, faltantes: 0 }

  const zip = new JSZip()
  const carpetaFacturas = zip.folder('Facturas')
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

    listado.push({
      'Fecha': g.fecha,
      'Proveedor': proveedor,
      'Concepto': CONCEPTO_LABELS[g.concepto] ?? g.concepto ?? '',
      'Tipo comprobante': getTipoLabel(g.tipo_comprobante),
      'Nº comprobante': g.nro_comprobante || '',
      'Monto': fmt(g.monto),
      'Archivo factura': archivoFactura || 'Sin adjuntar',
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

  // Excel adicional en el formato exacto que pide ARCA para "Mis Comprobantes" (planilla modelo
  // del contador) — mismo rango de gastos que el resto del export.
  const excelArcaBuffer = generarExcelARCA(enRango)
  zip.file('Compras para ARCA (Mis Comprobantes).xlsx', excelArcaBuffer)

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
