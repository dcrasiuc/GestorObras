import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'
import { dbWrite, fmt } from './utils'
import { C } from './constants'
import './toast'
import { exportarPresupuestoRelevamiento, generarInformeTecnicoRelevamiento } from './exportRelevamiento'

// Llama a la Edge Function analizar-comprobante en modo "relevamiento": la IA lee de verdad las
// fotos del sector (ya subidas a Storage) + el relato dictado, y devuelve ítems matcheados contra
// el catálogo real de precios (catalogo_cifras) — reemplaza la simulación por palabras clave.
async function analizarSectorConIA({ fotoUrls, relato, sector }) {
  const fnUrl = 'https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante'
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('La IA tardó demasiado en responder. Probá de nuevo.')), 45000))
  const respRaw = await Promise.race([
    fetch(fnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}` },
      body: JSON.stringify({ tipoAnalisis: 'relevamiento', fotoUrls, relato, sector }),
    }),
    timeout,
  ])
  const data = await respRaw.json()
  if (!respRaw.ok || data?.error) throw new Error(data?.error || `HTTP ${respRaw.status}`)
  return data // { especialista, mensaje_auditoria, alertas_omision, items: [...] }
}

// Llama a la Edge Function en modo "consulta_relevamiento": chat real sobre un cómputo ya
// generado (propuesto o confirmado) para un sector — le manda los ítems reales (no lo que "cree
// recordar" el modelo) para que pueda explicar de dónde sale una cantidad o un precio, en vez de
// la simulación anterior que solo reaccionaba a palabras clave sin responder nada de verdad.
async function consultarSectorConIA({ sector, pregunta, itemsContexto, historial }) {
  const fnUrl = 'https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante'
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('La IA tardó demasiado en responder. Probá de nuevo.')), 30000))
  const respRaw = await Promise.race([
    fetch(fnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}` },
      body: JSON.stringify({ tipoAnalisis: 'consulta_relevamiento', sector, pregunta, itemsContexto, historial }),
    }),
    timeout,
  ])
  const data = await respRaw.json()
  if (!respRaw.ok || data?.error) throw new Error(data?.error || `HTTP ${respRaw.status}`)
  return data.respuesta // string
}

