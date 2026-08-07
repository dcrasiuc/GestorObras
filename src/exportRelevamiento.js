// ── Exportación de Relevamientos: Informe Técnico (Word) y Presupuesto (Excel) ─────────────────
// Genera los dos documentos finales de un relevamiento a partir de los datos REALES ya cargados
// y persistidos (relevamiento_items / relevamiento_mensajes) — nunca inventa precios ni códigos:
// un ítem sin precio_unitario (porque no matcheó contra catalogo_cifras) queda marcado "A cotizar"
// en el Excel y sin monto en el Word, tal cual está guardado.
import * as XLSX from 'xlsx'
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, ImageRun } from 'docx'

// Mismo mapeo value→label que el <select> de "Organismo Destinatario" en el modal de Nuevo Relevamiento.
const ORGANISMO_LABELS = {
  IPRODHA: 'IPRODHA',
  USSECP: 'USSECP / UCEF',
  EBY: 'EBY (Entidad Binacional Yacyretá)',
  MUNI_POSADAS: 'Municipalidad de Posadas',
  VIALIDAD: 'Vialidad Provincial',
  OTRO: 'Otro',
}
const labelOrganismo = (o) => ORGANISMO_LABELS[o] || o || 'Sin especificar'

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const fechaInformeHoy = () => { const d = new Date(); return `${MESES[d.getMonth()]} -${d.getFullYear()}` }

const num = (v) => Math.round((parseFloat(v) || 0) * 100) / 100
const limpiarMarkdown = (txt) => String(txt || '').replace(/\*\*/g, '')
const slugArchivo = (txt) => String(txt || 'relevamiento').trim().replace(/[^\w\-]+/g, '_').slice(0, 60)