// ── Compresión y subida de fotos de relevamiento a Storage ("relevamientos-fotos") ─────────────
// Mismo patrón usado en Seguros.jsx (subirDocumentoStorage): comprime a JPG antes de subir,
// reintenta una vez si falla, y devuelve la URL pública o null.
async function _canvasComprimidoRelevamiento(file, maxLado = 1280) {
  const objUrl = URL.createObjectURL(file)
  const img = await Promise.race([
    new Promise((res, rej) => { const i = new Image(); i.onerror = () => { URL.revokeObjectURL(objUrl); rej(new Error('img error')) }; i.onload = () => res(i); i.src = objUrl }),
    new Promise((_, rej) => setTimeout(() => { URL.revokeObjectURL(objUrl); rej(new Error('Image load timeout')) }, 20000))
  ])
  URL.revokeObjectURL(objUrl)
  let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height
  if (w > maxLado || h > maxLado) { if (w >= h) { h = Math.round(h * maxLado / w); w = maxLado } else { w = Math.round(w * maxLado / h); h = maxLado } }
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  canvas.getContext('2d').drawImage(img, 0, 0, w, h)
  return canvas
}
async function _comprimirImagenBlobRelevamiento(file, maxLado = 1280, calidad = 0.65) {
  const canvas = await _canvasComprimidoRelevamiento(file, maxLado)
  return await Promise.race([
    new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/jpeg', calidad)),
    new Promise((_, rej) => setTimeout(() => rej(new Error('toBlob timeout')), 10000))
  ])
}
// Convierte un blob a base64 puro (sin el prefijo "data:...;base64,") para mandarlo a la Edge
// Function — mismo patrón que `leerBase64` en GestorObras.jsx.
function _leerBase64Relevamiento(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onerror = rej; r.onload = e => res(String(e.target.result).split(',')[1]); r.readAsDataURL(blob) })
}
async function subirFotoRelevamiento(file, carpeta = 'sectores') {
  try {
    // Antes esto subía DIRECTO a Storage desde el cliente (supabase.storage.upload) — el mismo
    // patrón que ya había fallado/tardado en otros lugares de la app por el carrier que
    // bloquea/estanca POSTs directos desde mobile (reportado como "tarda mucho en subir fotos",
    // dos veces). Ahora pasa por la Edge Function (modo "subir_archivo", server-to-server) igual
    // que el comprobante de pago — mismo fix, mismo motivo.
    let blob = file, mimeType = 'image/jpeg'
    try { blob = await _comprimirImagenBlobRelevamiento(file); mimeType = 'image/jpeg' } catch { mimeType = file?.type || 'image/jpeg' /* sube el original si falla la compresión, con su tipo real */ }
    const base64 = await _leerBase64Relevamiento(blob)
    const fnUrl = 'https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante'
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
    const intentar = () => Promise.race([
      fetch(fnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}` },
        body: JSON.stringify({ tipoAnalisis: 'subir_archivo', base64, mimeType, bucket: 'relevamientos-fotos', carpeta }),
      }).then(async r => ({ ok: r.ok, data: await r.json().catch(() => null) })),
      new Promise(res => setTimeout(() => res({ ok: false, data: { error: 'timeout' } }), 60000)),
    ])
    let res = await intentar()
    if (!res.ok || res.data?.error) { await new Promise(r => setTimeout(r, 1500)); res = await intentar() }
    if (!res.ok || res.data?.error || !res.data?.url) { window._toast?.('No se pudo subir la foto. Verificá la conexión e intentá de nuevo.', 'error'); return null }
    return res.data.url
  } catch (e) {
    console.warn('subirFotoRelevamiento:', e?.message || e)
    window._toast?.('No se pudo subir la foto.', 'error')
    return null
  }
}
// Sanitiza el nombre de sector para usarlo como carpeta en Storage.
function _slugSector(txt) {
  return String(txt || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w\-]+/g, '') || 'sector'
}
// Extrae el código numérico de Cifras de un texto tipo "184. Lavatorio loza blanca..." → "184".
function _extraerCodigoItem(texto) {
  const m = String(texto || '').match(/^\s*(\d+)\s*\./)
  return m ? m[1] : null
}
// Mapea una fila de relevamiento_items (DB) a la forma que usa la UI.
function _filaDbAItem(i) {
  return {
    id: i.id,
    rubro: i.rubro,
    item: i.descripcion_item,
    descripcionDetallada: i.notas_campo || '',
    un: i.unidad,
    cant: i.cantidad ?? 1,
    sector: i.sector,
    riesgo: i.riesgo || 'funcional',
    esRestauracion: !!i.es_restauracion,
    codigoItem: i.codigo_item,
    fotoUrl: i.foto_url,
    precioUnitario: i.precio_unitario ?? null,
    subtotal: i.subtotal ?? null,
    // % del precio de un ítem nuevo que se cobró por la reparación (1 = precio completo/ítem nuevo).
    coeficienteAjuste: i.coeficiente_ajuste ?? 1,
  }
}
// Persiste un ítem de cómputo en relevamiento_items y devuelve la fila insertada (o null si falló).
// codigoItem: si viene explícitamente en null (la IA no encontró match en el catálogo y prefirió
// no inventar un código), se respeta ese null y NO se intenta adivinar uno con la regex — solo se
// usa el fallback por regex cuando el llamador ni siquiera pasó la clave (carga manual).
// coeficienteAjuste: para ítems de restauración/reparación, la fracción (0 a 1] del precio del
// ítem nuevo equivalente que se considera razonable cobrar por reparar el existente en vez de
// reemplazarlo. precioUnitario ya debe venir con ese ajuste aplicado (es el precio efectivo).
async function _persistirItem(relevamientoId, { rubro, item, descripcionDetallada, un, cant, sector, riesgo, esRestauracion, codigoItem, fotoUrl, precioUnitario, coeficienteAjuste }) {
  const cantidadNum = parseFloat(cant) || 0
  const precioNum = precioUnitario != null && precioUnitario !== '' ? parseFloat(precioUnitario) : null
  const coefNum = parseFloat(coeficienteAjuste)
  const coeficienteAjusteNum = Number.isFinite(coefNum) && coefNum > 0 && coefNum <= 1 ? coefNum : 1
  const payload = {
    relevamiento_id: relevamientoId,
    sector,
    foto_url: fotoUrl || null,
    notas_campo: descripcionDetallada || null,
    codigo_item: codigoItem !== undefined ? codigoItem : _extraerCodigoItem(item),
    rubro,
    descripcion_item: item,
    unidad: un,
    cantidad: cantidadNum,
    // TODO: cuando exista UI de largo×ancho×alto, calcular el cómputo total a partir de eso —
    // por ahora el cómputo total es directamente la cantidad cargada/estimada.
    computo_total: cantidadNum,
    es_restauracion: !!esRestauracion,
    riesgo: riesgo || 'funcional',
    precio_unitario: precioNum,
    subtotal: precioNum != null ? +(cantidadNum * precioNum).toFixed(2) : null,
    coeficiente_ajuste: coeficienteAjusteNum,
  }
  try {
    return await dbWrite('POST', 'relevamiento_items', payload, null, true)
  } catch (err) {
    console.error('_persistirItem:', err)
    window._toast?.('No se pudo guardar el ítem: ' + err.message, 'error')
    return null
  }
}

export default function Relevamientos({ onVolver }) {
  const [relevamientos, setRelevamientos] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalNuevo, setModalNuevo] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const [relevamientoActivo, setRelevamientoActivo] = useState(null)

  const [form, setForm] = useState({
    titulo_obra: '',
    organismo: 'IPRODHA',
    escuela_lugar: '',
    localidad: 'Posadas',
    provincia: 'Misiones',
    tecnico_responsable: '',
    foto_fachada_url: '',
    latitud: null,
    longitud: null,
    direccion_gmaps: '',
  })
  const [obteniendoGPS, setObteniendoGPS] = useState(false)
  const [guardando, setGuardando] = useState(false)

  const cargarRelevamientos = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('relevamientos')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) console.error('Error al cargar relevamientos:', error)
      else setRelevamientos(data || [])
    } catch (err) {
      console.error('Catch al cargar relevamientos:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    cargarRelevamientos()
  }, [cargarRelevamientos])

  const capturarGPS = () => {
    if (!navigator.geolocation) {
      if (window._toast) window._toast('Tu navegador no soporta geolocalización', 'error')
      return
    }
    setObteniendoGPS(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude
        const lng = pos.coords.longitude
        const gmapsUrl = `https://maps.google.com/?q=${lat},${lng}`
        setForm((prev) => ({
          ...prev,
          latitud: lat,
          longitud: lng,
          direccion_gmaps: gmapsUrl,
        }))
        setObteniendoGPS(false)
        if (window._toast) window._toast('Ubicación GPS capturada con éxito', 'ok')
      },
      (err) => {
        console.error(err)
        setObteniendoGPS(false)
        if (window._toast) window._toast('No se pudo obtener la ubicación GPS', 'error')
      },
      { enableHighAccuracy: true, timeout: 15000 }
    )
  }

  const handleGuardar = async (e) => {
    e.preventDefault()
    if (!form.titulo_obra || !form.escuela_lugar) {
      if (window._toast) window._toast('Completá el título y la escuela/lugar', 'error')
      return
    }
    setGuardando(true)
    try {
      const payload = {
        titulo_obra: form.titulo_obra,
        organismo: form.organismo,
        escuela_lugar: form.escuela_lugar,
        localidad: form.localidad,
        provincia: form.provincia,
        tecnico_responsable: form.tecnico_responsable,
        foto_fachada_url: form.foto_fachada_url,
        latitud: form.latitud,
        longitud: form.longitud,
        direccion_gmaps: form.direccion_gmaps,
        estado: 'en_relevamiento',
      }

      await dbWrite('POST', 'relevamientos', payload, null, true)
      if (window._toast) window._toast('Relevamiento creado correctamente', 'ok')
      setModalNuevo(false)
      setForm({
        titulo_obra: '',
        organismo: 'IPRODHA',
        escuela_lugar: '',
        localidad: 'Posadas',
        provincia: 'Misiones',
        tecnico_responsable: '',
        foto_fachada_url: '',
        latitud: null,
        longitud: null,
        direccion_gmaps: '',
      })
      cargarRelevamientos()
    } catch (err) {
      console.error(err)
      if (window._toast) window._toast('Error al guardar: ' + err.message, 'error')
    } finally {
      setGuardando(false)
    }
  }

  const relevamientosFiltrados = relevamientos.filter((r) =>
    `${r.titulo_obra} ${r.escuela_lugar} ${r.organismo}`.toLowerCase().includes(busqueda.toLowerCase())
  )

  const lblSt = { display: 'block', fontSize: '12px', fontWeight: 'bold', marginBottom: '4px' }
  const inpSt = { width: '100%', padding: '8px 12px', borderRadius: '6px', border: `1px solid ${C.border}`, boxSizing: 'border-box', backgroundColor: C.surface, color: C.text, fontFamily: "'Outfit', sans-serif" }

  if (relevamientoActivo) {
    return <DetalleRelevamiento relevamiento={relevamientoActivo} onVolver={() => setRelevamientoActivo(null)} />
  }

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100vh', padding: '16px', color: C.text, fontFamily: "'Outfit', sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', backgroundColor: C.surface, padding: '14px 18px', borderRadius: '12px', border: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={onVolver}
            style={{ backgroundColor: 'transparent', border: 'none', fontSize: '20px', cursor: 'pointer', color: C.text }}
            title="Volver"
          >
            ←
          </button>
          <div>
            <h2 style={{ margin: 0, fontSize: '18px', color: C.purple }}>📋 Relevamientos y Cómputos</h2>
            <span style={{ fontSize: '12px', color: C.textMuted }}>SEATE S.R.L. — Control de Campo e Informes</span>
          </div>
        </div>
        <button
          onClick={() => setModalNuevo(true)}
          style={{ backgroundColor: C.purple, color: '#FFF', border: 'none', padding: '10px 16px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}
        >
          + Nuevo
        </button>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <input
          type="text"
          placeholder="Buscar por título, escuela u organismo..."
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          style={inpSt}
        />
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: C.textMuted }}>Cargando relevamientos...</div>
      ) : relevamientosFiltrados.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', backgroundColor: C.surface, borderRadius: '12px', border: `1px solid ${C.border}` }}>
          <p style={{ color: C.textMuted, margin: 0 }}>No hay relevamientos registrados aún.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
          {relevamientosFiltrados.map((r) => (
            <div
              key={r.id}
              onClick={() => setRelevamientoActivo(r)}
              style={{ backgroundColor: C.surface, borderRadius: '12px', border: `1px solid ${C.border}`, padding: '16px', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                <span style={{ backgroundColor: C.purpleDim, color: C.purple, padding: '4px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 'bold' }}>
                  {r.organismo}
                </span>
                <span style={{ fontSize: '12px', color: C.textMuted }}>
                  {new Date(r.created_at).toLocaleDateString('es-AR')}
                </span>
              </div>
              <h3 style={{ margin: '0 0 6px 0', fontSize: '16px', color: C.text }}>{r.titulo_obra}</h3>
              <p style={{ margin: '0 0 10px 0', fontSize: '13px', color: C.textMuted }}>🏫 {r.escuela_lugar}</p>

              {r.direccion_gmaps && (
                <div style={{ fontSize: '12px', color: C.green, marginBottom: '10px' }}>
                  📍 GPS Registrado
                </div>
              )}
              <div style={{ fontSize: '12px', color: C.purple, fontWeight: 'bold', textAlign: 'right' }}>
                Ver detalle →
              </div>
            </div>
          ))}
        </div>
      )}

      {modalNuevo && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '16px' }}>
          <div style={{ backgroundColor: C.surface, borderRadius: '12px', width: '100%', maxWidth: '500px', padding: '24px', maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ margin: '0 0 16px 0', color: C.purple }}>Nuevo Relevamiento de Campo</h3>
            <form onSubmit={handleGuardar}>
              <div style={{ marginBottom: '12px' }}>
                <label style={lblSt}>Título del Relevamiento / Obra *</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: Acondicionamiento Sanitarios y Aulas"
                  value={form.titulo_obra}
                  onChange={(e) => setForm({ ...form, titulo_obra: e.target.value })}
                  style={inpSt}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={lblSt}>Organismo Destinatario</label>
                <select
                  value={form.organismo}
                  onChange={(e) => setForm({ ...form, organismo: e.target.value })}
                  style={inpSt}
                >
                  <option value="IPRODHA">IPRODHA</option>
                  <option value="USSECP">USSECP / UCEF</option>
                  <option value="EBY">EBY (Entidad Binacional Yacyretá)</option>
                  <option value="MUNI_POSADAS">Municipalidad de Posadas</option>
                  <option value="VIALIDAD">Vialidad Provincial</option>
                  <option value="OTRO">Otro</option>
                </select>
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={lblSt}>Escuela / Edificio / Lugar *</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: Escuela N° 123 Provincia de Misiones"
                  value={form.escuela_lugar}
                  onChange={(e) => setForm({ ...form, escuela_lugar: e.target.value })}
                  style={inpSt}
                />
              </div>

              <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
                <div style={{ flex: 1 }}>
                  <label style={lblSt}>Localidad</label>
                  <input
                    type="text"
                    value={form.localidad}
                    onChange={(e) => setForm({ ...form, localidad: e.target.value })}
                    style={inpSt}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={lblSt}>Técnico Responsable</label>
                  <input
                    type="text"
                    placeholder="Nombre del técnico"
                    value={form.tecnico_responsable}
                    onChange={(e) => setForm({ ...form, tecnico_responsable: e.target.value })}
                    style={inpSt}
                  />
                </div>
              </div>

              <div style={{ marginBottom: '16px', backgroundColor: C.bg, padding: '12px', borderRadius: '8px', border: `1px solid ${C.border}` }}>
                <label style={lblSt}>📍 Geolocalización y Coordenadas GPS</label>
                {form.latitud ? (
                  <div style={{ fontSize: '12px', color: C.green }}>
                    Coordenadas: {form.latitud.toFixed(5)}, {form.longitud.toFixed(5)}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={capturarGPS}
                    disabled={obteniendoGPS}
                    style={{ backgroundColor: C.surface, color: C.purple, border: `1px solid ${C.purple}`, padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                  >
                    {obteniendoGPS ? 'Obteniendo GPS...' : '📍 Capturar ubicación GPS actual'}
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => setModalNuevo(false)}
                  style={{ backgroundColor: 'transparent', border: `1px solid ${C.border}`, padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', color: C.textMuted }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={guardando}
                  style={{ backgroundColor: C.purple, color: '#FFF', border: 'none', padding: '8px 16px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  {guardando ? 'Guardando...' : 'Crear Relevamiento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

function DetalleRelevamiento({ relevamiento, onVolver }) {
  const [sectores, setSectores] = useState([])
  const [sectorActivo, setSectorActivo] = useState('')
  const [nuevoSectorNombre, setNuevoSectorNombre] = useState('')

  const [fotosSector, setFotosSector] = useState([])
  const [relato, setRelato] = useState('')
  const [rubrosAcumulados, setRubrosAcumulados] = useState([])
  const [procesando, setProcesando] = useState(false)
  // Ítems que propuso la IA para el sector activo pero TODAVÍA no se guardaron en la base — el
  // técnico revisa/corrige la cantidad de cada uno (medición estimada) antes de confirmarlos.
  // Cada elemento: { rubro, item, descripcionDetallada, un, cant, riesgo, esRestauracion,
  // codigoItem, precioUnitario, confianzaMedicion }.
  const [itemsPropuestos, setItemsPropuestos] = useState([])
  const [confirmandoPropuestos, setConfirmandoPropuestos] = useState(false)
  // Cuando el sector está cerrado, el cómputo arranca compacto (colapsado) para que la pantalla
  // no quede tan larga — se puede expandir a pedido. Mientras el sector sigue abierto (en edición)
  // siempre se ve completo. Se resetea a colapsado cada vez que se cambia de sector.
  const [verDetalleCerrado, setVerDetalleCerrado] = useState(false)
  useEffect(() => { setVerDetalleCerrado(false) }, [sectorActivo])
  const [grabandoAudio, setGrabandoAudio] = useState(false)
  const [cargandoDatos, setCargandoDatos] = useState(true)

  const [chatTexto, setChatTexto] = useState('')
  const [consultandoChat, setConsultandoChat] = useState(false)
  const [mensajes, setMensajes] = useState([]) // { id, sector, emisor: 'tecnico'|'ia', mensaje }
  const [historialOculto, setHistorialOculto] = useState(false)
  const [grabandoAudioChat, setGrabandoAudioChat] = useState(false)

  const [modalManual, setModalNuevoManual] = useState(false)
  const [itemManual, setItemManual] = useState({ rubro: 'INSTALACION SANITARIA', item: '', descripcionDetallada: '', un: 'unid', cant: 1, esRestauracion: false, riesgo: 'urgente', codigoItem: null, precioUnitario: null })
  const [catalogoCifras, setCatalogoCifras] = useState([])
  const [catalogoCargando, setCatalogoCargando] = useState(false)
  const [catalogoError, setCatalogoError] = useState(false)
  // '' = todavía no eligió rubro; '__libre__' = "no está en ningún rubro del catálogo, cargar libre";
  // cualquier otro valor = un rubro REAL de catalogo_cifras, para poder listar sus ítems y
  // confirmar con certeza si el ítem existe en Revista Cifras antes de escribir uno libre.
  const [rubroFiltro, setRubroFiltro] = useState('')

  const [generandoInforme, setGenerandoInforme] = useState(false)
  const [generandoPresupuesto, setGenerandoPresupuesto] = useState(false)

  const sectorActualObj = sectores.find((s) => s.nombre === sectorActivo)
  const mensajesDelSector = mensajes.filter((m) => m.sector === sectorActivo)

  // Carga el catálogo real (234 ítems) recién al abrir el modal manual, para buscarlo/matchearlo
  // ahí — antes la carga manual no tenía forma de matchear contra catalogo_cifras y quedaba sin
  // precio siempre. Failsafe de 12s + try/catch (mismo patrón que useObras/useGastos y los hooks
  // de Seguros.jsx): sin esto, con conexión celular inestable la consulta podía colgar y el
  // selector de rubro se quedaba en "Cargando catálogo..." para siempre, sin ninguna salida.
  const cargarCatalogoCifras = useCallback(async () => {
    setCatalogoCargando(true)
    setCatalogoError(false)
    const failsafe = setTimeout(() => { setCatalogoCargando(false); setCatalogoError(true) }, 12000)
    try {
      const { data, error } = await supabase.from('catalogo_cifras').select('codigo_item,rubro,descripcion,unidad,precio_material,precio_mano_obra,precio_unitario_total').order('codigo_item')
      if (error) throw error
      setCatalogoCifras(data || [])
    } catch (e) {
      console.error('Error al cargar catalogo_cifras:', e)
      setCatalogoError(true)
    } finally {
      clearTimeout(failsafe)
      setCatalogoCargando(false)
    }
  }, [])

  useEffect(() => {
    if (!modalManual || catalogoCifras.length > 0) return
    cargarCatalogoCifras()
  }, [modalManual, catalogoCifras.length, cargarCatalogoCifras])

  // Rubros REALES del catálogo (no una lista fija a mano) — son 20 en la Revista Cifras, distintos
  // de los que había hardcodeados antes (que no coincidían exactamente: p. ej. el catálogo separa
  // "INSTALACION SANITARIA / INCENDIO", "CIELORRASOS", "CONTRAPISOS", "ZOCALOS", etc.).
  const rubrosCatalogo = [...new Set(catalogoCifras.map((c) => c.rubro))].sort()
  const itemsDelRubroFiltro = rubroFiltro && rubroFiltro !== '__libre__' ? catalogoCifras.filter((c) => c.rubro === rubroFiltro) : []

  const handleElegirRubroFiltro = (valor) => {
    setRubroFiltro(valor)
    setItemManual((prev) => ({ ...prev, rubro: valor !== '__libre__' ? valor : prev.rubro, item: '', codigoItem: null, precioUnitario: null }))
  }

  // Al elegir un ítem del <select> ya filtrado por rubro: autocompleta rubro/unidad/precio reales.
  // Si el técnico revisa la lista completa del rubro y no está, "Ninguno de estos" pasa a carga
  // libre — así solo se escribe un ítem "no catalogado" después de haber buscado de verdad.
  const handleElegirItemCatalogo = (codigo) => {
    if (codigo === '__ninguno__') {
      setRubroFiltro('__libre__')
      setItemManual((prev) => ({ ...prev, item: '', codigoItem: null, precioUnitario: null }))
      return
    }
    const match = catalogoCifras.find((c) => String(c.codigo_item) === codigo)
    if (!match) return
    setItemManual((prev) => ({ ...prev, item: `${match.codigo_item} — ${match.descripcion}`, rubro: match.rubro, un: match.unidad, codigoItem: match.codigo_item, precioUnitario: match.precio_unitario_total }))
  }

  // ── Carga inicial: ítems y mensajes ya guardados de este relevamiento (antes se perdían
  // apenas se recargaba la página — ahora relevamiento_items / relevamiento_mensajes son la
  // fuente de verdad y los sectores se derivan de los ítems que ya tienen algo cargado). ──────
  const cargarDatos = useCallback(async () => {
    setCargandoDatos(true)
    try {
      const [itemsRes, mensajesRes] = await Promise.all([
        supabase.from('relevamiento_items').select('*').eq('relevamiento_id', relevamiento.id).order('created_at'),
        supabase.from('relevamiento_mensajes').select('*').eq('relevamiento_id', relevamiento.id).order('created_at'),
      ])
      if (itemsRes.error || mensajesRes.error) {
        console.error('Error al cargar datos del relevamiento:', itemsRes.error || mensajesRes.error)
        window._toast?.('No se pudieron cargar los datos guardados de este relevamiento — revisá tu conexión.', 'error')
      }
      const items = (itemsRes.data || []).map(_filaDbAItem)
      setRubrosAcumulados(items)
      setMensajes((mensajesRes.data || []).map((m) => ({ id: m.id, sector: m.sector, emisor: m.emisor, mensaje: m.mensaje })))
      const sectoresDeItems = [...new Set(items.map((i) => i.sector).filter(Boolean))]
      setSectores((prev) => {
        const existentes = new Set(prev.map((s) => s.nombre))
        const nuevos = sectoresDeItems.filter((s) => !existentes.has(s)).map((nombre) => ({ nombre, cerrado: false }))
        return [...prev, ...nuevos]
      })
    } catch (err) {
      console.error('Catch al cargar datos del relevamiento:', err)
      window._toast?.('No se pudieron cargar los datos guardados de este relevamiento.', 'error')
    } finally {
      setCargandoDatos(false)
    }
  }, [relevamiento.id])

  useEffect(() => { cargarDatos() }, [cargarDatos])

  const obtenerPerfilEspecialista = () => {
    const txt = (sectorActivo + ' ' + relato).toLowerCase()
    if (txt.includes('baño') || txt.includes('sanitari') || txt.includes('inodoro') || txt.includes('bacha') || txt.includes('plomer') || txt.includes('agua')) {
      return { titulo: '🚰 Especialista Sanitarista', color: C.purple }
    }
    if (txt.includes('techo') || txt.includes('alero') || txt.includes('chapa') || txt.includes('cenefa') || txt.includes('membrana') || txt.includes('filtracion')) {
      return { titulo: '🏗️ Especialista en Cubiertas y Zinguería', color: C.purple }
    }
    if (txt.includes('aula') || txt.includes('ventana') || txt.includes('puerta') || txt.includes('reja') || txt.includes('vidrio') || txt.includes('espejo')) {
      return { titulo: '🪟 Especialista en Aberturas y Vidriería', color: C.purple }
    }
    if (txt.includes('luz') || txt.includes('electr') || txt.includes('tablero') || txt.includes('ventilador') || txt.includes('llave')) {
      return { titulo: '⚡ Especialista Electromecánico', color: C.purple }
    }
    if (txt.includes('cauce') || txt.includes('eby') || txt.includes('desmonte') || txt.includes('excav')) {
      return { titulo: '🚜 Especialista en Obras Civiles y Cauces (EBY)', color: C.purple }
    }
    return { titulo: '🧱 Especialista en Mampostería y Revoques', color: C.purple }
  }

  const especialistaActual = obtenerPerfilEspecialista()

  const alternarDictadoVoz = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      if (window._toast) window._toast('Tu navegador no soporta dictado por voz', 'error')
      return
    }

    if (grabandoAudio) {
      setGrabandoAudio(false)
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'es-AR'
    recognition.continuous = false
    recognition.interimResults = false

    recognition.onstart = () => {
      setGrabandoAudio(true)
      if (window._toast) window._toast('Escuchando relato... Hablá ahora', 'ok')
    }

    recognition.onresult = (e) => {
      let finalTranscript = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalTranscript += e.results[i][0].transcript + ' '
        }
      }
      if (finalTranscript.trim()) {
        setRelato((prev) => (prev ? prev.trim() + ' ' + finalTranscript.trim() : finalTranscript.trim()))
      }
    }

    recognition.onerror = () => setGrabandoAudio(false)
    recognition.onend = () => setGrabandoAudio(false)
    recognition.start()
  }

  const alternarDictadoChat = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      if (window._toast) window._toast('Tu navegador no soporta dictado por voz', 'error')
      return
    }

    if (grabandoAudioChat) {
      setGrabandoAudioChat(false)
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'es-AR'
    recognition.continuous = false
    recognition.interimResults = false

    recognition.onstart = () => {
      setGrabandoAudioChat(true)
      if (window._toast) window._toast('Escuchando respuesta... Hablá ahora', 'ok')
    }

    recognition.onresult = (e) => {
      let finalTranscript = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalTranscript += e.results[i][0].transcript + ' '
        }
      }
      if (finalTranscript.trim()) {
        setChatTexto((prev) => (prev ? prev.trim() + ' ' + finalTranscript.trim() : finalTranscript.trim()))
      }
    }

    recognition.onerror = () => setGrabandoAudioChat(false)
    recognition.onend = () => setGrabandoAudioChat(false)
    recognition.start()
  }

  const handleCargarFotos = (e) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return

    const nuevasFotos = files.map((f) => ({
      id: Date.now() + Math.random(),
      url: URL.createObjectURL(f), // preview local inmediata mientras se sube de verdad
      nombre: f.name,
      subiendo: true,
      urlSubida: null,
    }))

    setFotosSector((prev) => [...prev, ...nuevasFotos])
    if (window._toast) window._toast(`${files.length} foto(s) agregadas a ${sectorActivo}`, 'ok')

    // Subida real a Storage (bucket relevamientos-fotos) en paralelo — antes las fotos quedaban
    // solo como blob local (URL.createObjectURL) y se perdían al cerrar la pestaña.
    nuevasFotos.forEach(async (foto, idx) => {
      const url = await subirFotoRelevamiento(files[idx], _slugSector(sectorActivo))
      setFotosSector((prev) => prev.map((f) => (f.id === foto.id ? { ...f, urlSubida: url, subiendo: false } : f)))
      if (!url) window._toast?.(`No se pudo subir "${foto.nombre}" — quedó solo en este dispositivo.`, 'error')
    })
    e.target.value = ''
  }

  const handleEliminarFoto = (id) => {
    setFotosSector((prev) => prev.filter((f) => f.id !== id))
  }

  const handleAgregarSector = (e) => {
    e.preventDefault()
    if (!nuevoSectorNombre.trim()) return
    const nombreLimpio = nuevoSectorNombre.trim()
    if (sectores.some((s) => s.nombre.toLowerCase() === nombreLimpio.toLowerCase())) {
      window._toast?.('Ya existe un sector con ese nombre', 'error')
      return
    }
    setSectores((prev) => [...prev, { nombre: nombreLimpio, cerrado: false }])
    setSectorActivo(nombreLimpio)
    setNuevoSectorNombre('')
    setFotosSector([])
    setRelato('')
  }

  // Nota: como no hay una tabla separada de "sectores" (se derivan de relevamiento_items.sector),
  // un sector recién creado sin ningún ítem cargado todavía no queda guardado en la base — recién
  // se persiste al agregarle el primer ítem. Por eso, si ya tiene ítems o mensajes, eliminar el
  // sector borra también ese contenido del servidor (con confirmación).
  const handleEliminarSector = async (nombreSector, e) => {
    e.stopPropagation()
    const tieneDatos = rubrosAcumulados.some((i) => i.sector === nombreSector) || mensajes.some((m) => m.sector === nombreSector)
    if (tieneDatos && !window.confirm(`El sector "${nombreSector}" ya tiene ítems y/o mensajes guardados. ¿Eliminarlo junto con todo su contenido? Esta acción no se puede deshacer.`)) return
    if (tieneDatos) {
      try {
        await Promise.all([
          dbWrite('DELETE', 'relevamiento_items', null, `relevamiento_id=eq.${relevamiento.id}&sector=eq.${encodeURIComponent(nombreSector)}`),
          dbWrite('DELETE', 'relevamiento_mensajes', null, `relevamiento_id=eq.${relevamiento.id}&sector=eq.${encodeURIComponent(nombreSector)}`),
        ])
      } catch (err) {
        console.error(err)
        window._toast?.('No se pudo eliminar el sector en el servidor: ' + err.message, 'error')
        return
      }
    }
    setSectores((prev) => prev.filter((s) => s.nombre !== nombreSector))
    setRubrosAcumulados((prev) => prev.filter((i) => i.sector !== nombreSector))
    setMensajes((prev) => prev.filter((m) => m.sector !== nombreSector))
    if (sectorActivo === nombreSector) {
      const restantes = sectores.filter((s) => s.nombre !== nombreSector)
      setSectorActivo(restantes.length > 0 ? restantes[0].nombre : '')
    }
    if (window._toast) window._toast(`Sector "${nombreSector}" eliminado`, 'ok')
  }

  const handleProcesarIA = async () => {
    if (!sectorActivo) {
      if (window._toast) window._toast('Creá o seleccioná un sector/ambiente primero', 'error')
      return
    }
    if (fotosSector.length === 0 && !relato.trim()) {
      if (window._toast) window._toast('Subí fotos o escribí/dictá un relato para este sector', 'error')
      return
    }
    if (fotosSector.some((f) => f.subiendo)) {
      if (window._toast) window._toast('Esperá a que terminen de subir las fotos antes de procesar', 'error')
      return
    }

    setProcesando(true)
    const fotoUrlsListas = fotosSector.filter((f) => f.urlSubida).map((f) => f.urlSubida)

    try {
      // La IA lee de verdad las fotos + el relato y devuelve ítems matcheados contra el catálogo
      // real de precios (catalogo_cifras, 234 ítems) — ver Edge Function analizar-comprobante,
      // modo "relevamiento". Los ítems NO se guardan todavía: quedan como propuesta para que el
      // técnico revise/corrija la cantidad (medición estimada) antes de confirmarlos — antes se
      // guardaban directo y una medición mal estimada por la IA (ej. 45m² en vez de 35m²) quedaba
      // persistida sin que nadie la revisara primero.
      const resultado = await analizarSectorConIA({ fotoUrls: fotoUrlsListas, relato: relato.trim(), sector: sectorActivo })
      const itemsIA = resultado.items || []
      if (itemsIA.length === 0) {
        window._toast?.('La IA no propuso ítems para este sector — probá con más detalle en el relato o cargá el ítem manualmente.', 'error')
        return
      }

      setItemsPropuestos((prev) => [
        ...prev,
        ...itemsIA.map((it) => {
          // La IA elige, foto por foto, cuáles documentan ESTE ítem puntual (índices 1-based sobre
          // fotoUrlsListas, en el mismo orden en que se mandaron) — ya no se le pega el combo
          // completo de fotos del sector a todos los ítems por igual.
          const urlsElegidas = Array.isArray(it.fotos_relevantes)
            ? it.fotos_relevantes.map((n) => fotoUrlsListas[n - 1]).filter(Boolean)
            : []
          return {
            rubro: it.rubro,
            item: it.descripcion_item,
            descripcionDetallada: it.justificacion || '',
            un: it.unidad,
            cant: it.cantidad, // editable — es la estimación de la IA, no un valor final
            riesgo: it.riesgo,
            esRestauracion: it.es_restauracion,
            codigoItem: it.codigo_item, // puede venir null a propósito — no inventar código
            fotoUrl: urlsElegidas.length ? urlsElegidas.join(',') : null,
            // Si es restauración con match de catálogo, precio_unitario_ajustado ya viene con el %
            // de reparación aplicado (calculado en el backend); si no, es el mismo precio del ítem
            // nuevo (coeficiente 1). precioReferenciaNuevo se guarda aparte para poder mostrar
            // "precio de un ítem nuevo" vs "precio de la reparación" en la revisión.
            precioUnitario: it.precio_unitario_ajustado ?? it.precio_unitario_total ?? null,
            precioReferenciaNuevo: it.precio_unitario_total ?? null,
            coeficienteAjuste: Number.isFinite(parseFloat(it.coeficiente_ajuste)) ? parseFloat(it.coeficiente_ajuste) : 1,
            confianzaMedicion: it.confianza_medicion || 'media',
          }
        }),
      ])

      const especialistaTexto = resultado.especialista || especialistaActual.titulo
      const mensajesTexto = [`**${especialistaTexto}**: ${resultado.mensaje_auditoria || 'Análisis completado.'}`]
      if (resultado.alertas_omision) mensajesTexto.push(`⚠️ **Control de omisiones**: ${resultado.alertas_omision}`)

      const mensajesGuardados = []
      for (const texto of mensajesTexto) {
        const row = await dbWrite('POST', 'relevamiento_mensajes', { relevamiento_id: relevamiento.id, sector: sectorActivo, emisor: 'ia', mensaje: texto }, null, true)
        if (row) mensajesGuardados.push({ id: row.id, sector: row.sector, emisor: row.emisor, mensaje: row.mensaje })
      }
      setMensajes((prev) => [...prev, ...mensajesGuardados])
      // Se limpia el relato y las fotos de este sector ya procesado — si no, al dictar/cargar algo
      // NUEVO y volver a apretar "Procesar IA" se reenviaba el relato viejo junto con el nuevo y la
      // IA volvía a proponer los mismos ítems ya propuestos, duplicando el cómputo.
      setRelato('')
      setFotosSector([])
      if (window._toast) window._toast(`${especialistaTexto} propone ${itemsIA.length} ítem(s) — revisá la medición antes de confirmar`, 'ok')
    } catch (err) {
      console.error(err)
      window._toast?.('No se pudo analizar con IA: ' + err.message, 'error')
    } finally {
      setProcesando(false)
    }
  }

  // Edita en pantalla la cantidad de un ítem TODAVÍA no confirmado (propuesta de la IA).
  const handleCambiarCantidadPropuesta = (idx, nuevaCant) => {
    setItemsPropuestos((prev) => prev.map((it, i) => (i === idx ? { ...it, cant: nuevaCant } : it)))
  }
  // Edita el % del precio del ítem nuevo que se va a cobrar por la reparación (solo aplica a
  // ítems de restauración con un precio de referencia de catálogo). Recalcula precioUnitario en
  // base al nuevo %, redondeado a 2 decimales. Si el % ingresado no es válido, no toca nada.
  const handleCambiarCoeficientePropuesta = (idx, valorPorcentaje) => {
    const pct = parseFloat(valorPorcentaje)
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return
    setItemsPropuestos((prev) => prev.map((it, i) => {
      if (i !== idx) return it
      const coef = pct / 100
      const nuevoPrecio = it.precioReferenciaNuevo != null ? +(it.precioReferenciaNuevo * coef).toFixed(2) : it.precioUnitario
      return { ...it, coeficienteAjuste: coef, precioUnitario: nuevoPrecio }
    }))
  }
  const handleQuitarPropuesto = (idx) => {
    setItemsPropuestos((prev) => prev.filter((_, i) => i !== idx))
  }
  // Guarda de verdad en relevamiento_items los ítems que quedaron en la lista de propuestas (los
  // que el técnico haya sacado con "✕" ya no están acá) con la cantidad que haya confirmado o
  // corregido — recién acá se persiste, nunca antes.
  const handleConfirmarPropuestos = async () => {
    const aGuardar = itemsPropuestos
    if (aGuardar.length === 0) {
      window._toast?.('No queda ningún ítem propuesto para guardar.', 'error')
      return
    }
    setConfirmandoPropuestos(true)
    try {
      const filas = await Promise.all(aGuardar.map((it) => _persistirItem(relevamiento.id, {
        rubro: it.rubro,
        item: it.item,
        descripcionDetallada: it.descripcionDetallada,
        un: it.un,
        cant: it.cant,
        sector: sectorActivo,
        riesgo: it.riesgo,
        esRestauracion: it.esRestauracion,
        codigoItem: it.codigoItem,
        fotoUrl: it.fotoUrl,
        precioUnitario: it.precioUnitario,
        coeficienteAjuste: it.coeficienteAjuste,
      })))
      const filasOk = filas.filter(Boolean)
      setRubrosAcumulados((prev) => [...prev, ...filasOk.map(_filaDbAItem)])
      setItemsPropuestos([])
      if (window._toast) window._toast(`${filasOk.length} ítem(s) confirmados y guardados`, 'ok')
    } finally {
      setConfirmandoPropuestos(false)
    }
  }
  const handleDescartarPropuestos = () => {
    if (!window.confirm('¿Descartar todos los ítems propuestos por la IA para este sector? No se va a guardar nada.')) return
    setItemsPropuestos([])
  }

  // Pregunta real al especialista sobre el cómputo YA generado de este sector (ej. "¿por qué
  // 12 metros de cable?", "¿de dónde sale que la instalación de 12 spots vale $1.100.000?").
  // Antes esto era una simulación: contestaba un texto fijo y solo reaccionaba a las palabras
  // "amurar"/"reparar"/"fijar" (modificando un ítem hardcodeado de lavatorio) — nunca respondía
  // nada de verdad. Ahora se le mandan a la IA los ítems reales del sector (propuestos sin
  // confirmar + ya guardados) para que explique en base a esos números, sin inventar ninguno
  // nuevo. La IA solo explica — no modifica ítems por chat; para corregir un número, el técnico
  // lo edita directamente en la cantidad/% de la pantalla de revisión o del ítem guardado.
  const handleEnviarConsultaChat = async (e) => {
    e.preventDefault()
    if (!chatTexto.trim() || consultandoChat) return
    const txt = chatTexto.trim()
    setChatTexto('')

    const filaTecnico = await dbWrite('POST', 'relevamiento_mensajes', { relevamiento_id: relevamiento.id, sector: sectorActivo, emisor: 'tecnico', mensaje: txt }, null, true).catch((err) => { console.error(err); return null })
    const mensajeTecnico = filaTecnico
      ? { id: filaTecnico.id, sector: filaTecnico.sector, emisor: filaTecnico.emisor, mensaje: filaTecnico.mensaje }
      : { id: `local-${Math.random().toString(36).slice(2)}`, sector: sectorActivo, emisor: 'tecnico', mensaje: txt }
    setMensajes((prev) => [...prev, mensajeTecnico])

    setConsultandoChat(true)
    try {
      const aContexto = (it) => ({
        codigo_item: it.codigoItem,
        rubro: it.rubro,
        descripcion_item: it.item,
        unidad: it.un,
        cantidad: it.cant,
        precio_unitario: it.precioUnitario,
        coeficiente_ajuste: it.coeficienteAjuste,
        justificacion: it.descripcionDetallada,
        // Cuántas fotos quedaron asociadas a este ítem — así el técnico puede preguntarle a la
        // IA "¿por qué le pusiste/no le pusiste foto a este ítem?" y tiene con qué responder.
        fotos: it.fotoUrl ? it.fotoUrl.split(',').filter(Boolean).length : 0,
      })
      const itemsContexto = [
        ...itemsPropuestos.map(aContexto),
        ...rubrosAcumulados.filter((i) => i.sector === sectorActivo).map(aContexto),
      ]
      const historialParaIA = [...mensajesDelSector, mensajeTecnico]
      const rtaTexto = await consultarSectorConIA({ sector: sectorActivo, pregunta: txt, itemsContexto, historial: historialParaIA })
      const rta = `**${especialistaActual.titulo}**: ${rtaTexto}`
      const filaIa = await dbWrite('POST', 'relevamiento_mensajes', { relevamiento_id: relevamiento.id, sector: sectorActivo, emisor: 'ia', mensaje: rta }, null, true).catch((err) => { console.error(err); return null })
      if (filaIa) setMensajes((prev) => [...prev, { id: filaIa.id, sector: filaIa.sector, emisor: filaIa.emisor, mensaje: filaIa.mensaje }])
    } catch (err) {
      console.error(err)
      window._toast?.('No se pudo consultar a la IA: ' + err.message, 'error')
    } finally {
      setConsultandoChat(false)
    }
  }

  // Los mensajes ahora son el historial de auditoría persistido en relevamiento_mensajes — ya no
  // tiene sentido "borrarlos" (se perdería la trazabilidad). "Limpiar" ahora solo oculta la vista.
  const handleLimpiarChat = () => {
    setHistorialOculto((v) => !v)
  }

  const handleCerrarSector = () => {
    if (itemsPropuestos.length > 0 && !window.confirm('Tenés ítems propuestos por la IA sin confirmar en este sector — se van a perder si lo cerrás. ¿Continuar?')) return
    setSectores((prev) =>
      prev.map((s) => (s.nombre === sectorActivo ? { ...s, cerrado: true } : s))
    )
    setItemsPropuestos([])
    if (window._toast) window._toast(`Sector "${sectorActivo}" cerrado con éxito`, 'ok')
  }

  // Actualiza en pantalla en cada tecla (responsivo) y recién guarda en el servidor al salir del
  // campo (onBlur) — evita un PATCH por cada tecla tipeada.
  const handleCambiarCantidadLocal = (id, nuevaCant) => {
    setRubrosAcumulados((prev) => prev.map((i) => (i.id === id ? { ...i, cant: nuevaCant } : i)))
  }
  const handleGuardarCantidad = async (id, nuevaCant) => {
    const cant = parseFloat(nuevaCant) || 0
    const itemActual = rubrosAcumulados.find((i) => i.id === id)
    const subtotal = itemActual?.precioUnitario != null ? +(cant * itemActual.precioUnitario).toFixed(2) : null
    setRubrosAcumulados((prev) => prev.map((i) => (i.id === id ? { ...i, cant, subtotal } : i)))
    try {
      await dbWrite('PATCH', 'relevamiento_items', { cantidad: cant, computo_total: cant, subtotal }, `id=eq.${id}`)
    } catch (err) {
      console.error(err)
      window._toast?.('No se pudo guardar la cantidad: ' + err.message, 'error')
    }
  }

  const handleEliminarItem = async (id) => {
    setRubrosAcumulados((prev) => prev.filter((i) => i.id !== id))
    try {
      await dbWrite('DELETE', 'relevamiento_items', null, `id=eq.${id}`)
    } catch (err) {
      console.error(err)
      window._toast?.('No se pudo eliminar en el servidor: ' + err.message, 'error')
      cargarDatos()
    }
  }

  const cerrarModalManual = () => {
    setModalNuevoManual(false)
    setRubroFiltro('')
    setItemManual({ rubro: 'INSTALACION SANITARIA', item: '', descripcionDetallada: '', un: 'unid', cant: 1, esRestauracion: false, riesgo: 'urgente', codigoItem: null, precioUnitario: null })
  }

  const handleGuardarItemManual = async (e) => {
    e.preventDefault()
    if (!itemManual.item.trim()) {
      window._toast?.('Elegí un rubro y un ítem del catálogo, o completá el ítem libre.', 'error')
      return
    }

    const nuevo = {
      rubro: itemManual.rubro,
      item: itemManual.item.trim(),
      descripcionDetallada: itemManual.descripcionDetallada.trim() || 'Carga manual por inspección técnica',
      un: itemManual.un,
      cant: parseFloat(itemManual.cant) || 1,
      esRestauracion: itemManual.esRestauracion,
      sector: sectorActivo || 'General',
      riesgo: itemManual.riesgo || 'funcional',
      // Si se eligió un ítem real del catálogo (ver handleElegirItemCatalogo) viene el código y
      // precio reales; si es carga libre, queda en null — nunca se inventa un precio.
      codigoItem: itemManual.codigoItem,
      precioUnitario: itemManual.precioUnitario,
    }

    const row = await _persistirItem(relevamiento.id, nuevo)
    if (!row) return
    setRubrosAcumulados((prev) => [...prev, _filaDbAItem(row)])
    cerrarModalManual()
    if (window._toast) window._toast('Ítem cargado manualmente con éxito', 'ok')
  }

  // Genera el Informe Técnico (Word) con los ítems y mensajes de auditoría ya persistidos de
  // TODO el relevamiento (todos los sectores, no solo el activo) — ver exportRelevamiento.js.
  const handleGenerarInforme = async () => {
    if (rubrosAcumulados.length === 0) {
      window._toast?.('Cargá al menos un ítem antes de generar el informe.', 'error')
      return
    }
    setGenerandoInforme(true)
    try {
      await generarInformeTecnicoRelevamiento(relevamiento, rubrosAcumulados, mensajes)
      window._toast?.('Informe Técnico generado', 'ok')
    } catch (err) {
      console.error(err)
      window._toast?.('No se pudo generar el informe: ' + err.message, 'error')
    } finally {
      setGenerandoInforme(false)
    }
  }

  // Genera el Presupuesto (Excel, 2 hojas: PRESUPUESTO por rubro + Anexo por Sector) — los ítems
  // sin precio de catálogo quedan marcados "A cotizar" en vez de inventarles un precio.
  const handleExportarPresupuesto = () => {
    if (rubrosAcumulados.length === 0) {
      window._toast?.('Cargá al menos un ítem antes de exportar el presupuesto.', 'error')
      return
    }
    setGenerandoPresupuesto(true)
    try {
      const { itemsSinPrecioCount } = exportarPresupuestoRelevamiento(relevamiento, rubrosAcumulados)
      if (itemsSinPrecioCount > 0) {
        window._toast?.(`Presupuesto exportado — ${itemsSinPrecioCount} ítem(s) sin precio de catálogo quedaron marcados "A cotizar".`, 'info')
      } else {
        window._toast?.('Presupuesto exportado', 'ok')
      }
    } catch (err) {
      console.error(err)
      window._toast?.('No se pudo exportar el presupuesto: ' + err.message, 'error')
    } finally {
      setGenerandoPresupuesto(false)
    }
  }

  return (
    <div style={{ backgroundColor: C.bg, minHeight: '100vh', padding: '16px', color: C.text, fontFamily: "'Outfit', sans-serif" }}>
      {/* Header */}
      <div style={{ backgroundColor: C.surface, borderRadius: '12px', padding: '16px', border: `1px solid ${C.border}`, marginBottom: '16px' }}>
        <button onClick={onVolver} style={{ backgroundColor: 'transparent', border: 'none', cursor: 'pointer', fontSize: '14px', color: C.purple, fontWeight: 'bold', marginBottom: '8px' }}>
          ← Volver a Relevamientos
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <span style={{ backgroundColor: C.purpleDim, color: C.purple, padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' }}>
              {relevamiento.organismo}
            </span>
            <h2 style={{ margin: '6px 0 2px 0', fontSize: '20px' }}>{relevamiento.titulo_obra}</h2>
            <p style={{ margin: 0, color: C.textMuted, fontSize: '14px' }}>🏫 {relevamiento.escuela_lugar} — {relevamiento.localidad}</p>
          </div>
          {relevamiento.direccion_gmaps && (
            <a href={relevamiento.direccion_gmaps} target="_blank" rel="noreferrer" style={{ backgroundColor: C.greenDim, color: C.green, padding: '6px 12px', borderRadius: '6px', fontSize: '12px', textDecoration: 'none', fontWeight: 'bold' }}>
              📍 Ver en Google Maps
            </a>
          )}
        </div>
      </div>

      {cargandoDatos && (
        <div style={{ textAlign: 'center', padding: '10px', color: C.textMuted, fontSize: '12px' }}>Cargando sectores, ítems y mensajes guardados de este relevamiento...</div>
      )}

      {/* Creación y Selección de Sectores Dinámicos */}
      <div style={{ backgroundColor: C.surface, padding: '14px 16px', borderRadius: '12px', border: `1px solid ${C.border}`, marginBottom: '16px' }}>
        <div style={{ fontSize: '12px', fontWeight: 'bold', color: C.textMuted, marginBottom: '8px', textTransform: 'uppercase' }}>
          Sectores / Ambientes de la Escuela:
        </div>

        {sectores.length > 0 && (
          <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '8px', marginBottom: '10px' }}>
            {sectores.map((s) => (
              <div
                key={s.nombre}
                onClick={() => {
                  if (itemsPropuestos.length > 0 && !window.confirm('Tenés ítems propuestos por la IA sin confirmar en el sector actual — se van a perder si cambiás de sector. ¿Continuar?')) return
                  setSectorActivo(s.nombre)
                  setFotosSector([])
                  setRelato('')
                  setItemsPropuestos([])
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '6px 12px',
                  borderRadius: '20px',
                  border: `1px solid ${sectorActivo === s.nombre ? C.purple : C.border}`,
                  backgroundColor: sectorActivo === s.nombre ? C.purpleDim : C.bg,
                  color: sectorActivo === s.nombre ? C.purple : C.text,
                  fontWeight: 'bold',
                  fontSize: '13px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <span>{s.cerrado ? '✅' : '📌'} {s.nombre}</span>
                <button
                  onClick={(e) => handleEliminarSector(s.nombre, e)}
                  style={{ backgroundColor: 'transparent', border: 'none', color: '#D0021B', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', padding: 0 }}
                  title="Eliminar sector"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleAgregarSector} style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            placeholder="Escribí el nombre del ambiente (ej: Sanitarios Varones, Techos, Aula 1, Cauce EBY)..."
            value={nuevoSectorNombre}
            onChange={(e) => setNuevoSectorNombre(e.target.value)}
            style={{ flex: 1, padding: '8px 12px', borderRadius: '6px', border: `1px solid ${C.border}`, fontSize: '13px' }}
          />
          <button type="submit" style={{ backgroundColor: C.purple, color: '#FFF', border: 'none', padding: '8px 16px', borderRadius: '6px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer' }}>
            + Crear Sector
          </button>
        </form>
      </div>

      {/* Carga del Sector Activo (Fotos Múltiples + Relato) */}
      {sectorActivo ? (
        !sectorActualObj?.cerrado ? (
          <div style={{ backgroundColor: C.surface, padding: '16px', borderRadius: '12px', border: `1px solid ${C.border}`, marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ margin: 0, fontSize: '16px', color: C.purple }}>
                🔍 Relevando: <span style={{ textDecoration: 'underline' }}>{sectorActivo}</span>
              </h3>
              <button
                onClick={handleCerrarSector}
                style={{ backgroundColor: '#1A6B3C', color: '#FFF', border: 'none', padding: '8px 12px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px' }}
              >
                🔒 Cerrar Sector
              </button>
            </div>

            {/* Fotos Múltiples con Indicación de Paneo General */}
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '12px', fontWeight: 'bold', color: C.purple, marginBottom: '4px' }}>
                📸 Paso 1: Sacá 1 o 2 fotos de Paneo General + fotos de detalles:
              </div>

              {fotosSector.length > 0 && (
                <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', marginBottom: '10px', paddingBottom: '6px' }}>
                  {fotosSector.map((f, i) => (
                    <div key={f.id} style={{ position: 'relative', flexShrink: 0 }}>
                      <img src={f.url} alt="" style={{ width: '85px', height: '85px', objectFit: 'cover', borderRadius: '8px', border: `1px solid ${C.border}`, opacity: f.subiendo ? 0.55 : 1 }} />
                      <span style={{ position: 'absolute', bottom: '2px', left: '2px', backgroundColor: 'rgba(0,0,0,0.6)', color: '#FFF', fontSize: '9px', padding: '1px 4px', borderRadius: '4px' }}>
                        {f.subiendo ? 'Subiendo...' : (i === 0 ? 'Paneo General' : `Detalle ${i}`)}
                      </span>
                      <button
                        onClick={() => handleEliminarFoto(f.id)}
                        style={{ position: 'absolute', top: '-6px', right: '-6px', backgroundColor: '#D0021B', color: '#FFF', border: 'none', borderRadius: '50%', width: '18px', height: '18px', cursor: 'pointer', fontSize: '10px', fontWeight: 'bold' }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <label style={{ backgroundColor: C.purpleDim, color: C.purple, border: `1px solid ${C.purple}`, padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', display: 'inline-block' }}>
                📷 Adjuntar Fotos (Paneo + Detalles)
                <input type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={handleCargarFotos} />
              </label>
            </div>

            {/* Relato con Dictado por Voz Limpio */}
            <div style={{ marginBottom: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold' }}>
                  2. Contale a la IA lo que ves en {sectorActivo}:
                </label>
                <button
                  type="button"
                  onClick={alternarDictadoVoz}
                  style={{
                    backgroundColor: grabandoAudio ? '#D0021B' : C.purpleDim,
                    color: grabandoAudio ? '#FFF' : C.purple,
                    border: `1px solid ${grabandoAudio ? '#D0021B' : C.purple}`,
                    borderRadius: '6px',
                    padding: '4px 10px',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                  }}
                >
                  {grabandoAudio ? '🎙️ Escuchando... (parar)' : '🎙️ Dictar por Voz'}
                </button>
              </div>
              <textarea
                rows={3}
                value={relato}
                onChange={(e) => setRelato(e.target.value)}
                placeholder={`Contanos qué patologías o trabajos ves en ${sectorActivo}...`}
                style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${C.border}`, boxSizing: 'border-box', fontFamily: 'inherit', fontSize: '13px' }}
              />
            </div>

            <button
              onClick={handleProcesarIA}
              disabled={procesando}
              style={{ width: '100%', backgroundColor: C.purple, color: '#FFF', border: 'none', padding: '12px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px' }}
            >
              {procesando ? 'Procesando Fotos y Relato con IA...' : `✨ Procesar e Equiparar Cifras para ${sectorActivo}`}
            </button>

            {/* Ítems propuestos por la IA — TODAVÍA no guardados. El técnico revisa/corrige la
                cantidad de cada uno (medición estimada) antes de confirmar — así una estimación
                mal calculada por la IA no queda guardada sin que nadie la mire primero. */}
            {itemsPropuestos.length > 0 && (
              <div style={{ marginTop: '16px', backgroundColor: '#FFF8ED', border: `1px solid #E8C070`, borderRadius: '10px', padding: '14px' }}>
                <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#8A5200', marginBottom: '4px' }}>
                  📐 La IA propone {itemsPropuestos.length} ítem(s) — revisá la medición antes de confirmar
                </div>
                <p style={{ margin: '0 0 12px 0', fontSize: '12px', color: C.textMuted }}>
                  Ninguno de estos ítems está guardado todavía. Corregí la cantidad si hace falta, sacá los que no correspondan, y confirmá para recién ahí guardarlos.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                  {itemsPropuestos.map((it, idx) => {
                    const badgeConfianza = {
                      alta: { texto: '✓ Medición confiable', bg: C.greenDim, color: C.green },
                      media: { texto: '~ Estimación aproximada', bg: '#FFF3D6', color: '#8A5200' },
                      baja: { texto: '⚠ Sin referencia de escala clara', bg: '#FFEAEA', color: '#D0021B' },
                    }[it.confianzaMedicion] || { texto: '~ Estimación aproximada', bg: '#FFF3D6', color: '#8A5200' }
                    return (
                      <div key={idx} style={{ backgroundColor: C.surface, padding: '10px 12px', borderRadius: '8px', border: `1px solid ${C.border}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: '180px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '2px' }}>
                              <span style={{ fontSize: '10px', color: C.purple, fontWeight: 'bold', textTransform: 'uppercase' }}>
                                {it.codigoItem ? `#${it.codigoItem} — ` : ''}{it.rubro}
                              </span>
                              <span style={{ backgroundColor: badgeConfianza.bg, color: badgeConfianza.color, padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 'bold' }}>
                                {badgeConfianza.texto}
                              </span>
                            </div>
                            <span style={{ fontSize: '13px', fontWeight: 'bold', color: C.text, display: 'block' }}>{it.item}</span>
                            {it.descripcionDetallada && (
                              <span style={{ fontSize: '12px', color: C.textMuted, fontStyle: 'italic', display: 'block', marginTop: '2px' }}>
                                {it.descripcionDetallada}
                              </span>
                            )}
                          </div>
                          <button
                            onClick={() => handleQuitarPropuesto(idx)}
                            title="Quitar esta propuesta"
                            style={{ backgroundColor: 'transparent', border: 'none', color: '#D0021B', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold' }}
                          >
                            ✕
                          </button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                          <span style={{ fontSize: '11px', color: C.textMuted }}>La IA estimó:</span>
                          <input
                            type="number"
                            value={it.cant}
                            onChange={(e) => handleCambiarCantidadPropuesta(idx, e.target.value)}
                            style={{ width: '80px', padding: '5px', borderRadius: '6px', border: `1px solid ${C.purple}`, fontWeight: 'bold', textAlign: 'center' }}
                          />
                          <span style={{ fontSize: '12px', fontWeight: 'bold', color: C.purple }}>{it.un}</span>
                          {it.precioUnitario != null && (
                            <span style={{ fontSize: '12px', color: C.textMuted, marginLeft: 'auto' }}>
                              ${fmt(it.precioUnitario)}/{it.un} → ${fmt((parseFloat(it.cant) || 0) * it.precioUnitario)}
                            </span>
                          )}
                        </div>
                        {it.esRestauracion && it.precioReferenciaNuevo != null && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', paddingTop: '8px', borderTop: `1px dashed ${C.border}`, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '11px', color: '#8A5200', fontWeight: 'bold' }}>🔧 Reparación (no reemplazo):</span>
                            <span style={{ fontSize: '11px', color: C.textMuted }}>
                              Ítem nuevo equivalente: ${fmt(it.precioReferenciaNuevo)}/{it.un}
                            </span>
                            <span style={{ fontSize: '11px', color: C.textMuted }}>×</span>
                            <input
                              type="number"
                              min="1"
                              max="100"
                              value={Math.round((it.coeficienteAjuste ?? 1) * 100)}
                              onChange={(e) => handleCambiarCoeficientePropuesta(idx, e.target.value)}
                              style={{ width: '56px', padding: '5px', borderRadius: '6px', border: '1px solid #8A5200', fontWeight: 'bold', textAlign: 'center' }}
                            />
                            <span style={{ fontSize: '11px', color: C.textMuted }}>% =</span>
                            <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#8A5200' }}>
                              ${fmt(it.precioUnitario)}/{it.un}
                            </span>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={handleDescartarPropuestos}
                    style={{ backgroundColor: 'transparent', border: `1px solid ${C.border}`, padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', color: C.textMuted, fontSize: '13px' }}
                  >
                    Descartar todos
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmarPropuestos}
                    disabled={confirmandoPropuestos}
                    style={{ backgroundColor: C.green, color: '#FFF', border: 'none', padding: '8px 16px', borderRadius: '6px', fontWeight: 'bold', cursor: confirmandoPropuestos ? 'default' : 'pointer', fontSize: '13px', opacity: confirmandoPropuestos ? 0.6 : 1 }}
                  >
                    {confirmandoPropuestos ? 'Guardando...' : `✓ Confirmar y guardar ${itemsPropuestos.length} ítem(s)`}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ backgroundColor: C.greenDim, border: `1px solid ${C.green}`, padding: '14px', borderRadius: '12px', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ fontWeight: 'bold', color: C.green }}>✅ Sector "{sectorActivo}" Cerrado</span>
              <p style={{ margin: 0, fontSize: '12px', color: C.textMuted }}>Las fotos y el relato quedan guardados para el informe final.</p>
            </div>
            <button
              onClick={() =>
                setSectores((prev) =>
                  prev.map((s) => (s.nombre === sectorActivo ? { ...s, cerrado: false } : s))
                )
              }
              style={{ backgroundColor: C.surface, color: C.text, border: `1px solid ${C.border}`, padding: '6px 10px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer' }}
            >
              Reabrir
            </button>
          </div>
        )
      ) : (
        <div style={{ backgroundColor: C.surface, padding: '20px', borderRadius: '12px', border: `1px solid ${C.border}`, marginBottom: '16px', textAlign: 'center', color: C.textMuted }}>
          Escribí el nombre del ambiente arriba para empezar a relevar.
        </div>
      )}

      {/* Auditoría / Consultas con Agente Especialista */}
      {mensajesDelSector.length > 0 && (
        <div style={{ backgroundColor: C.surface, padding: '16px', borderRadius: '12px', border: `1px solid ${C.purple}`, marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <h4 style={{ margin: 0, fontSize: '14px', color: C.purple }}>{especialistaActual.titulo} (Análisis Cifras)</h4>
            <button
              onClick={handleLimpiarChat}
              style={{ backgroundColor: 'transparent', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '4px 8px', fontSize: '11px', cursor: 'pointer', color: C.textMuted }}
              title="El historial queda guardado igual — esto solo lo oculta de la vista"
            >
              {historialOculto ? `👁️ Mostrar (${mensajesDelSector.length})` : '🧹 Ocultar'}
            </button>
          </div>

          {!historialOculto && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
              {mensajesDelSector.map((msg) => (
                <div key={msg.id} style={{ backgroundColor: C.bg, padding: '10px 12px', borderRadius: '8px', fontSize: '12px', border: `1px solid ${C.border}` }}>
                  {msg.emisor === 'ia' ? '🤖 ' : '👤 **Técnico**: '}{msg.mensaje}
                </div>
              ))}
            </div>
          )}

          <p style={{ margin: '0 0 8px 0', fontSize: '11px', color: C.textMuted }}>
            Preguntale al especialista sobre este cómputo — ej. "¿por qué 12 metros de cable?" o "¿de dónde sale el precio de los spots?".
          </p>
          <form onSubmit={handleEnviarConsultaChat} style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              placeholder="Preguntale al especialista sobre un ítem..."
              value={chatTexto}
              onChange={(e) => setChatTexto(e.target.value)}
              disabled={consultandoChat}
              style={{ flex: 1, padding: '8px', borderRadius: '6px', border: `1px solid ${C.border}`, fontSize: '12px' }}
            />
            <button
              type="button"
              onClick={alternarDictadoChat}
              disabled={consultandoChat}
              style={{
                backgroundColor: grabandoAudioChat ? '#D0021B' : C.purpleDim,
                color: grabandoAudioChat ? '#FFF' : C.purple,
                border: `1px solid ${grabandoAudioChat ? '#D0021B' : C.purple}`,
                borderRadius: '6px',
                padding: '8px 10px',
                fontSize: '12px',
                fontWeight: 'bold',
                cursor: 'pointer',
              }}
              title="Dictar pregunta por voz"
            >
              {grabandoAudioChat ? '🎙️...' : '🎙️'}
            </button>
            <button
              type="submit"
              disabled={consultandoChat}
              style={{ backgroundColor: C.purple, color: '#FFF', border: 'none', padding: '8px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold', cursor: consultandoChat ? 'default' : 'pointer', opacity: consultandoChat ? 0.6 : 1 }}
            >
              {consultandoChat ? 'Consultando...' : 'Preguntar'}
            </button>
          </form>
        </div>
      )}

      {/* Cómputo e Ítems del Sector */}
      {sectorActivo && (() => {
        const itemsDelSector = rubrosAcumulados.filter((i) => i.sector === sectorActivo)
        const totalSectorHeader = itemsDelSector.filter((i) => i.subtotal != null).reduce((acc, i) => acc + i.subtotal, 0)
        const sectorCerrado = !!sectorActualObj?.cerrado
        const compacto = sectorCerrado && !verDetalleCerrado
        return (
        <div style={{ backgroundColor: C.surface, padding: '16px', borderRadius: '12px', border: `1px solid ${C.border}`, marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: compacto ? 0 : '12px', flexWrap: 'wrap', gap: '8px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', color: C.purple }}>
              📋 Ítems de Cómputo para: {sectorActivo}
            </h3>
            {!sectorCerrado && (
              <button
                onClick={() => setModalNuevoManual(true)}
                style={{ backgroundColor: C.purpleDim, color: C.purple, border: `1px solid ${C.purple}`, padding: '6px 12px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px' }}
              >
                + Agregar Ítem Manual
              </button>
            )}
          </div>

          {itemsDelSector.length === 0 ? (
            <p style={{ color: C.textMuted, fontSize: '13px', margin: '12px 0 0 0' }}>
              No hay ítems en este sector aún. Procesá fotos y relato arriba o agregá manualmente.
            </p>
          ) : compacto ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px', paddingTop: '10px', borderTop: `1px solid ${C.border}` }}>
              <span style={{ fontSize: '13px', color: C.textMuted }}>
                {itemsDelSector.length} ítem{itemsDelSector.length !== 1 ? 's' : ''}{totalSectorHeader > 0 ? ` — $${fmt(totalSectorHeader)}` : ''}
              </span>
              <button
                onClick={() => setVerDetalleCerrado(true)}
                style={{ backgroundColor: 'transparent', border: `1px solid ${C.border}`, color: C.purple, padding: '5px 12px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px' }}
              >
                Ver detalle ▾
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
              {sectorCerrado && (
                <button
                  onClick={() => setVerDetalleCerrado(false)}
                  style={{ alignSelf: 'flex-end', backgroundColor: 'transparent', border: 'none', color: C.purple, cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', padding: 0, marginBottom: '2px' }}
                >
                  Ocultar detalle ▴
                </button>
              )}
              {itemsDelSector
                .map((item) => (
                  <div key={item.id} style={{ backgroundColor: C.bg, padding: '10px 14px', borderRadius: '8px', border: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <div style={{ flex: 1, minWidth: '180px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                        <span style={{ fontSize: '10px', color: C.purple, fontWeight: 'bold', textTransform: 'uppercase' }}>
                          {item.codigoItem ? `#${item.codigoItem} — ` : ''}{item.rubro}
                          {item.esRestauracion && ` • RESTAURACIÓN/RECUPERO${item.coeficienteAjuste != null && item.coeficienteAjuste < 1 ? ` (~${Math.round(item.coeficienteAjuste * 100)}% de un ítem nuevo)` : ''}`}
                        </span>
                        {item.riesgo === 'urgente' && (
                          <span style={{ backgroundColor: '#FFEAEA', color: '#D0021B', padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 'bold' }}>
                            🔴 Riesgo Áulico Urgente
                          </span>
                        )}
                        {item.riesgo === 'funcional' && (
                          <span style={{ backgroundColor: '#FFF8ED', color: '#8A5200', padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 'bold' }}>
                            🟡 Deterioro Funcional
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: '13px', fontWeight: 'bold', color: C.text, display: 'block' }}>{item.item}</span>
                      {item.descripcionDetallada && (
                        <span style={{ fontSize: '12px', color: C.textMuted, fontStyle: 'italic', display: 'block', marginTop: '2px' }}>
                          "{item.descripcionDetallada}"
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="number"
                        value={item.cant}
                        onChange={(e) => handleCambiarCantidadLocal(item.id, e.target.value)}
                        onBlur={(e) => handleGuardarCantidad(item.id, e.target.value)}
                        style={{ width: '60px', padding: '4px', borderRadius: '6px', border: `1px solid ${C.border}`, fontWeight: 'bold', textAlign: 'center' }}
                      />
                      <span style={{ fontSize: '12px', fontWeight: 'bold', color: C.purple }}>{item.un}</span>
                      {item.subtotal != null && (
                        <span style={{ fontSize: '12px', fontWeight: 'bold', color: C.green }}>${fmt(item.subtotal)}</span>
                      )}
                      <button
                        onClick={() => handleEliminarItem(item.id)}
                        style={{ backgroundColor: 'transparent', border: 'none', color: '#D0021B', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold' }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              {totalSectorHeader > 0 && (
                <div style={{ textAlign: 'right', fontSize: '13px', fontWeight: 'bold', color: C.text, padding: '4px 6px' }}>
                  Subtotal del sector (ítems con precio de catálogo): ${fmt(totalSectorHeader)}
                </div>
              )}
            </div>
          )}
        </div>
        )
      })()}

      {/* Modal Carga Manual */}
      {modalManual && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '16px' }}>
          <div style={{ backgroundColor: C.surface, borderRadius: '12px', width: '100%', maxWidth: '480px', padding: '20px' }}>
            <h3 style={{ margin: '0 0 14px 0', color: C.purple }}>Agregar Ítem Manualmente (Revista Cifras)</h3>
            <form onSubmit={handleGuardarItemManual}>
              <div style={{ marginBottom: '10px' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>1. Rubro — elegí para ver SOLO los ítems de Revista Cifras de ese rubro</label>
                <select
                  value={rubroFiltro}
                  onChange={(e) => handleElegirRubroFiltro(e.target.value)}
                  disabled={catalogoCargando || (catalogoError && catalogoCifras.length === 0)}
                  style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${C.border}` }}
                >
                  <option value="">
                    {catalogoCifras.length ? '— Elegí un rubro —' : catalogoError ? 'No se pudo cargar el catálogo' : 'Cargando catálogo...'}
                  </option>
                  {rubrosCatalogo.map((r) => (
                    <option key={r} value={r}>{r} ({catalogoCifras.filter((c) => c.rubro === r).length})</option>
                  ))}
                  <option value="__libre__">— No sé el rubro / no está en Cifras —</option>
                </select>
                {catalogoError && catalogoCifras.length === 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                    <span style={{ fontSize: '11px', color: '#D0021B' }}>No se pudo cargar el catálogo — revisá tu conexión.</span>
                    <button
                      type="button"
                      onClick={cargarCatalogoCifras}
                      style={{ backgroundColor: 'transparent', border: `1px solid ${C.purple}`, color: C.purple, borderRadius: '6px', padding: '3px 10px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
                    >
                      Reintentar
                    </button>
                  </div>
                )}
              </div>

              {rubroFiltro && rubroFiltro !== '__libre__' && (
                <div style={{ marginBottom: '10px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>
                    2. Ítem — {itemsDelRubroFiltro.length} ítems en "{rubroFiltro}", revisalos todos antes de decir que no está *
                  </label>
                  <select
                    value={itemManual.codigoItem || ''}
                    onChange={(e) => handleElegirItemCatalogo(e.target.value)}
                    style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${C.border}` }}
                  >
                    <option value="">— Elegí un ítem —</option>
                    {itemsDelRubroFiltro.map((c) => (
                      <option key={c.codigo_item} value={c.codigo_item}>{c.codigo_item} — {c.descripcion} ({c.unidad})</option>
                    ))}
                    <option value="__ninguno__">Ninguno de estos — no está en Revista Cifras, cargar texto libre</option>
                  </select>
                  {itemManual.codigoItem && (
                    <div style={{ fontSize: '11px', color: C.green, marginTop: 4 }}>✓ Ítem #{itemManual.codigoItem} del catálogo — precio: ${fmt(itemManual.precioUnitario)} por {itemManual.un}</div>
                  )}
                </div>
              )}

              {rubroFiltro === '__libre__' && (
                <>
                  <div style={{ marginBottom: '10px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Rubro (libre — no está en el catálogo)</label>
                    <input
                      type="text"
                      placeholder="Ej: CERRAJERÍA"
                      value={itemManual.rubro}
                      onChange={(e) => setItemManual({ ...itemManual, rubro: e.target.value })}
                      style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${C.border}`, boxSizing: 'border-box' }}
                    />
                  </div>
                  <div style={{ marginBottom: '10px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Ítem (texto libre — sin precio, no está catalogado) *</label>
                    <input
                      type="text"
                      required
                      placeholder="Describí el ítem"
                      value={itemManual.item}
                      onChange={(e) => setItemManual({ ...itemManual, item: e.target.value, codigoItem: null, precioUnitario: null })}
                      style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${C.border}`, boxSizing: 'border-box' }}
                    />
                    <div style={{ fontSize: '11px', color: C.textMuted, marginTop: 4 }}>Se guarda sin precio, porque no está en el catálogo.</div>
                  </div>
                </>
              )}

              <div style={{ marginBottom: '10px' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Descripción del Trabajo Relevado (Tu relato)</label>
                <input
                  type="text"
                  placeholder="Ej: Reamurado de bacha y reparación de pérdida de agua"
                  value={itemManual.descripcionDetallada}
                  onChange={(e) => setItemManual({ ...itemManual, descripcionDetallada: e.target.value })}
                  style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${C.border}`, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Unidad</label>
                  <select
                    value={itemManual.un}
                    onChange={(e) => setItemManual({ ...itemManual, un: e.target.value })}
                    style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${C.border}` }}
                  >
                    <option value="unid">unid</option>
                    <option value="m2">m2</option>
                    <option value="ml">ml</option>
                    <option value="m3">m3</option>
                    <option value="gl">gl (global)</option>
                  </select>
                </div>

                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>Cantidad</label>
                  <input
                    type="number"
                    step="0.01"
                    value={itemManual.cant}
                    onChange={(e) => setItemManual({ ...itemManual, cant: e.target.value })}
                    style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${C.border}`, boxSizing: 'border-box' }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  type="button"
                  onClick={cerrarModalManual}
                  style={{ backgroundColor: 'transparent', border: `1px solid ${C.border}`, padding: '8px 14px', borderRadius: '6px', cursor: 'pointer' }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  style={{ backgroundColor: C.purple, color: '#FFF', border: 'none', padding: '8px 14px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  Guardar Ítem
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Botones Finales */}
      <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '20px' }}>
        <button
          onClick={handleGenerarInforme}
          disabled={generandoInforme}
          style={{ backgroundColor: C.surface, color: C.purple, border: `1px solid ${C.purple}`, padding: '10px 16px', borderRadius: '8px', fontWeight: 'bold', cursor: generandoInforme ? 'default' : 'pointer', opacity: generandoInforme ? 0.6 : 1 }}
        >
          {generandoInforme ? 'Generando informe...' : '📄 Generar Informe Técnico General (Word)'}
        </button>
        <button
          onClick={handleExportarPresupuesto}
          disabled={generandoPresupuesto}
          style={{ backgroundColor: C.green, color: '#FFF', border: 'none', padding: '10px 16px', borderRadius: '8px', fontWeight: 'bold', cursor: generandoPresupuesto ? 'default' : 'pointer', opacity: generandoPresupuesto ? 0.6 : 1 }}
        >
          {generandoPresupuesto ? 'Exportando...' : '📊 Exportar Presupuesto y Anexo por Sector'}
        </button>
      </div>
    </div>
  )
}