function descargarBlob(blob, nombreArchivo) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombreArchivo
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// PRESUPUESTO (Excel) — mismo esquema que el PRESUP real de SEATE: agrupado por rubro, con
// fórmulas de Excel reales (no valores fijos) y coeficientes SEATE: +15% Gastos Generales sobre
// el costo, +10% Beneficio sobre costo+GG, +23.5% Impuestos sobre el subtotal. Además un "Anexo
// por Sector" con la misma info agrupada por sector/ambiente en vez de por rubro.
// ═══════════════════════════════════════════════════════════════════════════════════════════
export function exportarPresupuestoRelevamiento(relevamiento, items) {
  const itemsValidos = (items || []).filter((i) => i.item)
  const rubros = [...new Set(itemsValidos.map((i) => i.rubro).filter(Boolean))]
  let itemsSinPrecioCount = 0

  // ── Hoja PRESUPUESTO ──
  const aoa = []
  aoa.push(['PRESUPUESTO', ''])
  aoa.push(['COMITENTE:', labelOrganismo(relevamiento.organismo)])
  aoa.push(['OBRA:', relevamiento.titulo_obra || ''])
  aoa.push(['LUGAR:', [relevamiento.escuela_lugar, relevamiento.localidad].filter(Boolean).join(' — ')])
  aoa.push(['Fecha:', new Date().toLocaleDateString('es-AR')])
  aoa.push([])
  aoa.push(['N°', 'ITEM', 'UN.', 'CANT', 'PRECIO UNITARIO', 'PRECIO PARCIAL', 'PRECIO TOTAL', '% INC'])

  const rubroFilas = [] // { filaRubro, primerItemFila, ultimoItemFila } — todas 1-based (fila real de Excel)
  const itemFilaInfo = [] // { fila, conPrecio }

  rubros.forEach((rubro, rIdx) => {
    const filaRubro = aoa.length + 1
    aoa.push([`${rIdx + 1}`, rubro, '', '', '', '', '', ''])
    const itemsDelRubro = itemsValidos.filter((i) => i.rubro === rubro)
    let primerItemFila = null
    let ultimoItemFila = null
    itemsDelRubro.forEach((it, iIdx) => {
      const conPrecio = it.precioUnitario != null
      if (!conPrecio) itemsSinPrecioCount++
      const filaItem = aoa.length + 1
      aoa.push([
        `${rIdx + 1}.${iIdx + 1}`,
        it.item,
        it.un,
        num(it.cant),
        conPrecio ? num(it.precioUnitario) : 'A cotizar',
        conPrecio ? '' : 'Sin precio de catálogo',
        '',
        '',
      ])
      itemFilaInfo.push({ fila: filaItem, conPrecio })
      if (primerItemFila === null) primerItemFila = filaItem
      ultimoItemFila = filaItem
    })
    if (primerItemFila === null) { primerItemFila = filaRubro; ultimoItemFila = filaRubro }
    rubroFilas.push({ filaRubro, primerItemFila, ultimoItemFila })
  })

  const finRubrosFila = aoa.length
  aoa.push([])
  const filaCosto = aoa.length + 1
  aoa.push(['', 'COSTO TOTAL', '', '', '', '', '', ''])
  const filaGG = aoa.length + 1
  aoa.push(['', 'Gastos Generales', 0.15, '', '', '', '', ''])
  const filaBen = aoa.length + 1
  aoa.push(['', 'Beneficio', 0.10, '', '', '', '', ''])
  const filaSub = aoa.length + 1
  aoa.push(['', 'Sub total', '', '', '', '', '', ''])
  const filaImp = aoa.length + 1
  aoa.push(['', 'Impuestos (IVA + IB)', 0.235, '', '', '', '', ''])
  const filaFinal = aoa.length + 1
  aoa.push(['', 'PRECIO FINAL', '', '', '', '', '', ''])

  const ws = XLSX.utils.aoa_to_sheet(aoa)

  // Fórmulas reales (igual que el PRESUP real: nada queda como número fijo, todo se puede
  // reabrir y editar en Excel sin perder la relación entre celdas).
  itemFilaInfo.forEach(({ fila, conPrecio }) => {
    if (conPrecio) ws[`F${fila}`] = { t: 'n', f: `D${fila}*E${fila}` }
  })
  rubroFilas.forEach(({ filaRubro, primerItemFila, ultimoItemFila }) => {
    ws[`G${filaRubro}`] = { t: 'n', f: `SUM(F${primerItemFila}:F${ultimoItemFila})` }
    ws[`H${filaRubro}`] = { t: 'n', f: `G${filaRubro}/$G$${filaCosto}` }
  })
  ws[`G${filaCosto}`] = rubroFilas.length
    ? { t: 'n', f: `SUM(G${rubroFilas[0].filaRubro}:G${finRubrosFila})` }
    : { t: 'n', v: 0 }
  ws[`G${filaGG}`] = { t: 'n', f: `G${filaCosto}*C${filaGG}` }
  ws[`G${filaBen}`] = { t: 'n', f: `(G${filaCosto}+G${filaGG})*C${filaBen}` }
  ws[`G${filaSub}`] = { t: 'n', f: `G${filaCosto}+G${filaGG}+G${filaBen}` }
  ws[`G${filaImp}`] = { t: 'n', f: `G${filaSub}*C${filaImp}` }
  ws[`G${filaFinal}`] = { t: 'n', f: `G${filaSub}+G${filaImp}` }

  ws['!cols'] = [{ wch: 6 }, { wch: 55 }, { wch: 8 }, { wch: 8 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 8 }]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'PRESUPUESTO')

  // ── Hoja Anexo por Sector (misma info, agrupada por sector/ambiente en vez de por rubro) ──
  const sectores = [...new Set(itemsValidos.map((i) => i.sector).filter(Boolean))]
  const aoaAnexo = [['SECTOR / AMBIENTE', 'N°', 'ITEM', 'UN.', 'CANT', 'PRECIO UNITARIO', 'PRECIO PARCIAL']]
  sectores.forEach((sector) => {
    const itemsDelSector = itemsValidos.filter((i) => i.sector === sector)
    let totalSector = 0
    itemsDelSector.forEach((it, iIdx) => {
      const conPrecio = it.precioUnitario != null
      const parcial = conPrecio ? num(it.cant) * num(it.precioUnitario) : null
      if (parcial != null) totalSector += parcial
      aoaAnexo.push([
        iIdx === 0 ? sector : '',
        `${iIdx + 1}`,
        it.item,
        it.un,
        num(it.cant),
        conPrecio ? num(it.precioUnitario) : 'A cotizar',
        conPrecio ? num(parcial) : 'Sin precio de catálogo',
      ])
    })
    aoaAnexo.push(['', '', `Subtotal ${sector}`, '', '', '', num(totalSector)])
    aoaAnexo.push([])
  })
  const wsAnexo = XLSX.utils.aoa_to_sheet(aoaAnexo)
  wsAnexo['!cols'] = [{ wch: 22 }, { wch: 6 }, { wch: 50 }, { wch: 8 }, { wch: 8 }, { wch: 16 }, { wch: 16 }]
  XLSX.utils.book_append_sheet(wb, wsAnexo, 'Anexo por Sector')

  const fecha = new Date().toISOString().slice(0, 10)
  XLSX.writeFile(wb, `Presupuesto_${slugArchivo(relevamiento.titulo_obra)}_${fecha}.xlsx`)

  return { itemsSinPrecioCount }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// INFORME TÉCNICO / MEMORIA DESCRIPTIVA (Word) — mismo esquema que el INFOREM real de SEATE:
// membrete, ficha institucional, 1. Antecedentes, 2. Condiciones particulares (se completa con
// las alertas de "control de omisiones" que dejó la IA), 3. Relevamiento fotográfico y estado
// actual (por sector, con las fotos reales subidas a Storage y su epígrafe "Foto N – ..."),
// 4. Observaciones técnicas (ítems marcados riesgo=urgente).
// ═══════════════════════════════════════════════════════════════════════════════════════════
export async function generarInformeTecnicoRelevamiento(relevamiento, items, mensajes) {
  const itemsValidos = (items || []).filter((i) => i.item)
  const sectores = [...new Set(itemsValidos.map((i) => i.sector).filter(Boolean))]
  const rubrosDistintos = [...new Set(itemsValidos.map((i) => i.rubro).filter(Boolean))]

  const children = []

  // ── Membrete ──
  children.push(new Paragraph({ children: [new TextRun({ text: 'SEATE', bold: true, size: 32 })] }))
  children.push(new Paragraph({ children: [new TextRun({ text: 'CONSTRUCCIONES', size: 18, color: '888888' })] }))
  children.push(new Paragraph({ children: [new TextRun({ text: 'Contacto: +54 376 462-9793   seatesrl@gmail.com', size: 18 })], spacing: { after: 300 } }))

  // ── Título ──
  children.push(new Paragraph({ text: 'Memoria Descriptiva', heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { after: 300 } }))

  // ── Ficha institucional ──
  const filaFicha = (label, valor) => new TableRow({
    children: [
      new TableCell({ width: { size: 35, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })] }),
      new TableCell({ width: { size: 65, type: WidthType.PERCENTAGE }, children: [new Paragraph(valor || '—')] }),
    ],
  })
  const gps = (relevamiento.latitud != null && relevamiento.longitud != null)
    ? ` (GPS: ${relevamiento.latitud.toFixed(5)}, ${relevamiento.longitud.toFixed(5)})`
    : ''
  const ubicacionTxt = [relevamiento.localidad, relevamiento.provincia || 'Misiones'].filter(Boolean).join(', ') + gps

  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      filaFicha('Establecimiento:', relevamiento.escuela_lugar),
      filaFicha('Ubicación:', ubicacionTxt),
      filaFicha('Organismos intervinientes:', labelOrganismo(relevamiento.organismo)),
      filaFicha('Objeto:', relevamiento.titulo_obra),
      filaFicha('Técnico responsable:', relevamiento.tecnico_responsable || '—'),
      filaFicha('Fecha del informe:', fechaInformeHoy()),
    ],
  }))
  children.push(new Paragraph({ text: '', spacing: { after: 300 } }))

  // ── 1. Antecedentes ──
  children.push(new Paragraph({ text: '1. Antecedentes', heading: HeadingLevel.HEADING_2 }))
  children.push(new Paragraph({
    text: `Por encargo de ${labelOrganismo(relevamiento.organismo)}, personal técnico de SEATE S.R.L. realizó una inspección técnica en ${relevamiento.escuela_lugar || 'el establecimiento'}${relevamiento.localidad ? ` (${relevamiento.localidad})` : ''}, a los efectos de relevar el estado actual de sus instalaciones y elaborar la presente memoria descriptiva con el detalle de las tareas necesarias.`,
    spacing: { after: 200 },
  }))
  if (rubrosDistintos.length) {
    children.push(new Paragraph({ text: 'Rubros relevados en la presente inspección:', spacing: { after: 100 } }))
    rubrosDistintos.forEach((r) => children.push(new Paragraph({ text: `•  ${r}`, spacing: { after: 60 } })))
  }

  // ── 2. Condiciones particulares (alertas de "control de omisiones" dejadas por la IA) ──
  children.push(new Paragraph({ text: '2. Condiciones particulares para la ejecución de la obra', heading: HeadingLevel.HEADING_2, spacing: { before: 300 } }))
  const alertas = (mensajes || []).filter((m) => m.emisor === 'ia' && limpiarMarkdown(m.mensaje).includes('Control de omisiones'))
  if (alertas.length) {
    alertas.forEach((a) => {
      const limpio = limpiarMarkdown(a.mensaje).replace(/^⚠️\s*/, '').replace(/^Control de omisiones:\s*/, '')
      children.push(new Paragraph({ text: `${a.sector ? `[${a.sector}] ` : ''}${limpio}`, spacing: { after: 150 } }))
    })
  } else {
    children.push(new Paragraph({ text: 'No se registraron condiciones particulares adicionales a verificar durante la inspección de campo.', spacing: { after: 150 } }))
  }

  // ── 3. Relevamiento fotográfico y estado actual ──
  children.push(new Paragraph({ text: '3. Relevamiento fotográfico y estado actual', heading: HeadingLevel.HEADING_2, spacing: { before: 300 } }))
  let fotoContador = 0
  for (let sIdx = 0; sIdx < sectores.length; sIdx++) {
    const sector = sectores[sIdx]
    children.push(new Paragraph({ text: `3.${sIdx + 1} ${sector}`, heading: HeadingLevel.HEADING_3, spacing: { before: 200 } }))
    const itemsDelSector = itemsValidos.filter((i) => i.sector === sector)
    for (const it of itemsDelSector) {
      const desc = `${it.codigoItem ? `#${it.codigoItem} — ` : ''}${it.rubro ? it.rubro + ': ' : ''}${it.item}${it.esRestauracion ? ' (restauración/recupero)' : ''}`
      children.push(new Paragraph({ children: [new TextRun({ text: desc, bold: true })], spacing: { after: 80 } }))
      if (it.descripcionDetallada) {
        children.push(new Paragraph({ text: it.descripcionDetallada, spacing: { after: 80 } }))
      }
      const urls = (it.fotoUrl || '').split(',').map((u) => u.trim()).filter(Boolean)
      for (const url of urls) {
        fotoContador++
        try {
          const resp = await fetch(url)
          if (!resp.ok) throw new Error('No se pudo descargar la foto')
          const buf = await resp.arrayBuffer()
          children.push(new Paragraph({
            children: [new ImageRun({ data: buf, type: 'jpg', transformation: { width: 420, height: 315 } })],
            spacing: { after: 60 },
          }))
        } catch (e) {
          console.warn('No se pudo incrustar foto en el Word:', url, e?.message || e)
        }
        children.push(new Paragraph({ children: [new TextRun({ text: `Foto ${fotoContador} – ${it.item}`, italics: true, size: 18 })], spacing: { after: 200 } }))
      }
    }
  }

  // ── 4. Observaciones técnicas — patologías detectadas (ítems marcados riesgo=urgente) ──
  children.push(new Paragraph({ text: '4. Observaciones técnicas — patologías detectadas', heading: HeadingLevel.HEADING_2, spacing: { before: 300 } }))
  const urgentes = itemsValidos.filter((i) => i.riesgo === 'urgente')
  if (urgentes.length) {
    urgentes.forEach((it) => {
      const txt = `${it.sector ? `[${it.sector}] ` : ''}${it.rubro ? it.rubro + ' — ' : ''}${it.item}${it.descripcionDetallada ? `: ${it.descripcionDetallada}` : ''}.`
      children.push(new Paragraph({ text: txt, spacing: { after: 150 } }))
    })
  } else {
    children.push(new Paragraph({ text: 'No se relevaron patologías clasificadas como riesgo urgente durante la presente inspección.', spacing: { after: 150 } }))
  }

  const doc = new Document({ sections: [{ properties: {}, children }] })
  const blob = await Packer.toBlob(doc)
  const fecha = new Date().toISOString().slice(0, 10)
  descargarBlob(blob, `Informe_Tecnico_${slugArchivo(relevamiento.titulo_obra)}_${fecha}.docx`)
}
