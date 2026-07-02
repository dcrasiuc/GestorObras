import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'
import CuentaCorriente from './CuentaCorriente'
import { C, CONCEPTOS, CONCEPTOS_GENERALES, CONCEPTO_LABELS, CONCEPTO_COLORS, CONCEPTO_ICONS, TIPOS_COMPROBANTE, SITUACIONES, MEDIOS_PAGO, RUBROS, IVA, SEATE_CUIT, SEATE_NOMBRE, CONDICIONES_PAGO } from './constants'
import { fmt, fmtK, hoy, getSituacion, getTipoLabel, dbWrite } from './utils'
import { exportarExcel } from './exportExcel'
import './toast'

// ── Imputación de gastos por obra (distribución multi-obra) ───
// Si el gasto tiene distribución, devuelve cada parte; si no, 100% a su obra principal.
function imputaciones(g) {
  if (g?.distribucion?.length > 0) return g.distribucion.map(d => ({ obra_id: d.obra_id, monto: parseFloat(d.monto) || 0 }))
  return [{ obra_id: g.obra_id, monto: parseFloat(g.monto) || 0 }]
}
// IVA crédito fiscal total del gasto (0 si no corresponde: solo Factura A a nombre de SEATE)
function waGastoLink(g) {
  const obra = g.distribucion?.length > 1 ? 'Varias obras' : (g.obras?.nombre ?? '—')
  const proveedor = g.proveedores?.nombre ?? 'Sin proveedor'
  const tipo = getTipoLabel(g.tipo_comprobante)
  const nro = g.nro_comprobante ? ' · Nro: ' + g.nro_comprobante : ''
  const header = g.pagado ? 'PAGADO — SEATE S.R.L.' : 'PAGO PENDIENTE — SEATE S.R.L.'
  let msg = header + '\n'
  msg += '• Obra: ' + obra + '\n'
  msg += '• Proveedor: ' + proveedor + '\n'
  msg += '• Monto: $' + fmt(g.monto) + '\n'
  msg += '• ' + tipo + nro + '\n'
  msg += '• Fecha: ' + g.fecha + '\n'
  if (g.descripcion) msg += '• ' + g.descripcion + '\n'
  if (!g.pagado) msg += 'Por favor coordinar el pago.'
  return 'https://wa.me/?text=' + encodeURIComponent(msg)
}

function ivaCreditoGasto(g) {
  if (!(g.tipo_comprobante === 'factura_a' && g.a_nombre_seate)) return 0
  return g.iva_monto > 0 ? Math.round(g.iva_monto) : Math.round((parseFloat(g.monto) || 0) * IVA / (1 + IVA))
}
// Crédito fiscal de la parte de un gasto imputada a una obra (proporcional al monto)
function ivaCreditoImputacion(g, montoImput) {
  const iva = ivaCreditoGasto(g), total = parseFloat(g.monto) || 0
  if (iva <= 0 || total <= 0) return 0
  return Math.round(iva * (montoImput / total))
}
// Imputación de un remito por obra (los remitos no tienen obra_id: solo su distribución)
function imputacionesRemito(r) {
  return (r.comprobante_obras || []).map(d => ({ obra_id: d.obra_id, monto: parseFloat(d.monto) || 0 }))
}
// Guarda la distribución por obras de un gasto en comprobante_obras (tipo='gasto').
// Solo guarda si hay 2+ obras; con 1 o ninguna, queda como gasto de una sola obra (obra_id).
async function guardarDistribGasto(gastoId, distribucion, total) {
  await dbWrite('DELETE', 'comprobante_obras', null, `referencia_id=eq.${gastoId}&tipo=eq.gasto`)
  const filas = (distribucion || []).filter(x => x.obra_id && (parseFloat(x.monto) || 0) > 0)
  if (filas.length >= 2) {
    await dbWrite('POST', 'comprobante_obras', filas.map(x => ({ tipo: 'gasto', referencia_id: gastoId, obra_id: x.obra_id, monto: parseFloat(x.monto) || 0, porcentaje: total > 0 ? Math.round((parseFloat(x.monto) || 0) / total * 100) : 0 })))
  }
}

// ── Hooks ────────────────────────────────────────────────────
function useListas() {
  const [clientes, setClientes] = useState([])
  const [proveedores, setProveedores] = useState([])
  const [bancos, setBancos] = useState([])
  const cargar = useCallback(async () => {
    const [resC, resP, resB] = await Promise.all([
      supabase.from('clientes').select('*').order('nombre'),
      supabase.from('proveedores').select('*').order('nombre'),
      supabase.from('bancos').select('*').order('nombre'),
    ])
    if (!resC.error) setClientes(resC.data)
    if (!resP.error) setProveedores(resP.data)
    if (!resB.error) setBancos(resB.data)
  }, [])
  useEffect(() => { cargar() }, [cargar])
  return { clientes, proveedores, bancos, recargarListas: cargar, setProveedores }
}

function useObras(usuarioId, esAdmin) {
  const [obras, setObras] = useState([])
  const [loading, setLoading] = useState(true)
  // showLoading=false → refresca en background sin blanquear la lista (post-save)
  const cargar = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    const failsafe = showLoading ? setTimeout(() => setLoading(false), 12000) : null
    try {
      if (esAdmin) {
        const { data, error } = await supabase.from('obras_resumen').select('*').order('nombre')
        if (error) console.error('useObras admin error:', error)
        else setObras(data ?? [])
      } else {
        const { data: asignadas } = await supabase
          .from('obra_usuarios')
          .select('obra_id')
          .eq('usuario_id', usuarioId)
        const ids = (asignadas ?? []).map(a => a.obra_id)
        if (ids.length === 0) { setObras([]); if (failsafe) clearTimeout(failsafe); if (showLoading) setLoading(false); return }
        const { data, error } = await supabase.from('obras_resumen').select('*').in('id', ids).order('nombre')
        if (error) console.error('useObras error:', error)
        else setObras(data ?? [])
      }
    } catch (e) {
      console.error('useObras exception:', e)
    }
    if (failsafe) clearTimeout(failsafe)
    if (showLoading) setLoading(false)
  }, [usuarioId, esAdmin])
  useEffect(() => { cargar() }, [cargar])
  // obrasIds: null = admin (sin restricción), array = IDs permitidos para operador
  // undefined mientras carga (para no filtrar con lista vacía prematuramente)
  const obrasIds = loading ? undefined : (esAdmin ? null : obras.map(o => o.id))
  return { obras, setObras, loading, recargar: cargar, obrasIds }
}

function useGastos(obrasIds) {
  const [gastos, setGastos] = useState([])
  const [loading, setLoading] = useState(true)
  // Usamos la clave serializada para que useCallback reaccione cuando cambian los IDs
  const idsClave = JSON.stringify(obrasIds)
  const cargar = useCallback(async (showLoading = true) => {
    const ids = idsClave === undefined ? undefined : JSON.parse(idsClave)
    if (ids === undefined) return
    if (showLoading) setLoading(true)
    const failsafe = showLoading ? setTimeout(() => setLoading(false), 12000) : null
    try {
      let q = supabase.from('gastos')
        .select('*, obras(nombre), proveedores(nombre, situacion_impositiva, telefono, cbu, alias_cbu, banco, titular_cuenta), pagos(id, medio_pago, monto, fecha_pago, banco_id, comprobante_url)')
        .order('fecha', { ascending: false })
      if (ids !== null) q = q.in('obra_id', ids)
      const { data, error } = await q
      if (error) { console.error('useGastos error:', error) }
      else {
        let lista = data ?? []
        // Distribución por obras (comprobante_obras es polimórfica, sin FK directo → se trae aparte)
        if (lista.length > 0) {
          const gids = lista.map(g => g.id)
          const { data: dist } = await supabase.from('comprobante_obras').select('*').eq('tipo', 'gasto').in('referencia_id', gids)
          if (dist) lista = lista.map(g => ({ ...g, distribucion: dist.filter(d => d.referencia_id === g.id) }))
        }
        setGastos(lista)
      }
    } catch (e) { console.error('useGastos catch:', e) }
    if (failsafe) clearTimeout(failsafe)
    if (showLoading) setLoading(false)
  }, [idsClave])
  useEffect(() => { cargar() }, [cargar])
  return { gastos, setGastos, loading, recargar: cargar }
}

// Remitos pendientes (provisorios) para imputar a las obras
function useRemitosPendientes() {
  const [remitosPendientes, setRemitosPendientes] = useState([])
  const cargar = useCallback(async () => {
    try {
      const { data } = await supabase.from('remitos').select('*, proveedores(nombre)').eq('estado', 'pendiente')
      let lista = data ?? []
      if (lista.length > 0) {
        const ids = lista.map(r => r.id)
        const { data: dist } = await supabase.from('comprobante_obras').select('*').eq('tipo', 'remito').in('referencia_id', ids)
        if (dist) lista = lista.map(r => ({ ...r, comprobante_obras: dist.filter(d => d.referencia_id === r.id) }))
      }
      setRemitosPendientes(lista)
    } catch (e) { console.error('useRemitosPendientes:', e) }
  }, [])
  useEffect(() => { cargar() }, [cargar])
  return { remitosPendientes, recargarRemitosPend: cargar }
}

// ── App ───────────────────────────────────────────────────────
export default function GestorObras({ usuario }) {
  const esAdmin = usuario?.perfil?.rol === 'admin'
  const [panel, setPanel] = useState('inicio')
  const [pendingModal, setPendingModal] = useState(null)
  const [filtroObraId, setFiltroObraId] = useState('')
  const [modal, setModal] = useState(null)
  const [itemEditando, setItemEditando] = useState(null)
  const [proveedorPendiente, setProveedorPendiente] = useState(null)
  const [onProveedorCreado, setOnProveedorCreado] = useState(null)

  const { clientes, proveedores, bancos, recargarListas, setProveedores } = useListas()
  const { obras, setObras, loading: loadingObras, recargar: recargarObras, obrasIds } = useObras(usuario?.id, esAdmin)
  const { gastos: todosGastos, setGastos, loading: loadingGastos, recargar: recargarGastos } = useGastos(obrasIds)
  const { remitosPendientes, recargarRemitosPend } = useRemitosPendientes()
  const gastos = filtroObraId ? todosGastos.filter(g => imputaciones(g).some(im => im.obra_id === filtroObraId)) : todosGastos
  // Remitos pendientes (provisorios) imputados por obra
  const remitosPorObra = {}
  remitosPendientes.forEach(r => imputacionesRemito(r).forEach(im => { remitosPorObra[im.obra_id] = (remitosPorObra[im.obra_id] || 0) + im.monto }))
  // Totales por obra (sensibles a la distribución: un gasto repartido suma a cada obra su parte)
  const creditoFiscalPorObra = {}
  const totalPorObra = {}
  const cantPorObra = {}
  todosGastos.filter(g => !g.es_gasto_general).forEach(g => {
    const ivaG = ivaCreditoGasto(g), totalG = parseFloat(g.monto) || 0
    const obrasTocadas = new Set()
    imputaciones(g).forEach(im => {
      totalPorObra[im.obra_id] = (totalPorObra[im.obra_id] || 0) + im.monto
      if (ivaG > 0 && totalG > 0) creditoFiscalPorObra[im.obra_id] = (creditoFiscalPorObra[im.obra_id] || 0) + Math.round(ivaG * (im.monto / totalG))
      obrasTocadas.add(im.obra_id)
    })
    obrasTocadas.forEach(o => { cantPorObra[o] = (cantPorObra[o] || 0) + 1 })
  })
  // silent=true → refresca en background sin mostrar spinner (post-save en mobile)
  const recargarTodo = (silent = false) => { recargarObras(!silent); recargarGastos(!silent); recargarRemitosPend() }

  // Realtime: auto-actualiza cuando otro dispositivo guarda o borra datos
  useEffect(() => {
    let timerG, timerO, timerL, timerR
    const ch = supabase.channel('sync-multi-device')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gastos' }, () => {
        clearTimeout(timerG); timerG = setTimeout(recargarGastos, 800)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'obras' }, () => {
        clearTimeout(timerO); timerO = setTimeout(recargarObras, 800)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clientes' }, () => {
        clearTimeout(timerL); timerL = setTimeout(recargarListas, 800)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'proveedores' }, () => {
        clearTimeout(timerL); timerL = setTimeout(recargarListas, 800)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'remitos' }, () => {
        clearTimeout(timerR); timerR = setTimeout(recargarRemitosPend, 800)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'obra_usuarios' }, () => {
        clearTimeout(timerO); timerO = setTimeout(recargarObras, 800)
      })
      .subscribe()
    return () => { supabase.removeChannel(ch); clearTimeout(timerG); clearTimeout(timerO); clearTimeout(timerL); clearTimeout(timerR) }
  }, [recargarGastos, recargarObras, recargarListas, recargarRemitosPend])

  // Recargar remitos provisorios al cambiar de panel (por si se creó/anuló uno en Cuenta Corriente)
  useEffect(() => { recargarRemitosPend() }, [panel, recargarRemitosPend])

  const abrirModal = (tipo, item = null) => { setItemEditando(item); setModal(tipo) }

  // Abre modal pendiente cuando el panel cambia y las obras ya cargaron
  useEffect(() => {
    if (pendingModal && panel === 'gastos' && !loadingObras && obras.length > 0) {
      abrirModal(pendingModal)
      setPendingModal(null)
    }
  }, [panel, loadingObras, obras.length, pendingModal])
  const cerrarModal = () => { setModal(null); setItemEditando(null) }
  const handleLogout = () => {
    // Cerrar sesión local inmediatamente (sin network)
    localStorage.removeItem('seate-auth')
    // Notificar a onAuthStateChange para que React actualice el estado
    supabase.auth.signOut({ scope: 'local' }).catch(() => {})
    // Invalidar token en servidor en background (puede fallar sin problema)
    supabase.auth.signOut({ scope: 'global' }).catch(() => {})
  }

  useEffect(() => {
    document.body.style.margin = '0'
    document.body.style.padding = '0'
    document.body.style.overflowX = 'hidden'
    document.body.style.background = C.bg
  }, [])

  const TABS = [
    { id: 'inicio',  label: 'Inicio',  icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/><path d="M9 21V12h6v9"/></svg> },
    { id: 'obras',   label: 'Obras',   icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="14" width="8" height="8"/><rect x="14" y="2" width="8" height="8"/><path d="M2 2h8v8H2zM14 14h8v8h-8z" strokeOpacity="0"/><rect x="2" y="2" width="8" height="8"/><rect x="14" y="14" width="8" height="8"/></svg> },
    { id: 'gastos',  label: 'Gastos',  icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg> },

    { id: 'informe',  label: 'Informe',  icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> },
    { id: 'finanzas', label: 'Finanzas', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M7 10h2m4 0h2M7 7h10"/></svg> },
    { id: 'mas',     label: 'Más',     icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg> },
  ]

  const guardarProveedor = async (datos) => {
    const { nombre, cuit, rubro, situacion_impositiva, telefono, contacto, nota, cbu, alias_cbu, banco, titular_cuenta, condicion_pago, redondear_viernes } = datos
    let nuevoProv = null
    try {
      nuevoProv = await dbWrite('POST', 'proveedores',
        { nombre: nombre.trim(), cuit: cuit?.trim() || null, rubro: rubro || null, situacion_impositiva, telefono: telefono || null, contacto: contacto || null, nota: nota || null, cbu: cbu || null, alias_cbu: alias_cbu || null, banco: banco || null, titular_cuenta: titular_cuenta || null, condicion_pago: condicion_pago || 'contado', redondear_viernes: redondear_viernes !== false },
        null, true)
    } catch (e) {
      console.warn('guardarProveedor dbWrite error, buscando por nombre:', e.message)
    }
    // Fallback: buscar por nombre si no vino el row
    if (!nuevoProv?.id) {
      const { data } = await supabase.from('proveedores').select('*').eq('nombre', nombre.trim()).single()
      nuevoProv = data
    }
    if (!nuevoProv) throw new Error('Proveedor guardado pero no se pudo recuperar. Vinculalo manualmente.')
    // Actualización optimista: agregar al estado local SIN esperar recargarListas
    setProveedores(prev => prev.find(p => p.id === nuevoProv.id) ? prev : [...prev, nuevoProv])
    recargarListas() // refresca en background
    if (onProveedorCreado) onProveedorCreado(nuevoProv)
    setProveedorPendiente(null)
    setOnProveedorCreado(null)
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Inter:wght@600;700;800&display=swap');
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body { font-family: 'Outfit', sans-serif !important; background: ${C.bg}; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #DCDCDC; border-radius: 99px; }
        input, select, textarea { font-family: 'Outfit', sans-serif; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .card-hover { transition: box-shadow 0.15s, border-color 0.15s; }
        .card-hover:hover { border-color: #D0D0D0 !important; box-shadow: 0 4px 16px rgba(0,0,0,0.06) !important; }
        .fade-up { animation: fadeUp 0.22s ease; }
        /* DESKTOP: topbar nav */
        @media (max-width: 639px) {
          .desktop-only { display: none !important; }
          .mobile-only { display: block !important; }
          .mobile-tabs { display: flex !important; }
          .main-content { padding-bottom: 76px !important; padding-top: 0 !important; }
          .desktop-topbar { display: none !important; }
          .mobile-header { display: block !important; }
        }
        @media (min-width: 640px) {
          .mobile-only { display: none !important; }
          .mobile-tabs { display: none !important; }
          .desktop-topbar { display: flex !important; }
          .mobile-header { display: none !important; }
        }
      `}</style>

      <div style={{ minHeight: '100vh', background: C.bg, fontFamily: "'Outfit', sans-serif", width: '100%', overflowX: 'hidden' }}>

        {/* ── DESKTOP TOPBAR ── */}
        <div className="desktop-topbar" style={{ display: 'none', background: C.surface, borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0, zIndex: 50 }}>
          <div style={{ maxWidth: 1060, margin: '0 auto', padding: '0 20px', display: 'flex', alignItems: 'center', height: 54, gap: 14, width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
              <div style={{ width: 30, height: 30, background: C.purple, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <SeateHex size={17} color="#fff" />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text, letterSpacing: '0.06em', lineHeight: 1 }}>SEATE</div>
                <div style={{ fontSize: 9, color: C.textFaint, letterSpacing: '0.1em', marginTop: 1 }}>CONSTRUCCIONES</div>
              </div>
            </div>
            <nav style={{ display: 'flex', marginLeft: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
              {['inicio','obras','gastos','informe','finanzas'].map(id => {
                const t = TABS.find(t => t.id === id)
                return (
                  <button key={id} onClick={() => setPanel(id)} style={{
                    padding: '6px 16px', fontSize: 12, cursor: 'pointer', border: 'none',
                    borderRight: `1px solid ${C.border}`, fontFamily: "'Outfit', sans-serif",
                    fontWeight: panel === id ? 600 : 400,
                    background: panel === id ? C.purpleDim : C.surface,
                    color: panel === id ? C.purple : C.textMuted,
                    transition: 'all 0.12s', whiteSpace: 'nowrap',
                  }}>{t?.icon} {t?.label}</button>
                )
              })}
              <button onClick={() => setPanel('contactos')} style={{ padding: '6px 16px', fontSize: 12, cursor: 'pointer', border: 'none', borderRight: `1px solid ${C.border}`, fontFamily: "'Outfit', sans-serif", fontWeight: panel === 'contactos' ? 600 : 400, background: panel === 'contactos' ? C.purpleDim : C.surface, color: panel === 'contactos' ? C.purple : C.textMuted }}>👥 Contactos</button>
              {esAdmin && <button onClick={() => setPanel('admin')} style={{ padding: '6px 16px', fontSize: 12, cursor: 'pointer', border: 'none', fontFamily: "'Outfit', sans-serif", fontWeight: panel === 'admin' ? 600 : 400, background: panel === 'admin' ? C.purpleDim : C.surface, color: panel === 'admin' ? C.purple : C.textMuted }}>⚙️ Admin</button>}
            </nav>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8, flexShrink: 0 }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{usuario?.perfil?.nombre ?? usuario?.email}</div>
                <div style={{ fontSize: 10, color: esAdmin ? C.purple : C.textFaint, fontWeight: 600 }}>{esAdmin ? 'Admin' : 'Operador'}</div>
              </div>
              <button onClick={handleLogout} style={{ padding: '5px 10px', background: 'transparent', color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 11, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>Salir</button>
            </div>
          </div>
        </div>

        {/* ── MOBILE HEADER (gradiente) ── */}
        <div className="mobile-header" style={{ display: 'none', background: `linear-gradient(145deg, ${C.purpleDark} 0%, ${C.purple} 55%, ${C.purpleLight} 100%)`, padding: '16px 20px 28px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: -50, right: -50, width: 180, height: 180, borderRadius: '50%', background: 'rgba(255,255,255,0.06)' }} />
          <div style={{ position: 'absolute', bottom: -30, left: 30, width: 120, height: 120, borderRadius: '50%', background: 'rgba(255,255,255,0.04)' }} />
          <div style={{ position: 'relative', zIndex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <div style={{ width: 34, height: 34, background: 'rgba(255,255,255,0.15)', borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.25)' }}>
                  <SeateHex size={20} color="#fff" />
                </div>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', letterSpacing: '0.06em', lineHeight: 1 }}>SEATE</div>
                  <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.55)', letterSpacing: '0.12em', marginTop: 2 }}>CONSTRUCCIONES</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>{usuario?.perfil?.nombre ?? 'Usuario'}</div>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>{esAdmin ? 'Admin' : 'Operador'}</div>
                </div>
                <button onClick={handleLogout} style={{ padding: '5px 10px', background: 'rgba(255,255,255,0.15)', color: '#fff', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 7, fontSize: 11, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>Salir</button>
              </div>
            </div>
            <MobileHeaderStats obras={obras} gastos={todosGastos} remitosPorObra={remitosPorObra} />
          </div>
          {/* Quick actions — solo en panel inicio */}
          {panel === 'inicio' && (
          <div style={{ display: 'flex', justifyContent: 'space-around', marginTop: 20, position: 'relative', zIndex: 1 }}>
            {[
              { icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="8" height="8"/><rect x="14" y="2" width="8" height="8"/><rect x="2" y="14" width="8" height="8"/><rect x="14" y="14" width="8" height="8"/></svg>, label: 'Obras', action: () => setPanel('obras') },
              { icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>, label: '+ Gasto', action: () => { setPanel('gastos'); setPendingModal('gasto') } },
              { icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>, label: 'Comprobante', action: () => { setPanel('gastos'); setPendingModal('foto') } },
              { icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>, label: 'Informe', action: () => setPanel('informe') },
            ].map(a => (
              <button key={a.label} onClick={a.action} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, background: 'transparent', border: 'none', cursor: 'pointer' }}>
                <div style={{ width: 52, height: 52, borderRadius: 16, background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>{a.icon}</div>
                <span style={{ fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.85)', fontFamily: "'Outfit', sans-serif" }}>{a.label}</span>
              </button>
            ))}
          </div>
          )}
        </div>

        {/* ── CONTENIDO ── */}
        <div className="main-content" style={{ maxWidth: 1060, margin: '0 auto', padding: '24px 20px', width: '100%' }}>
          <div className="fade-up" key={panel}>
            {panel === 'inicio'    && <PanelInicio obras={obras} gastos={todosGastos} remitosPorObra={remitosPorObra} esAdmin={esAdmin} onVerGastos={(id) => { setFiltroObraId(id); setPanel('gastos') }} onVerObras={() => setPanel('obras')} onNuevoGasto={() => abrirModal('gasto')} onNuevoFoto={() => abrirModal('foto')} />}
            {panel === 'obras'     && <PanelObras obras={obras} creditoFiscalPorObra={creditoFiscalPorObra} totalPorObra={totalPorObra} cantPorObra={cantPorObra} remitosPorObra={remitosPorObra} loading={loadingObras} esAdmin={esAdmin} onNueva={() => abrirModal('obra')} onEditar={o => abrirModal('obra', o)} onVerGastos={id => { setFiltroObraId(id); setPanel('gastos') }} />}
            {panel === 'gastos'    && <PanelGastos obras={obras} gastos={gastos} remitosPendientes={remitosPendientes} loading={loadingGastos} filtroObraId={filtroObraId} setFiltroObraId={setFiltroObraId} esAdmin={esAdmin} onNuevoManual={() => abrirModal('gasto')} onNuevoFoto={() => abrirModal('foto')} onEditar={g => abrirModal('gasto', g)} onPagar={g => abrirModal('pago', g)} onPagarMultiple={gastos => { setItemEditando(gastos); setModal('pagoMultiple') }} onAdjuntarComprobante={g => abrirModal('adjuntarComprobante', g)} onEliminar={async g => { if (window.confirm('¿Eliminar este gasto?')) { await dbWrite('DELETE', 'gastos', null, `id=eq.${g.id}`); setGastos(prev => prev.filter(x => x.id !== g.id)); recargarObras(true); recargarGastos(false) } }} />}
            {panel === 'cc'        && <CuentaCorriente esAdmin={esAdmin} usuario={usuario} />}
            {panel === 'finanzas'  && <PanelFinanciero gastos={todosGastos} obras={obras} />}
            {panel === 'informe'   && <PanelInforme obras={obras} gastos={todosGastos} remitosPorObra={remitosPorObra} bancos={bancos} esAdmin={esAdmin} loading={loadingGastos} />}
            {panel === 'contactos' && <PanelContactos clientes={clientes} proveedores={proveedores} onNuevoCliente={() => abrirModal('cliente')} onNuevoProveedor={() => abrirModal('proveedor')} onEditarCliente={c => abrirModal('cliente', c)} onEditarProveedor={p => abrirModal('proveedor', p)}
              onEliminarCliente={async c => { if (!window.confirm(`¿Eliminar cliente "${c.nombre}"?`)) return; await dbWrite('DELETE', 'clientes', null, `id=eq.${c.id}`); recargarListas() }}
              onEliminarProveedor={async p => { if (!window.confirm(`¿Eliminar proveedor "${p.nombre}"?`)) return; await dbWrite('DELETE', 'proveedores', null, `id=eq.${p.id}`); recargarListas() }}
            />}
            {panel === 'admin'     && esAdmin && <PanelAdmin bancos={bancos} recargarListas={recargarListas} />}
            {panel === 'mas'       && <PanelMas esAdmin={esAdmin} onContactos={() => setPanel('contactos')} onAdmin={() => setPanel('admin')} onLogout={handleLogout} usuario={usuario} />}
          </div>
        </div>

        {/* ── BOTTOM NAV MOBILE ── */}
        <div className="mobile-tabs" style={{ display: 'none', position: 'fixed', bottom: 0, left: 0, right: 0, width: '100%', background: C.surface, borderTop: `1px solid ${C.border}`, zIndex: 50, paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}>
          <div style={{ display: 'flex', width: '100%', height: 56 }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setPanel(t.id)} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, padding: '6px 2px', border: 'none', background: 'transparent', cursor: 'pointer', color: panel === t.id ? C.purple : C.textFaint, transition: 'color 0.12s', position: 'relative' }}>
                {panel === t.id && <div style={{ position: 'absolute', top: 0, left: '20%', right: '20%', height: 2, background: C.purple, borderRadius: '0 0 3px 3px' }} />}
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{t.icon}</span>
                <span style={{ fontSize: 9, fontWeight: panel === t.id ? 600 : 400, fontFamily: "'Outfit', sans-serif", letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── MODALES ── */}
      {modal === 'obra' && <ModalObra itemEdit={itemEditando} clientes={clientes} onClose={cerrarModal} onGuardar={async d => {
        if (!d.nombre) return window._toast?.('El nombre es obligatorio')
        const { id, nombre, cliente_id, estado, presupuesto } = d
        const payload = { nombre, cliente_id: cliente_id || null, estado, presupuesto: parseFloat(presupuesto) || 0 }
        if (id) {
          await dbWrite('PATCH', 'obras', payload, `id=eq.${id}`)
          setObras(prev => prev.map(o => o.id === id ? { ...o, ...payload } : o))
        } else {
          const saved = await dbWrite('POST', 'obras', payload, null, true)
          if (saved?.id) {
            setObras(prev => [...prev, { ...payload, id: saved.id, total_gastado: 0, cant_gastos: 0 }])
            // Auto-asignar al usuario que la crea (solo operadores — admins ven todo)
            if (!esAdmin && usuario?.id) await dbWrite('POST', 'obra_usuarios', { obra_id: saved.id, usuario_id: usuario.id })
          }
        }
        cerrarModal(); recargarObras(true)
      }} />}

      {modal === 'gasto' && obras.length > 0 && <ModalGasto itemEdit={itemEditando} obras={obras} proveedores={proveedores} obraIdDefecto={filtroObraId} onClose={cerrarModal}
        onNuevoProveedor={(nombre, cb, cuitIA, sitIA) => { setProveedorPendiente({ nombre, cuit: cuitIA || '', situacion_impositiva: sitIA || null }); setOnProveedorCreado(() => cb) }}
        onGuardar={async d => {
          if (!d.monto || d.monto <= 0) { window._toast?.('Ingresá un monto válido'); throw new Error('Ingresá un monto válido') }
          const { id, obra_id, fecha, proveedor_id, concepto, monto, descripcion, tipo_comprobante, discrimina_iva, nro_comprobante, a_nombre_seate, iva_monto, condicion_pago, redondear_viernes, es_gasto_general } = d
          // a_nombre_seate solo aplica a Factura A
          const payload = { obra_id: es_gasto_general ? null : (obra_id || null), fecha, proveedor_id: proveedor_id || null, concepto, monto: parseFloat(monto) || 0, descripcion, tipo_comprobante, discrimina_iva, nro_comprobante, a_nombre_seate: tipo_comprobante === 'factura_a' ? !!a_nombre_seate : false, iva_monto: parseFloat(iva_monto) || 0, condicion_pago: condicion_pago || 'contado', redondear_viernes: !!redondear_viernes, es_gasto_general: !!es_gasto_general }
          const esNuevo = !id
          const saved = await dbWrite(id ? 'PATCH' : 'POST', 'gastos', payload, id ? `id=eq.${id}` : null, esNuevo)
          // Actualización optimista: reflejar en UI sin esperar reload
          const obraObj = obras.find(o => o.id === obra_id)
          const provObj = proveedores.find(p => p.id === (proveedor_id || null))
          if (esNuevo && saved?.id) {
            setGastos(prev => [{ ...payload, id: saved.id, obras: obraObj ? { nombre: obraObj.nombre } : null, proveedores: provObj ? { nombre: provObj.nombre, situacion_impositiva: provObj.situacion_impositiva } : null, pagos: [] }, ...prev])
          } else if (!esNuevo) {
            setGastos(prev => prev.map(g => g.id === id ? { ...g, ...payload, obras: obraObj ? { nombre: obraObj.nombre } : g.obras, proveedores: provObj ? { nombre: provObj.nombre, situacion_impositiva: provObj.situacion_impositiva } : g.proveedores } : g))
          }
          const gastoId = saved?.id || id
          if (gastoId) await guardarDistribGasto(gastoId, d.distribucion, parseFloat(monto) || 0)
          cerrarModal(); recargarTodo(true); setPanel('gastos')
        }}
      />}

      {modal === 'foto' && obras.length > 0 && <ModalFoto obras={obras} proveedores={proveedores} obraIdDefecto={filtroObraId} onClose={cerrarModal}
        onNuevoProveedor={(nombre, cb, cuitIA, sitIA) => { setProveedorPendiente({ nombre, cuit: cuitIA || '', situacion_impositiva: sitIA || null }); setOnProveedorCreado(() => cb) }}
        onGuardar={async d => {
          // distribucion no es columna de gastos: se separa y se guarda en comprobante_obras
          const { distribucion, ...rest } = d
          const gastoPayload = { ...rest, a_nombre_seate: d.tipo_comprobante === 'factura_a' ? !!d.a_nombre_seate : false, iva_monto: parseFloat(d.iva_monto) || 0 }
          const saved = await dbWrite('POST', 'gastos', gastoPayload, null, true)
          // Actualización optimista
          const obraObj = obras.find(o => o.id === gastoPayload.obra_id)
          const provObj = proveedores.find(p => p.id === gastoPayload.proveedor_id)
          if (saved?.id) {
            await guardarDistribGasto(saved.id, distribucion, parseFloat(gastoPayload.monto) || 0)
            setGastos(prev => [{ ...gastoPayload, id: saved.id, obras: obraObj ? { nombre: obraObj.nombre } : null, proveedores: provObj ? { nombre: provObj.nombre, situacion_impositiva: provObj.situacion_impositiva } : null, pagos: [] }, ...prev])
          }
          cerrarModal(); recargarTodo(true)
        }}
      />}

      {modal === 'pago' && esAdmin && <ModalPago gasto={itemEditando} bancos={bancos} onClose={cerrarModal} onGuardar={async d => {
        const payload = { ...d, gasto_id: itemEditando.id, creado_por: usuario.id }
        // Vía dbWrite (Edge Function): la escritura directa a Supabase se cuelga en mobile
        const savedPago = await dbWrite('POST', 'pagos', payload, null, true)
        await dbWrite('PATCH', 'gastos', { pagado: true }, `id=eq.${itemEditando.id}`)
        // Optimista: marcar el gasto como pagado y sumar el pago en memoria
        setGastos(prev => prev.map(g => g.id === itemEditando.id ? { ...g, pagado: true, pagos: [...(g.pagos || []), { ...payload, id: savedPago?.id }] } : g))
        cerrarModal(); recargarGastos(false)
      }} />}

      {modal === 'pagoMultiple' && esAdmin && Array.isArray(itemEditando) && (
        <ModalPagoMultiple
          gastos={itemEditando}
          bancos={bancos}
          onClose={cerrarModal}
          onGuardar={async d => {
            for (const g of itemEditando) {
              const payload = { ...d, gasto_id: g.id, creado_por: usuario.id, monto: g.monto }
              const savedPago = await dbWrite('POST', 'pagos', payload, null, true)
              await dbWrite('PATCH', 'gastos', { pagado: true }, `id=eq.${g.id}`)
              setGastos(prev => prev.map(x => x.id === g.id ? { ...x, pagado: true, pagos: [...(x.pagos || []), { ...payload, id: savedPago?.id }] } : x))
            }
            cerrarModal(); recargarGastos(false)
          }}
        />
      )}
      {modal === 'adjuntarComprobante' && esAdmin && itemEditando && (
        <ModalAdjuntarComprobante
          gasto={itemEditando}
          onClose={cerrarModal}
          onGuardar={async url => {
            const pagoId = itemEditando.pagos?.[0]?.id
            if (!pagoId) return
            await dbWrite('PATCH', 'pagos', { comprobante_url: url }, `id=eq.${pagoId}`)
            setGastos(prev => prev.map(g => g.id === itemEditando.id
              ? { ...g, pagos: (g.pagos || []).map((p, i) => i === 0 ? { ...p, comprobante_url: url } : p) }
              : g))
            cerrarModal()
          }}
        />
      )}
      {modal === 'cliente'   && <ModalCliente   itemEdit={itemEditando} onClose={cerrarModal} onGuardar={async d => {
        if (!d.nombre) throw new Error('Nombre obligatorio')
        const { id, nombre, telefono, email } = d
        await dbWrite(id ? 'PATCH' : 'POST', 'clientes', { nombre, telefono, email }, id ? `id=eq.${id}` : null)
        cerrarModal(); recargarListas()
      }} />}
      {modal === 'proveedor' && <ModalProveedor itemEdit={itemEditando} onClose={cerrarModal} onGuardar={async d => {
        if (!d.nombre) throw new Error('Nombre obligatorio')
        const { id, nombre, cuit, rubro, situacion_impositiva, telefono, contacto, nota, cbu, alias_cbu, banco, titular_cuenta, condicion_pago, redondear_viernes } = d
        await dbWrite(id ? 'PATCH' : 'POST', 'proveedores', { nombre, cuit, rubro, situacion_impositiva, telefono: telefono || null, contacto: contacto || null, nota: nota || null, cbu: cbu || null, alias_cbu: alias_cbu || null, banco: banco || null, titular_cuenta: titular_cuenta || null, condicion_pago: condicion_pago || 'contado', redondear_viernes: redondear_viernes !== false }, id ? `id=eq.${id}` : null)
        cerrarModal(); recargarListas()
      }} />}
      {proveedorPendiente && <ModalAltaProveedor datosIniciales={proveedorPendiente} onClose={() => { setProveedorPendiente(null); setOnProveedorCreado(null) }} onGuardar={guardarProveedor} zIndex={300} />}
    </>
  )
}

// ── Ícono SEATE ───────────────────────────────────────────────
function SeateHex({ size = 20, color = '#7B4DB5' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <polygon points="50,4 93,27.5 93,72.5 50,96 7,72.5 7,27.5" fill="none" stroke={color} strokeWidth="11"/>
      <polygon points="50,24 74,37 74,63 50,76 26,63 26,37" fill="none" stroke={color} strokeWidth="8"/>
      <line x1="50" y1="24" x2="50" y2="76" stroke={color} strokeWidth="5" opacity=".4"/>
      <line x1="26" y1="37" x2="74" y2="37" stroke={color} strokeWidth="5" opacity=".4"/>
    </svg>
  )
}

// ── Mobile header stats ───────────────────────────────────────
function MobileHeaderStats({ obras, gastos, remitosPorObra = {} }) {
  const obrasActivas = obras.filter(o => o.estado === 'activa').length
  const idsActivas = new Set(obras.filter(o => o.estado === 'activa').map(o => o.id))
  // Distribución: cada gasto suma a cada obra su parte. Total = parte en obras activas.
  let totalConfirmado = 0, pendiente = 0
  gastos.forEach(g => imputaciones(g).forEach(im => {
    if (idsActivas.has(im.obra_id)) totalConfirmado += im.monto
    if (!g.pagado) pendiente += im.monto   // pendiente = toda la deuda impaga (cualquier obra)
  }))
  // Remitos provisorios de obras activas (se suman al total)
  let provisorio = 0
  Object.entries(remitosPorObra).forEach(([oid, m]) => { if (idsActivas.has(oid)) provisorio += m })
  const totalGastos = totalConfirmado + provisorio
  return (
    <div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>Total gastado</div>
      <div style={{ fontSize: 38, fontWeight: 800, color: '#fff', fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.04em', lineHeight: 1 }}>$ {fmt(totalGastos)}</div>
      <div style={{ display: 'flex', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>🏗️ {obrasActivas} obra{obrasActivas !== 1 ? 's' : ''} activa{obrasActivas !== 1 ? 's' : ''}</span>
        {pendiente > 0 && <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>⏳ {fmtK(pendiente)} pendiente</span>}
        {provisorio > 0 && <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>📋 {fmtK(provisorio)} en remitos</span>}
      </div>
    </div>
  )
}

// ── Panel Inicio ──────────────────────────────────────────────
function calcVencimiento(fecha, condicion, redondearViernes = true) {
  if (!fecha || !condicion || condicion === 'contado') return fecha
  const d = new Date(fecha + 'T12:00:00')
  if (condicion === 'viernes') {
    const dow = d.getDay(); const toFri = dow === 5 ? 7 : (5 - dow + 7) % 7
    d.setDate(d.getDate() + (toFri || 7)); return d.toISOString().slice(0, 10)
  }
  const dias = condicion === '15_dias' ? 15 : condicion === '30_dias' ? 30 : condicion === '60_dias' ? 60 : 0
  d.setDate(d.getDate() + dias)
  if (redondearViernes) {
    const dow = d.getDay(); if (dow !== 5) { const tf = (5 - dow + 7) % 7; d.setDate(d.getDate() + (tf || 7)) }
  }
  return d.toISOString().slice(0, 10)
}
function diasHasta(fechaISO) {
  if (!fechaISO) return null
  const hoyMs = new Date(hoy() + 'T12:00:00').getTime()
  const fMs   = new Date(fechaISO + 'T12:00:00').getTime()
  return Math.round((fMs - hoyMs) / 86400000)
}

function WAIcon({ size = 14 }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width={size} height={size} style={{ display: 'block' }}>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
  )
}

function PanelInicio({ obras, gastos, remitosPorObra = {}, esAdmin, onVerGastos, onVerObras, onNuevoGasto, onNuevoFoto }) {
  // ── Filtro de período ──
  const ahora = new Date()
  const mesActual = `${ahora.getFullYear()}-${String(ahora.getMonth()+1).padStart(2,'0')}`
  const [periodo, setPeriodo] = useState('mes')      // 'mes' | 'trimestre' | 'semestre' | 'anio' | 'todo' | 'mes:YYYY-MM'
  const [mesElegido, setMesElegido] = useState(mesActual)

  // Genera los últimos 18 meses para el selector
  const mesesDisp = Array.from({ length: 18 }, (_, i) => {
    const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1)
    const val = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
    const label = d.toLocaleString('es-AR', { month: 'long', year: 'numeric' })
    return { val, label: label.charAt(0).toUpperCase() + label.slice(1) }
  })

  const enPeriodo = (fecha) => {
    if (!fecha) return true
    if (periodo === 'todo') return true
    const f = fecha.slice(0, 7) // YYYY-MM
    const fy = parseInt(fecha.slice(0, 4))
    const fm = parseInt(fecha.slice(5, 7))
    const ay = ahora.getFullYear(), am = ahora.getMonth() + 1
    if (periodo === 'mes') return f === mesActual
    if (periodo.startsWith('mes:')) return f === periodo.slice(4)
    if (periodo === 'trimestre') return fy === ay && fm >= am - 2
    if (periodo === 'semestre') return fy === ay && fm >= am - 5
    if (periodo === 'anio') return fy === ay
    return true
  }

  const labelPeriodo = () => {
    if (periodo === 'todo') return 'Todo'
    if (periodo === 'trimestre') return 'Trimestre'
    if (periodo === 'semestre') return 'Semestre'
    if (periodo === 'anio') return `Año ${ahora.getFullYear()}`
    if (periodo.startsWith('mes:')) return mesesDisp.find(m => m.val === periodo.slice(4))?.label ?? ''
    return mesesDisp[0]?.label ?? ''
  }

  const obrasActivas = obras.filter(o => o.estado === 'activa')
  const idsActivas = new Set(obrasActivas.map(o => o.id))
  // Distribución: un gasto cuenta en una obra activa si alguna de sus partes cae ahí
  const gastosActivas = gastos.filter(g => !g.es_gasto_general && imputaciones(g).some(im => idsActivas.has(im.obra_id)))
  // Gastos generales de empresa en el período
  const gastosGeneralesEnPeriodo = gastos.filter(g => g.es_gasto_general && enPeriodo(g.fecha))
  const totalGenerales = gastosGeneralesEnPeriodo.reduce((s, g) => s + (g.monto || 0), 0)

  // Prorrateo: cada obra activa absorbe según su peso en el gasto total del período
  const gastosEnPeriodo = gastosActivas.filter(g => enPeriodo(g.fecha))
  let totalConfirmado = 0, pagado = 0, creditoFiscal = 0
  gastosEnPeriodo.forEach(g => imputaciones(g).forEach(im => {
    if (!idsActivas.has(im.obra_id)) return
    totalConfirmado += im.monto
    if (g.pagado) pagado += im.monto
    creditoFiscal += ivaCreditoImputacion(g, im.monto)
  }))
  // Remitos provisorios de obras activas (se suman al total, con aclaración)
  let provisorio = 0
  Object.entries(remitosPorObra).forEach(([oid, m]) => { if (idsActivas.has(oid)) provisorio += m })
  const totalGastos = totalConfirmado + provisorio
  // Pendiente = toda la deuda impaga (incluso obras cerradas), filtrada por período
  const impagas = gastosEnPeriodo.filter(g => !g.pagado && !g.es_gasto_general)
  let pendiente = 0
  impagas.forEach(g => imputaciones(g).forEach(im => { pendiente += im.monto }))
  const cantImpagas = impagas.length
  const cantCreditoA = gastosEnPeriodo.filter(g => ivaCreditoGasto(g) > 0).length
  const ultimosGastos = gastosEnPeriodo.slice(0, 5)

  const PERIODOS_RAPIDOS = [
    { value: 'mes',       label: 'Este mes' },
    { value: 'trimestre', label: 'Trimestre' },
    { value: 'semestre',  label: 'Semestre' },
    { value: 'anio',      label: `Año ${ahora.getFullYear()}` },
    { value: 'todo',      label: 'Todo' },
  ]

  return (
    <div>
      {/* Stats desktop (en mobile se ve en el header) */}
      <div className="desktop-only" style={{ marginBottom: 20 }}>
        <PageHeader titulo="Inicio" sub={`Resumen · ${labelPeriodo()}`}>
          <div style={{ display: 'flex', gap: 8 }}>
          <BtnSecondary onClick={onNuevoFoto}>📎 Comprobante</BtnSecondary>
          <BtnPrimary onClick={onNuevoGasto}>+ Gasto</BtnPrimary>
          </div>
        </PageHeader>
        {/* Selector de período */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
            {PERIODOS_RAPIDOS.map(p => (
              <button key={p.value} onClick={() => setPeriodo(p.value)}
                style={{ padding: '6px 12px', fontSize: 12, cursor: 'pointer', border: 'none', borderRight: `1px solid ${C.border}`, fontFamily: "'Outfit', sans-serif", fontWeight: periodo === p.value ? 700 : 400, background: periodo === p.value ? C.purpleDim : C.surface, color: periodo === p.value ? C.purple : C.textMuted, whiteSpace: 'nowrap' }}>
                {p.label}
              </button>
            ))}
          </div>
          <select value={periodo.startsWith('mes:') ? periodo.slice(4) : ''}
            onChange={e => { if (e.target.value) setPeriodo('mes:' + e.target.value) }}
            style={{ padding: '6px 10px', borderRadius: 8, border: `1.5px solid ${periodo.startsWith('mes:') ? C.purple : C.border}`, fontSize: 12, color: periodo.startsWith('mes:') ? C.purple : C.textMuted, background: periodo.startsWith('mes:') ? C.purpleDim : C.surface, fontFamily: "'Outfit', sans-serif", cursor: 'pointer' }}>
            <option value="">Mes anterior...</option>
            {mesesDisp.slice(1).map(m => <option key={m.val} value={m.val}>{m.label}</option>)}
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
          {[
            { label: 'Total gastos',   value: `$ ${fmt(totalGastos)}`, sub: provisorio > 0 ? `${gastosActivas.length} comprob. · incluye ${fmtK(provisorio)} provisorio` : `${gastosActivas.length} comprobantes` },
            { label: 'Pagado',         value: `$ ${fmt(pagado)}`,      sub: `${totalConfirmado > 0 ? Math.round(pagado/totalConfirmado*100) : 0}%` },
            { label: 'Pendiente',      value: `$ ${fmt(pendiente)}`,   sub: `${cantImpagas} facturas`, alert: pendiente > 0 },
            { label: 'Obras activas',  value: obrasActivas.length,     sub: `de ${obras.length} total` },
            // Crédito fiscal IVA: solo visible para administradores
            { label: 'Gastos empresa',  value: `$ ${fmt(totalGenerales)}`, sub: `${gastosGeneralesEnPeriodo.length} mov. generales` },
            { label: 'Pend. contado',   value: `$ ${fmt(gastosActivas.filter(g => !g.pagado && (!g.condicion_pago || ['contado','viernes'].includes(g.condicion_pago))).reduce((s,g)=>s+(g.monto||0),0))}`, sub: 'pago inmediato', alert2: true },
            { label: 'Pend. cta. cte.',  value: `$ ${fmt(gastosActivas.filter(g => !g.pagado && g.condicion_pago && !['contado','viernes'].includes(g.condicion_pago)).reduce((s,g)=>s+(g.monto||0),0))}`, sub: (() => { const prox = gastosActivas.filter(g => !g.pagado && g.condicion_pago && !['contado','viernes'].includes(g.condicion_pago)).map(g => calcVencimiento(g.fecha, g.condicion_pago, g.redondear_viernes)).filter(Boolean).sort()[0]; return prox ? 'próx. ' + prox : 'sin vencimientos' })() },
            ...(esAdmin ? [{ label: 'Crédito fiscal IVA', value: `$ ${fmt(creditoFiscal)}`, sub: `${cantCreditoA} fact. A SEATE` }] : []),
          ].map(s => (
            <div key={s.label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '16px' }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{s.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: s.alert ? '#D0021B' : C.text, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>{s.value}</div>
              <div style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}>{s.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Mobile stats */}
      <div className="mobile-only" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4, WebkitOverflowScrolling: 'touch' }}>
          {PERIODOS_RAPIDOS.map(p => (
            <button key={p.value} onClick={() => setPeriodo(p.value)}
              style={{ padding: '5px 12px', fontSize: 12, cursor: 'pointer', border: `1.5px solid ${periodo === p.value ? C.purple : C.border}`, borderRadius: 99, fontFamily: "'Outfit', sans-serif", fontWeight: periodo === p.value ? 700 : 400, background: periodo === p.value ? C.purpleDim : C.surface, color: periodo === p.value ? C.purple : C.textMuted, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {p.label}
            </button>
          ))}
          <select value={periodo.startsWith('mes:') ? periodo.slice(4) : ''}
            onChange={e => { if (e.target.value) setPeriodo('mes:' + e.target.value) }}
            style={{ padding: '5px 8px', borderRadius: 99, border: `1.5px solid ${periodo.startsWith('mes:') ? C.purple : C.border}`, fontSize: 12, color: periodo.startsWith('mes:') ? C.purple : C.textMuted, background: periodo.startsWith('mes:') ? C.purpleDim : C.surface, fontFamily: "'Outfit', sans-serif", flexShrink: 0 }}>
            <option value="">Mes...</option>
            {mesesDisp.slice(1).map(m => <option key={m.val} value={m.val}>{m.label}</option>)}
          </select>
        </div>
      </div>
      <div className="mobile-only" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, color: C.textFaint, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Pagado</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.green, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>{fmtK(pagado)}</div>
          <div style={{ fontSize: 10, color: C.textFaint, marginTop: 3 }}>{totalConfirmado > 0 ? Math.round(pagado/totalConfirmado*100) : 0}% del total</div>
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, color: C.textFaint, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Pendiente</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: pendiente > 0 ? '#D0021B' : C.textFaint, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>{fmtK(pendiente)}</div>
          <div style={{ fontSize: 10, color: C.textFaint, marginTop: 3 }}>{cantImpagas} facturas</div>
        </div>
      </div>

      {/* Obras activas */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Obras activas</div>
        <button onClick={onVerObras} style={{ fontSize: 12, color: C.purple, fontWeight: 600, background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>Ver todas →</button>
      </div>
      <div style={{ marginBottom: 24 }}>
        {obrasActivas.length === 0 ? <EmptyState texto="No hay obras activas" /> : obrasActivas.slice(0, 3).map(o => {
          const pct = o.presupuesto > 0 ? Math.min(100, Math.round((o.total_gastado / o.presupuesto) * 100)) : 0
          const cantGastos = gastos.filter(g => g.obra_id === o.id).length
          return (
            <div key={o.id} className="card-hover" style={{ ...cardSt, padding: '14px 16px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }} onClick={() => onVerGastos(o.id)}>
              <div style={{ width: 3, height: 48, background: C.purple, borderRadius: 99, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{o.nombre}</div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2, marginBottom: o.presupuesto > 0 ? 8 : 0 }}>{o.cliente || 'Sin cliente'}</div>
                {o.presupuesto > 0 && (
                  <div>
                    <div style={{ height: 4, background: C.borderFaint, borderRadius: 99, overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 99, width: `${pct}%`, background: `linear-gradient(90deg,${C.purple},${C.purpleLight})` }} />
                    </div>
                    <div style={{ fontSize: 10, color: C.textFaint, marginTop: 3 }}>{pct}% — $ {fmt(o.presupuesto)} presupuestado</div>
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>{fmtK(o.total_gastado)}</div>
                <div style={{ fontSize: 10, color: C.textFaint, marginTop: 3 }}>{o.cant_gastos} gastos</div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Prorrateo de gastos generales */}
      {totalGenerales > 0 && (() => {
        const gastoPorObra = {}
        gastosEnPeriodo.forEach(g => imputaciones(g).forEach(im => {
          if (!idsActivas.has(im.obra_id)) return
          gastoPorObra[im.obra_id] = (gastoPorObra[im.obra_id] || 0) + im.monto
        }))
        const totalObras = Object.values(gastoPorObra).reduce((s, v) => s + v, 0)
        const obrasConGasto = obrasActivas.filter(o => gastoPorObra[o.id] > 0)
        if (obrasConGasto.length === 0) return null
        return (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>Gastos generales — impacto por obra</div>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>$ {fmt(totalGenerales)} prorrateados según peso relativo de gasto de cada obra en el período</div>
            <div style={{ background: '#EEF4FF', border: '1px solid #C5D8FF', borderRadius: 12, overflow: 'hidden' }}>
              {obrasConGasto.map((o, i) => {
                const peso = totalObras > 0 ? gastoPorObra[o.id] / totalObras : 1 / obrasConGasto.length
                const imputado = totalGenerales * peso
                return (
                  <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: i < obrasConGasto.length - 1 ? '1px solid #C5D8FF' : 'none' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#1A2D5A' }}>{o.nombre}</div>
                      <div style={{ fontSize: 11, color: '#5A7AB5' }}>{Math.round(peso * 100)}% del gasto del período</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#2D5FA8', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>+ $ {fmt(imputado)}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* Últimos gastos */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Últimos gastos</div>
      </div>
      {ultimosGastos.length === 0 ? <EmptyState texto="No hay gastos registrados" /> : (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
          {ultimosGastos.map((g, i) => {
            const [iconBg] = CONCEPTO_COLORS[g.concepto] ?? CONCEPTO_COLORS.varios
            return (
              <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderBottom: i < ultimosGastos.length - 1 ? `1px solid ${C.borderFaint}` : 'none' }}>
                <div style={{ width: 40, height: 40, borderRadius: 12, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
                  {CONCEPTO_ICONS[g.concepto] ?? '📦'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.proveedores?.nombre ?? 'Sin proveedor'}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{g.distribucion?.length > 1 ? 'Varias obras' : g.obras?.nombre} · {g.fecha}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>$ {fmt(g.monto)}</div>
                  <PagoBadge pagado={g.pagado} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Panel Más (mobile) ────────────────────────────────────────
function PanelMas({ esAdmin, onContactos, onAdmin, onLogout, usuario }) {
  return (
    <div>
      <PageTitle titulo="Más opciones" sub="" />
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden', marginTop: 20 }}>
        {[
          { icon: '👥', label: 'Contactos', sub: 'Clientes y proveedores', action: onContactos },
          ...(esAdmin ? [{ icon: '⚙️', label: 'Administración', sub: 'Bancos y configuración', action: onAdmin }] : []),
        ].map((item, i, arr) => (
          <button key={item.label} onClick={item.action} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: '16px', border: 'none', borderBottom: i < arr.length - 1 ? `1px solid ${C.borderFaint}` : 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: "'Outfit', sans-serif" }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: C.purpleDim, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>{item.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{item.label}</div>
              <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{item.sub}</div>
            </div>
            <span style={{ color: C.textFaint, fontSize: 16 }}>›</span>
          </button>
        ))}
      </div>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden', marginTop: 16 }}>
        <div style={{ padding: '16px', borderBottom: `1px solid ${C.borderFaint}` }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{usuario?.perfil?.nombre ?? usuario?.email}</div>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{esAdmin ? '👑 Administrador' : '👤 Operador'}</div>
        </div>
        <button onClick={onLogout} style={{ width: '100%', padding: '14px 16px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontSize: 14, fontWeight: 500, color: '#D0021B', fontFamily: "'Outfit', sans-serif" }}>
          Cerrar sesión
        </button>
      </div>
    </div>
  )
}

// ── Panel Obras ───────────────────────────────────────────────
function PanelObras({ obras, loading, esAdmin, onNueva, onVerGastos, onEditar, creditoFiscalPorObra = {}, totalPorObra = {}, cantPorObra = {}, remitosPorObra = {} }) {
  const [filtroEstado, setFiltroEstado] = useState('activa')
  const [filtroCliente, setFiltroCliente] = useState('')
  const clientes = [...new Set(obras.map(o => o.cliente).filter(Boolean))].sort()
  const obrasFiltradas = obras
    .filter(o => filtroEstado === 'todas' || o.estado === filtroEstado)
    .filter(o => !filtroCliente || o.cliente === filtroCliente)
  const FILTROS = [
    { value: 'activa', label: 'Activas' },
    { value: 'pausada', label: 'Pausadas' },
    { value: 'finalizada', label: 'Finalizadas' },
    { value: 'todas', label: 'Todas' },
  ]
  return (
    <div>
      <PageHeader titulo="Obras" sub={`${obrasFiltradas.length} de ${obras.length} proyectos`}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
            {FILTROS.map(f => (
              <button key={f.value} onClick={() => setFiltroEstado(f.value)} style={{ padding: '6px 12px', fontSize: 12, cursor: 'pointer', border: 'none', borderRight: `1px solid ${C.border}`, fontFamily: "'Outfit', sans-serif", fontWeight: filtroEstado === f.value ? 600 : 400, background: filtroEstado === f.value ? C.purpleDim : C.surface, color: filtroEstado === f.value ? C.purple : C.textMuted, whiteSpace: 'nowrap' }}>{f.label}</button>
            ))}
          </div>
          {clientes.length > 0 && (
            <select value={filtroCliente} onChange={e => setFiltroCliente(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 8, border: `1.5px solid ${filtroCliente ? C.purple : C.border}`, fontSize: 12, color: filtroCliente ? C.purple : C.textMuted, background: filtroCliente ? C.purpleDim : C.surface, fontWeight: filtroCliente ? 700 : 400, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>
              <option value="">Cliente: todos</option>
              {clientes.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <BtnPrimary onClick={onNueva}>+ Nueva obra</BtnPrimary>
        </div>
      </PageHeader>
      {loading ? <Spinner /> : obrasFiltradas.length === 0 ? <EmptyState texto={`No hay obras ${filtroEstado === 'todas' ? 'registradas' : filtroEstado + 's'}`} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {obrasFiltradas.map(o => {
            const gastoConfirmado = totalPorObra[o.id] ?? o.total_gastado ?? 0
            const provis = remitosPorObra[o.id] || 0
            const totalGastado = gastoConfirmado + provis
            const cantGastos = cantPorObra[o.id] ?? o.cant_gastos ?? 0
            const pct = o.presupuesto > 0 ? Math.min(100, Math.round((totalGastado / o.presupuesto) * 100)) : 0
            const sobrep = o.presupuesto > 0 && totalGastado > o.presupuesto
            return (
              <div key={o.id} className="card-hover" style={{ ...cardSt, padding: 0, overflow: 'hidden' }} onClick={() => onVerGastos(o.id)}>
                <div style={{ display: 'flex' }}>
                  <div style={{ width: 3, background: o.estado === 'activa' ? C.purple : C.border, flexShrink: 0 }} />
                  <div style={{ flex: 1, padding: '16px 16px 16px 14px', position: 'relative' }}>
                    <button style={{ position: 'absolute', top: 12, right: 12, ...btnIconSt }} onClick={e => { e.stopPropagation(); onEditar(o) }}>✏️</button>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2, paddingRight: 32 }}>{o.nombre}</div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 14 }}>{o.cliente || 'Sin cliente'}</div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: C.text, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.04em' }}>$ {fmt(totalGastado)}</div>
                    <div style={{ fontSize: 11, color: C.textFaint, marginTop: 3, marginBottom: provis > 0 ? 4 : ((esAdmin && creditoFiscalPorObra[o.id] > 0) ? 4 : (o.presupuesto > 0 ? 10 : 12)) }}>{cantGastos} gasto{cantGastos !== 1 ? 's' : ''}</div>
                    {provis > 0 && (
                      <div style={{ fontSize: 11, color: C.orange, fontWeight: 600, background: C.orangeDim, borderRadius: 6, padding: '3px 8px', display: 'inline-block', marginBottom: o.presupuesto > 0 ? 10 : 12 }}>📋 Incluye $ {fmt(provis)} en remitos provisorios</div>
                    )}
                    {esAdmin && creditoFiscalPorObra[o.id] > 0 && (
                      <div style={{ fontSize: 11, color: C.green, fontWeight: 600, background: C.greenDim, borderRadius: 6, padding: '3px 8px', display: 'inline-block', marginBottom: o.presupuesto > 0 ? 10 : 12 }}>IVA crédito fiscal: $ {fmt(creditoFiscalPorObra[o.id])}</div>
                    )}
                    {o.presupuesto > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ height: 3, background: C.borderFaint, borderRadius: 99, overflow: 'hidden', marginBottom: 4 }}>
                          <div style={{ height: '100%', borderRadius: 99, width: `${pct}%`, background: sobrep ? '#D0021B' : C.purple, transition: 'width 0.5s' }} />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: 10, color: C.textFaint }}>$ {fmt(o.presupuesto)} presupuestado</span>
                          <span style={{ fontSize: 10, color: sobrep ? '#D0021B' : C.textFaint, fontWeight: 600 }}>{pct}%</span>
                        </div>
                      </div>
                    )}
                    <EstadoBadge estado={o.estado} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Panel Gastos ──────────────────────────────────────────────

function GastosFiltros({ obras, proveedores, filtroObraId, setFiltroObraId, filtroEstado, setFiltroEstado, filtroProveedorId, setFiltroProveedorId, filtroGeneral, setFiltroGeneral }) {
  const hasFilter = filtroObraId || filtroEstado || filtroProveedorId || filtroGeneral
  const chipSt = (active) => ({
    padding: '5px 12px', borderRadius: 99, border: `1.5px solid ${active ? C.purple : C.border}`,
    background: active ? C.purpleDim : C.surface, color: active ? C.purple : C.textMuted,
    fontSize: 12, fontWeight: active ? 700 : 400, cursor: 'pointer', whiteSpace: 'nowrap',
  })
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Estado */}
        <button style={chipSt(!filtroEstado)} onClick={() => setFiltroEstado('')}>Todos</button>
        <button style={chipSt(filtroEstado === 'pendiente')} onClick={() => setFiltroEstado(filtroEstado === 'pendiente' ? '' : 'pendiente')}>Pendiente</button>
        <button style={chipSt(filtroEstado === 'pagado')} onClick={() => setFiltroEstado(filtroEstado === 'pagado' ? '' : 'pagado')}>Pagado</button>
        <div style={{ width: 1, height: 20, background: C.border, margin: '0 4px' }} />
        {/* Obra */}
        <select value={filtroObraId} onChange={e => setFiltroObraId(e.target.value)}
          style={{ padding: '5px 8px', borderRadius: 8, border: `1.5px solid ${filtroObraId ? C.purple : C.border}`, fontSize: 12, color: filtroObraId ? C.purple : C.textMuted, background: filtroObraId ? C.purpleDim : C.surface, fontWeight: filtroObraId ? 700 : 400, cursor: 'pointer', maxWidth: 180 }}>
          <option value="">Obra: todas</option>
          {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
        </select>
        {/* Proveedor */}
        <select value={filtroProveedorId} onChange={e => setFiltroProveedorId(e.target.value)}
          style={{ padding: '5px 8px', borderRadius: 8, border: `1.5px solid ${filtroProveedorId ? C.purple : C.border}`, fontSize: 12, color: filtroProveedorId ? C.purple : C.textMuted, background: filtroProveedorId ? C.purpleDim : C.surface, fontWeight: filtroProveedorId ? 700 : 400, cursor: 'pointer', maxWidth: 180 }}>
          <option value="">Proveedor: todos</option>
          {proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
        <div style={{ width: 1, height: 20, background: C.border, margin: '0 4px' }} />
        {/* Generales */}
        <button
          onClick={() => { setFiltroGeneral(g => !g); if (!filtroGeneral) { setFiltroEstado(''); setFiltroObraId('') } }}
          style={{ padding: '5px 12px', borderRadius: 99, border: `1.5px solid ${filtroGeneral ? '#2D5FA8' : C.border}`, background: filtroGeneral ? '#EEF4FF' : C.surface, color: filtroGeneral ? '#2D5FA8' : C.textMuted, fontSize: 12, fontWeight: filtroGeneral ? 700 : 400, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: "'Outfit', sans-serif" }}>
          🏛️ Generales
        </button>
        {hasFilter && (
          <button onClick={() => { setFiltroObraId(''); setFiltroEstado(''); setFiltroProveedorId(''); setFiltroGeneral(false) }}
            style={{ padding: '5px 10px', borderRadius: 99, border: `1px solid ${C.border}`, background: 'transparent', color: C.textMuted, fontSize: 11, cursor: 'pointer' }}>
            Limpiar ✕
          </button>
        )}
      </div>
    </div>
  )
}

function PanelGastos({ obras, gastos: gastosRaw, remitosPendientes = [], loading, filtroObraId, setFiltroObraId, esAdmin, onNuevoManual, onNuevoFoto, onEditar, onPagar, onEliminar, onPagarMultiple, onAdjuntarComprobante }) {
  // Solo obras activas: las pausadas/finalizadas no muestran gastos ni totales
  const obrasActivas = obras.filter(o => o.estado === 'activa')
  const idsActivas = new Set(obrasActivas.map(o => o.id))
  const gastos = gastosRaw.filter(g => g.es_gasto_general || idsActivas.has(g.obra_id))
  // Remitos provisorios dentro del alcance (obras activas + filtro de obra si aplica)
  const enScopeDist = d => idsActivas.has(d.obra_id) && (!filtroObraId || d.obra_id === filtroObraId)
  // Ocultar select de obra cuando se ven generales (ya está manejado en filtroGeneral)
  const remitosScope = (remitosPendientes || []).filter(r => (r.comprobante_obras || []).some(enScopeDist))
  let provisorio = 0
  remitosScope.forEach(r => (r.comprobante_obras || []).forEach(d => { if (enScopeDist(d)) provisorio += parseFloat(d.monto) || 0 }))
  // Si el filtro apunta a una obra que dejó de estar activa, lo reseteamos
  useEffect(() => {
    if (filtroObraId && !obras.some(o => o.id === filtroObraId && o.estado === 'activa')) setFiltroObraId('')
  }, [filtroObraId, obras, setFiltroObraId])
  const [filtroEstadoGasto, setFiltroEstadoGasto] = useState('')
  const [filtroProveedorId, setFiltroProveedorId] = useState('')
  const [seleccion, setSeleccion] = useState(new Set())
  const toggleSel = (id) => setSeleccion(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const [filtroGeneral, setFiltroGeneral] = useState(false)
  const gastosFiltrados = gastos
    .filter(g => filtroGeneral ? !!g.es_gasto_general : !g.es_gasto_general)
    .filter(g => !filtroEstadoGasto || (filtroEstadoGasto === 'pagado' ? g.pagado : !g.pagado))
    .filter(g => !filtroProveedorId || g.proveedor_id === filtroProveedorId)
  const gastosSeleccionados = gastosFiltrados.filter(g => seleccion.has(g.id) && !g.pagado)
  const totalSeleccionado = gastosSeleccionados.reduce((s, g) => s + (g.monto || 0), 0)
  const total = gastosFiltrados.reduce((s, g) => s + (g.monto ?? 0), 0)
  const pagado = gastosFiltrados.filter(g => g.pagado).reduce((s, g) => s + (g.monto ?? 0), 0)
  // Pendiente incluye TODAS las impagas (también de obras cerradas) como aviso de deuda
  const impagas = gastosRaw.filter(g => !g.pagado && !g.es_gasto_general)
  const pendiente = impagas.reduce((s, g) => s + (g.monto ?? 0), 0)
  return (
    <div>
      <PageHeader titulo="Gastos" sub={`Total: $ ${fmt(total)}`}>
        <div style={{ display: 'flex', gap: 8 }}>
          <BtnSecondary onClick={onNuevoFoto}>📎 Comprobante</BtnSecondary>
          <BtnPrimary onClick={onNuevoManual}>+ Gasto</BtnPrimary>
        </div>
      </PageHeader>

      {(gastos.length > 0 || pendiente > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
          {[
            { label: 'Total', value: `$ ${fmt(total)}`, color: C.text },
            { label: 'Pagado', value: `$ ${fmt(pagado)}`, color: C.green },
            { label: 'Pendiente', value: `$ ${fmt(pendiente)}`, color: pendiente > 0 ? '#D0021B' : C.textFaint },
          ].map(s => (
            <div key={s.label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 14px' }}>
              <div style={{ fontSize: 10, color: C.textFaint, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{s.label}</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: s.color, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Multi-filtro: obra + estado + proveedor */}
      <GastosFiltros
        obras={obrasActivas}
        proveedores={[...new Map(gastos.filter(g=>g.proveedores).map(g=>[g.proveedor_id, g.proveedores])).values()]}
        filtroObraId={filtroObraId}
        setFiltroObraId={setFiltroObraId}
        filtroEstado={filtroEstadoGasto}
        setFiltroEstado={setFiltroEstadoGasto}
        filtroProveedorId={filtroProveedorId}
        setFiltroProveedorId={setFiltroProveedorId}
        filtroGeneral={filtroGeneral}
        setFiltroGeneral={setFiltroGeneral}
      />

      {/* Remitos provisorios (pendientes de factura) — se suman a la obra pero no son gasto confirmado */}
      {remitosScope.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.orange, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
            📋 Remitos provisorios — $ {fmt(provisorio)} <span style={{ fontWeight: 400, textTransform: 'none', color: C.textMuted }}>(pendientes de factura)</span>
          </div>
          <div style={{ background: C.orangeDim, border: `1px solid #FFDCAA`, borderRadius: 12, overflow: 'hidden' }}>
            {remitosScope.map((r, i) => {
              const partes = (r.comprobante_obras || []).filter(enScopeDist)
              const obrasNoms = partes.map(d => obras.find(o => o.id === d.obra_id)?.nombre).filter(Boolean).join(', ')
              const montoScope = partes.reduce((s, d) => s + (parseFloat(d.monto) || 0), 0)
              return (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: i < remitosScope.length - 1 ? `1px solid ${C.borderFaint}` : 'none' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                      {r.proveedores?.nombre ?? 'Sin proveedor'}
                      <span style={{ fontSize: 10, color: C.orange, background: '#fff', border: `1px solid #FFDCAA`, borderRadius: 99, padding: '1px 7px', fontWeight: 600, marginLeft: 6 }}>Remito provisorio</span>
                    </div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{obrasNoms || '—'} · {r.fecha}{r.nro_remito ? ` · ${r.nro_remito}` : ''}</div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.orange, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>$ {fmt(montoScope)}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Barra de pago múltiple flotante */}
      {esAdmin && seleccion.size > 0 && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 200, background: C.purple, color: '#fff', borderRadius: 14, padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 16, boxShadow: '0 8px 32px rgba(123,77,181,0.35)', whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{seleccion.size} seleccionado{seleccion.size > 1 ? 's' : ''} · $ {fmt(totalSeleccionado)}</span>
          <button onClick={() => { onPagarMultiple && onPagarMultiple(gastosSeleccionados); setSeleccion(new Set()) }} style={{ background: '#fff', color: C.purple, border: 'none', borderRadius: 8, padding: '7px 14px', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>💳 Pagar todos</button>
          <button onClick={() => setSeleccion(new Set())} style={{ background: 'transparent', color: 'rgba(255,255,255,0.7)', border: 'none', fontSize: 16, cursor: 'pointer', padding: 0, lineHeight: 1 }}>✕</button>
        </div>
      )}

      {loading ? <Spinner /> : gastosFiltrados.length === 0 ? (remitosScope.length === 0 ? <EmptyState texto="Sin gastos con los filtros seleccionados" /> : null) : (
        <>
          {/* MOBILE */}
          <div className="mobile-only" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {gastosFiltrados.map(g => {
              const [iconBg] = CONCEPTO_COLORS[g.concepto] ?? CONCEPTO_COLORS.varios
              return (
                <div key={g.id} style={{ background: seleccion.has(g.id) ? C.purpleDim : C.surface, border: `1.5px solid ${seleccion.has(g.id) ? C.purple : C.border}`, borderRadius: 14, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
                    {esAdmin && !g.pagado && (
                      <input type="checkbox" checked={seleccion.has(g.id)} onChange={() => toggleSel(g.id)} style={{ accentColor: C.purple, marginTop: 4, flexShrink: 0, width: 16, height: 16, cursor: 'pointer' }} />
                    )}
                    <div style={{ width: 40, height: 40, borderRadius: 12, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
                      {CONCEPTO_ICONS[g.concepto] ?? '📦'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{g.proveedores?.nombre ?? 'Sin proveedor'}</div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{g.distribucion?.length > 1 ? 'Varias obras' : (g.obras?.nombre ?? '—')} · {g.fecha}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: C.text, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>$ {fmt(g.monto)}</div>
                      <PagoBadge pagado={g.pagado} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      <ConceptoBadge concepto={g.concepto} />
                      <ComprobanteBadge tipo={g.tipo_comprobante} iva={g.discrimina_iva} />
                    </div>
                    <div style={{ display: 'flex', gap: 5 }}>
                      {esAdmin && !g.pagado && <button style={{ ...btnIconSt, color: C.green, background: C.greenDim, borderColor: '#B8E6CF', fontSize: 11, padding: '4px 8px' }} onClick={() => onPagar(g)}>$ Pagar</button>}
                      {esAdmin && g.pagado && g.pagos?.length > 0 && !g.pagos[0].comprobante_url && <button style={{ ...btnIconSt, fontSize: 11, padding: '4px 8px', color: C.textMuted }} onClick={() => onAdjuntarComprobante(g)} title="Adjuntar comprobante de pago">🧾+</button>}
                      {g.imagen_url && <a href={g.imagen_url} target="_blank" rel="noreferrer" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>📎</a>}
                      {g.pagos?.length > 0 && g.pagos[0].comprobante_url && <a href={g.pagos[0].comprobante_url} target="_blank" rel="noreferrer" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', color: C.green }}>🧾</a>}
                      <a href={waGastoLink(g)} target="_blank" rel="noreferrer" title="Enviar por WhatsApp" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', background: '#E7F9ED', borderColor: '#A8DDB5', color: '#25D366' }}><WAIcon /></a>
                      <button style={btnIconSt} onClick={() => onEditar(g)}>✏️</button>
                      <button style={{ ...btnIconSt, color: '#D0021B', background: '#FFF0F0', borderColor: '#FFDCDC' }} onClick={() => onEliminar(g)}>✕</button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* DESKTOP */}
          <div className="desktop-only" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 36 }} /><col style={{ width: 86 }} /><col style={{ width: 108 }} /><col style={{ width: 118 }} />
                <col style={{ width: 90 }} /><col style={{ width: 98 }} /><col />
                <col style={{ width: 110 }} /><col style={{ width: 72 }} /><col style={{ width: 120 }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}`, background: '#FAFAFA' }}>
                  {['','Fecha','Obra','Proveedor','Concepto','Comprobante','Descripción','Monto','Estado',''].map((h,i) => (
                    <th key={h+i} style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textAlign: h==='Monto'?'right':'left', padding: '11px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gastosFiltrados.map((g, i) => (
                  <tr key={g.id} style={{ borderBottom: i < gastos.length-1 ? `1px solid ${C.borderFaint}` : 'none', background: g.pagado ? '#FAFFFE' : C.surface }}>
                    <td style={{ ...tdSt, padding: '8px 6px', textAlign: 'center' }}>
                      {esAdmin && !g.pagado && <input type="checkbox" checked={seleccion.has(g.id)} onChange={() => toggleSel(g.id)} style={{ accentColor: C.purple, cursor: 'pointer', width: 15, height: 15 }} />}
                    </td>
                    <td style={{ ...tdSt, whiteSpace: 'nowrap', fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', fontSize: 11, color: C.textMuted }}>{g.fecha}</td>
                    <td style={tdSt}><span style={{ fontSize: 11, padding: '2px 7px', background: C.purpleDim, color: C.purple, borderRadius: 99, fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.distribucion?.length > 1 ? 'Varias obras' : (g.obras?.nombre ?? '—')}</span></td>
                    <td style={{ ...tdSt, fontWeight: 500, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.proveedores?.nombre ?? '—'}</td>
                    <td style={tdSt}><ConceptoBadge concepto={g.concepto} /></td>
                    <td style={tdSt}><ComprobanteBadge tipo={g.tipo_comprobante} iva={g.discrimina_iva} /></td>
                    <td style={{ ...tdSt, color: C.textMuted, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.descripcion}</td>
                    <td style={{ ...tdSt, textAlign: 'right', fontWeight: 700, color: C.text, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>$ {fmt(g.monto)}</td>
                    <td style={tdSt}><PagoBadge pagado={g.pagado} /></td>
                    <td style={{ ...tdSt, padding: '8px 8px' }}>
                      <div style={{ display: 'flex', gap: 3, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        {esAdmin && !g.pagado && <button style={{ ...btnIconSt, fontSize: 10, color: C.green, background: C.greenDim, borderColor: '#B8E6CF', padding: '4px 7px', whiteSpace: 'nowrap' }} onClick={() => onPagar(g)}>Pagar</button>}
                        {esAdmin && g.pagado && g.pagos?.length > 0 && !g.pagos[0].comprobante_url && <button style={{ ...btnIconSt, fontSize: 10, padding: '4px 7px', color: C.textMuted }} onClick={() => onAdjuntarComprobante(g)} title="Adjuntar comprobante de pago">🧾+</button>}
                        {g.imagen_url && <a href={g.imagen_url} target="_blank" rel="noreferrer" title="Ver factura" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>📎</a>}
                        {g.pagos?.length > 0 && g.pagos[0].comprobante_url && <a href={g.pagos[0].comprobante_url} target="_blank" rel="noreferrer" title="Comprobante pago" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', color: C.green }}>🧾</a>}
                        <a href={waGastoLink(g)} target="_blank" rel="noreferrer" title="Enviar por WhatsApp" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', background: '#E7F9ED', borderColor: '#A8DDB5', color: '#25D366' }}><WAIcon /></a>
                        <button style={btnIconSt} onClick={() => onEditar(g)}>✏️</button>
                        <button style={{ ...btnIconSt, color: '#D0021B', background: '#FFF0F0', borderColor: '#FFDCDC' }} onClick={() => onEliminar(g)}>✕</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ── Panel Informe ─────────────────────────────────────────────

// ── Panel Financiero ─────────────────────────────────────────
function PanelFinanciero({ gastos, obras }) {
  const [horizonte, setHorizonte] = useState('semana')
  const [filtroObra, setFiltroObra] = useState('')
  const hoyStr = hoy()

  const horizontes = [
    { value: 'semana', label: 'Esta semana' },
    { value: '15',     label: '15 días' },
    { value: '30',     label: '30 días' },
    { value: '60',     label: '60 días' },
    { value: 'todos',  label: 'Todos' },
  ]

  const fechaLimite = (() => {
    if (horizonte === 'todos') return '9999-12-31'
    if (horizonte === 'semana') {
      const d = new Date(hoyStr + 'T12:00:00')
      const dow = d.getDay(); const toFri = dow <= 5 ? (5 - dow) : 6
      d.setDate(d.getDate() + toFri); return d.toISOString().slice(0, 10)
    }
    const d = new Date(hoyStr + 'T12:00:00')
    d.setDate(d.getDate() + parseInt(horizonte)); return d.toISOString().slice(0, 10)
  })()

  const pendientes = gastos
    .filter(g => !g.pagado)
    .filter(g => !filtroObra || g.obra_id === filtroObra)
    .map(g => {
      const vence = calcVencimiento(g.fecha, g.condicion_pago || 'contado', g.redondear_viernes !== false)
      const dd = diasHasta(vence || hoyStr)
      return { ...g, vence: vence || hoyStr, dd }
    })
    .filter(g => g.vence <= fechaLimite)
    .sort((a, b) => a.vence.localeCompare(b.vence))

  // Agrupar por semana (lunes-viernes)
  const grupos = pendientes.reduce((acc, g) => {
    const k = g.vence; (acc[k] = acc[k] || []).push(g); return acc
  }, {})

  const totalPendiente = pendientes.reduce((s, g) => s + (g.monto || 0), 0)

  const rowSt = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '10px 0', borderBottom: `1px solid ${C.border}`, gap: 12 }
  const badgeSt = (vence) => {
    const dd = diasHasta(vence)
    const color = dd < 0 ? '#D0021B' : dd <= 3 ? C.orange : C.textMuted
    return { fontSize: 11, fontWeight: 700, color, whiteSpace: 'nowrap' }
  }

  return (
    <div>
      <PageHeader titulo="Finanzas" sub="Previsión de pagos pendientes" />

      {/* Filtros */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {horizontes.map(h => (
            <button key={h.value} onClick={() => setHorizonte(h.value)}
              style={{ padding: '6px 14px', borderRadius: 20, border: `1.5px solid ${horizonte === h.value ? C.purple : C.border}`, background: horizonte === h.value ? C.purpleDim : C.surface, color: horizonte === h.value ? C.purple : C.text, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              {h.label}
            </button>
          ))}
        </div>
        <select value={filtroObra} onChange={e => setFiltroObra(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, color: C.text, background: C.surface, cursor: 'pointer' }}>
          <option value="">Todas las obras</option>
          {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
        </select>
      </div>

      {/* Resumen */}
      <div style={{ background: C.purpleDim, border: `1.5px solid ${C.purple}20`, borderRadius: 12, padding: '14px 18px', marginBottom: 20, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 10, color: C.textFaint, fontWeight: 600, textTransform: 'uppercase', marginBottom: 4 }}>Total a pagar</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: totalPendiente > 0 ? '#D0021B' : C.text }}>{`$ ${fmt(totalPendiente)}`}</div>
          <div style={{ fontSize: 11, color: C.textMuted }}>{pendientes.length} comprobante{pendientes.length !== 1 ? 's' : ''}</div>
        </div>
        {pendientes.filter(g => g.dd !== null && g.dd < 0).length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: '#D0021B', fontWeight: 600, textTransform: 'uppercase', marginBottom: 4 }}>Vencidos</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#D0021B' }}>{`$ ${fmt(pendientes.filter(g => g.dd < 0).reduce((s,g)=>s+g.monto,0))}`}</div>
            <div style={{ fontSize: 11, color: '#D0021B' }}>{pendientes.filter(g => g.dd < 0).length} comprobante{pendientes.filter(g=>g.dd<0).length!==1?'s':''}</div>
          </div>
        )}
      </div>

      {/* Lista agrupada por fecha de vencimiento */}
      {Object.keys(grupos).length === 0 ? (
        <div style={{ textAlign: 'center', color: C.textMuted, padding: 40, fontSize: 14 }}>
          Sin pagos pendientes en este período ✓
        </div>
      ) : (
        Object.entries(grupos).map(([fecha, items]) => (
          <div key={fecha} style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.purple, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {fecha === hoyStr ? 'Hoy — ' : ''}{fecha}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{`$ ${fmt(items.reduce((s,g)=>s+g.monto,0))}`}</div>
            </div>
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
              {items.map((g, i) => (
                <div key={g.id} style={{ ...rowSt, padding: '10px 14px', borderBottom: i < items.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: C.text, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {g.proveedores?.nombre ?? 'Sin proveedor'}
                    </div>
                    <div style={{ fontSize: 11, color: C.textMuted }}>
                      {g.obras?.nombre} · {CONDICIONES_PAGO.find(c=>c.value===g.condicion_pago)?.label ?? 'Contado'}
                      {g.nro_comprobante ? ' · ' + g.nro_comprobante : ''}
                    </div>
                    {(g.proveedores?.alias_cbu || g.proveedores?.cbu) && (
                      <div style={{ fontSize: 11, color: C.purple, marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span>{g.proveedores.banco ? g.proveedores.banco + ' · ' : ''}{g.proveedores.alias_cbu || g.proveedores.cbu}</span>
                        <button onClick={() => navigator.clipboard.writeText(g.proveedores.alias_cbu || g.proveedores.cbu)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, padding: 0, color: C.textFaint }}>📋</button>
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{`$ ${fmt(g.monto)}`}</div>
                    <div style={badgeSt(g.vence)}>
                      {g.dd < 0 ? `Vencido hace ${Math.abs(g.dd)}d` : g.dd === 0 ? 'Hoy' : `En ${g.dd}d`}
                    </div>
                    {g.proveedores?.telefono && (
                      <a href={'https://wa.me/549' + g.proveedores.telefono.replace(/\D/g,'').replace(/^0/,'')} target="_blank" rel="noreferrer"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginTop: 4, fontSize: 11, color: '#25D366', textDecoration: 'none', fontWeight: 600 }}>
                        <WAIcon size={12} /> WA
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

function PanelInforme({ obras, gastos: todosGastosInforme, remitosPorObra = {}, bancos = [], esAdmin, loading }) {
  const [obraId, setObraId] = useState('')
  const exportar = () => {
    try {
      exportarExcel(obras, todosGastosInforme, bancos)
      window._toast?.('Excel generado', 'ok')
    } catch (e) {
      console.error('exportarExcel error:', e)
      window._toast?.('No se pudo generar el Excel', 'error')
    }
  }
  // Solo obras activas entran en informes y totales (las pausadas/finalizadas se excluyen)
  const obrasActivasInforme = obras.filter(o => o.estado === 'activa')
  const idsActivasInforme = new Set(obrasActivasInforme.map(o => o.id))
  // Si la obra seleccionada dejó de estar activa, volvemos a "Todas"
  const obraIdEfectivo = idsActivasInforme.has(obraId) ? obraId : ''
  // Distribución: una imputación entra al alcance si es la obra elegida, o si está en una obra activa
  const enAlcance = (im) => obraIdEfectivo ? im.obra_id === obraIdEfectivo : idsActivasInforme.has(im.obra_id)
  // gastos dentro del alcance (para listados/conteos y el gráfico)
  const gastos = todosGastosInforme.filter(g => imputaciones(g).some(enAlcance))
  // imputaciones dentro del alcance (para los montos, ya proporcionados por obra)
  const scope = []
  todosGastosInforme.forEach(g => imputaciones(g).forEach(im => { if (enAlcance(im)) scope.push({ monto: im.monto, g }) }))
  const total = scope.reduce((s, x) => s + x.monto, 0)
  const pagado = scope.filter(x => x.g.pagado).reduce((s, x) => s + x.monto, 0)
  const pendiente = scope.filter(x => !x.g.pagado).reduce((s, x) => s + x.monto, 0)
  const cantImpagas = new Set(scope.filter(x => !x.g.pagado).map(x => x.g.id)).size
  // Remitos provisorios dentro del alcance
  let provisorioInforme = 0
  Object.entries(remitosPorObra).forEach(([oid, m]) => { if (obraIdEfectivo ? oid === obraIdEfectivo : idsActivasInforme.has(oid)) provisorioInforme += m })
  const porConcepto = {}
  CONCEPTOS.forEach(c => { porConcepto[c] = scope.filter(x => (x.g.concepto || 'varios') === c).reduce((s, x) => s + x.monto, 0) })
  const maxVal = Math.max(...Object.values(porConcepto), provisorioInforme, 1)
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 22, flexWrap: 'wrap', gap: 10 }}>
        <PageTitle titulo="Informe" sub="Resumen financiero" />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={obraIdEfectivo} onChange={e => setObraId(e.target.value)} style={{ ...inputSt, width: 'auto', minWidth: 220 }}>
            <option value="">Todas las obras activas</option>
            {obrasActivasInforme.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
          </select>
          {esAdmin && <BtnSecondary onClick={exportar}>📊 Exportar a Excel</BtnSecondary>}
        </div>
      </div>
      {loading ? <Spinner /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 20 }}>
            {[
              { label: 'Total gastos',  value: `$ ${fmt(total + provisorioInforme)}`, sub: provisorioInforme > 0 ? `${gastos.length} comprob. · incl. ${fmtK(provisorioInforme)} provisorio` : `${gastos.length} comprobantes` },
              { label: 'Pagado',        value: `$ ${fmt(pagado)}`,          sub: `${total > 0 ? Math.round(pagado/total*100) : 0}%` },
              { label: 'Pendiente',     value: `$ ${fmt(pendiente)}`,       sub: `${cantImpagas} facturas`, alert: pendiente > 0 },
              { label: 'Obras activas', value: obras.filter(o => o.estado === 'activa').length, sub: `de ${obras.length} total` },
            ].map(s => (
              <div key={s.label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '16px' }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{s.label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: s.alert ? '#D0021B' : C.text, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>{s.value}</div>
                <div style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}>{s.sub}</div>
              </div>
            ))}
          </div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '18px 20px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>Desglose por rubro</div>
            {CONCEPTOS.map(c => {
              const [, color] = CONCEPTO_COLORS[c]
              return (
                <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <div style={{ width: 100, fontSize: 12, color: C.textMuted, flexShrink: 0 }}>{CONCEPTO_LABELS[c]}</div>
                  <div style={{ flex: 1, height: 4, background: C.borderFaint, borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 99, width: `${Math.round(porConcepto[c] / maxVal * 100)}%`, background: color, transition: 'width 0.5s' }} />
                  </div>
                  <div style={{ width: 96, fontSize: 12, fontWeight: 600, color: C.text, textAlign: 'right', fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', flexShrink: 0, whiteSpace: 'nowrap' }}>$ {fmt(porConcepto[c])}</div>
                </div>
              )
            })}
            {provisorioInforme > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6, paddingTop: 10, borderTop: `1px dashed ${C.border}` }}>
                <div style={{ width: 100, fontSize: 12, color: C.orange, flexShrink: 0, fontWeight: 600 }}>📋 Remitos prov.</div>
                <div style={{ flex: 1, height: 4, background: C.borderFaint, borderRadius: 99, overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 99, width: `${Math.round(provisorioInforme / maxVal * 100)}%`, background: C.orange, transition: 'width 0.5s' }} />
                </div>
                <div style={{ width: 96, fontSize: 12, fontWeight: 600, color: C.orange, textAlign: 'right', fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', flexShrink: 0, whiteSpace: 'nowrap' }}>$ {fmt(provisorioInforme)}</div>
              </div>
            )}
          </div>
          <GraficoTemporalRubros gastos={gastos} />
        </>
      )}
    </div>
  )
}

// ── Gráfico temporal por rubro ────────────────────────────────
function GraficoTemporalRubros({ gastos }) {
  const dias = {}
  gastos.forEach(g => {
    if (!g.fecha || !g.monto) return
    if (!dias[g.fecha]) dias[g.fecha] = {}
    const c = g.concepto || 'varios'
    dias[g.fecha][c] = (dias[g.fecha][c] ?? 0) + (g.monto ?? 0)
  })
  const diaKeys = Object.keys(dias).sort()
  if (diaKeys.length === 0) return null

  const maxVal = Math.max(...CONCEPTOS.flatMap(c => diaKeys.map(d => dias[d][c] ?? 0)), 1)
  const fmtY = v => v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : v >= 1000 ? `${Math.round(v/1000)}k` : String(v)
  const fmtDia = dateStr => { const [,m,d] = dateStr.split('-'); return `${d}/${m}` }

  const H = 150, PAD_L = 52, PAD_B = 28, PAD_T = 8
  const STEP = 40
  const svgW = PAD_L + (diaKeys.length - 1) * STEP + 24

  const xOf = i => PAD_L + i * STEP
  const yOf = val => PAD_T + H - (val / maxVal) * H

  const rubrosActivos = CONCEPTOS.filter(c => diaKeys.some(d => (dias[d][c] ?? 0) > 0))

  // Mostrar etiqueta cada N días para no solapar
  const cadaN = diaKeys.length <= 7 ? 1 : diaKeys.length <= 20 ? 3 : diaKeys.length <= 60 ? 7 : 14

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '18px 20px', marginTop: 14 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 }}>Evolución diaria por rubro</div>
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <svg width={Math.max(svgW, 300)} height={H + PAD_T + PAD_B} style={{ display: 'block' }}>
          {/* Líneas de referencia Y */}
          {[0, 0.25, 0.5, 0.75, 1].map(pct => {
            const y = PAD_T + H - pct * H
            return (
              <g key={pct}>
                <line x1={PAD_L} y1={y} x2={Math.max(svgW, 300) - 8} y2={y} stroke={C.border} strokeWidth={pct === 0 ? 1.5 : 0.5} strokeDasharray={pct === 0 ? '' : '3,3'} />
                {pct > 0 && <text x={PAD_L - 4} y={y + 4} textAnchor="end" fontSize={9} fill="#AAAAAA">{fmtY(maxVal * pct)}</text>}
              </g>
            )
          })}

          {/* Líneas por rubro */}
          {rubrosActivos.map(c => {
            const color = CONCEPTO_COLORS[c][1]
            const puntos = diaKeys.map((d, i) => [xOf(i), yOf(dias[d][c] ?? 0)])
            const path = puntos.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ')
            return (
              <g key={c}>
                <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {puntos.map(([x, y], i) => (
                  <circle key={i} cx={x} cy={y} r={2.5} fill={color} stroke="#fff" strokeWidth={1.5} />
                ))}
              </g>
            )
          })}

          {/* Etiquetas eje X */}
          {diaKeys.map((d, i) => {
            if (i % cadaN !== 0) return null
            return (
              <text key={d} x={xOf(i)} y={PAD_T + H + 18} textAnchor="middle" fontSize={9} fill="#888888">{fmtDia(d)}</text>
            )
          })}
        </svg>
      </div>

      {/* Leyenda */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 12 }}>
        {rubrosActivos.map(c => (
          <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 16, height: 2.5, borderRadius: 99, background: CONCEPTO_COLORS[c][1], flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: C.textMuted }}>{CONCEPTO_LABELS[c]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Panel Contactos ───────────────────────────────────────────
function PanelContactos({ clientes, proveedores, onNuevoCliente, onNuevoProveedor, onEditarCliente, onEditarProveedor, onEliminarCliente, onEliminarProveedor }) {
  const [filtroRubro, setFiltroRubro] = useState('')
  const rubros = [...new Set(proveedores.map(p => p.rubro).filter(Boolean))].sort()
  const provsFiltrados = filtroRubro ? proveedores.filter(p => p.rubro === filtroRubro) : proveedores
  const waProvLink = (p) => p.telefono ? 'https://wa.me/549' + p.telefono.replace(/\D/g, '').replace(/^0/, '') : null
  const waClienteLink = (c) => c.telefono ? 'https://wa.me/549' + c.telefono.replace(/\D/g, '').replace(/^0/, '') : null
  return (
    <div>
      <PageTitle titulo="Contactos" sub="Clientes y proveedores" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, marginTop: 20 }}>
        <ContactoCol titulo="Clientes" items={clientes} onNuevo={onNuevoCliente} onEditar={onEditarCliente} onEliminar={onEliminarCliente} btnLabel="+ Cliente"
          renderSub={c => [c.telefono, c.email].filter(Boolean).join(' · ')}
          renderWA={waClienteLink} />
        <div>
          {rubros.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {['', ...rubros].map(r => (
                <button key={r || '__todos'} onClick={() => setFiltroRubro(r)}
                  style={{ padding: '4px 10px', fontSize: 11, cursor: 'pointer', border: `1px solid ${filtroRubro === r ? C.purple : C.border}`, borderRadius: 99, background: filtroRubro === r ? C.purpleDim : C.surface, color: filtroRubro === r ? C.purple : C.textMuted, fontFamily: "'Outfit', sans-serif", fontWeight: filtroRubro === r ? 600 : 400 }}>
                  {r || 'Todos'}
                </button>
              ))}
            </div>
          )}
          <ContactoCol titulo={`Proveedores${filtroRubro ? ' · ' + filtroRubro : ''} (${provsFiltrados.length})`} items={provsFiltrados} onNuevo={onNuevoProveedor} onEditar={onEditarProveedor} onEliminar={onEliminarProveedor} btnLabel="+ Proveedor" outline
            renderSub={p => { const sit = getSituacion(p.situacion_impositiva); return [p.contacto, p.rubro, sit.label, p.cuit && 'CUIT: ' + p.cuit].filter(Boolean).join(' · ') }}
            renderBanco={p => [p.alias_cbu || p.cbu, p.banco].filter(Boolean).join(' · ') || null}
            renderNota={p => p.nota || null}
            renderWA={waProvLink} />
        </div>
      </div>
    </div>
  )
}

function ContactoCol({ titulo, items, onNuevo, onEditar, onEliminar, btnLabel, outline, renderSub, renderWA, renderNota, renderBanco }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h2 style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, margin: 0, textTransform: 'uppercase', letterSpacing: '0.09em' }}>{titulo} ({items.length})</h2>
        {onNuevo && (outline ? <BtnSecondary onClick={onNuevo}>{btnLabel}</BtnSecondary> : <BtnPrimary onClick={onNuevo}>{btnLabel}</BtnPrimary>)}
      </div>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        {items.length === 0 ? <div style={{ padding: '20px', color: C.textFaint, fontSize: 13, textAlign: 'center' }}>Sin registros</div>
        : items.map((item, i) => (
          <div key={item.id} style={{ padding: '12px 16px', borderBottom: i < items.length-1 ? `1px solid ${C.borderFaint}` : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{item.nombre}</div>
              {renderSub(item) && <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{renderSub(item)}</div>}
              {renderNota && renderNota(item) && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{renderNota(item)}</div>}
              {renderBanco && renderBanco(item) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                  <span style={{ fontSize: 11, color: C.purple, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{renderBanco(item)}</span>
                  <button title="Copiar alias/CBU" onClick={() => navigator.clipboard.writeText(item.alias_cbu || item.cbu || '')} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, padding: 0, color: C.textFaint, flexShrink: 0 }}>📋</button>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              {renderWA && renderWA(item) && <a href={renderWA(item)} target="_blank" rel="noreferrer" title="WhatsApp" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', background: '#E7F9ED', borderColor: '#A8DDB5', color: '#25D366' }}><WAIcon /></a>}
              {onEditar && <button style={btnIconSt} onClick={() => onEditar(item)}>✏️</button>}
              {onEliminar && <button style={{ ...btnIconSt, color: C.red ?? '#C62828' }} onClick={() => onEliminar(item)}>🗑️</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Panel Admin ───────────────────────────────────────────────
function PanelAdmin({ bancos, recargarListas }) {
  const [nuevoNombre, setNuevoNombre] = useState('')
  const [nuevoTipo, setNuevoTipo] = useState('banco')
  const [guardando, setGuardando] = useState(false)
  const [editando, setEditando] = useState(null)
  const [usuarios, setUsuarios] = useState([])
  const [loadingUsuarios, setLoadingUsuarios] = useState(true)
  const [obras, setObras] = useState([])
  const [asignaciones, setAsignaciones] = useState([]) // { obra_id, usuario_id }[]
  const [seccion, setSeccion] = useState('usuarios') // 'usuarios' | 'obras' | 'bancos'

  const [pendientes, setPendientes] = useState([])

  const cargarTodo = async () => {
    setLoadingUsuarios(true)
    const [resU, resO, resA] = await Promise.all([
      supabase.from('usuarios').select('*').order('nombre'),
      supabase.from('obras').select('id, nombre, estado').order('nombre'),
      supabase.from('obra_usuarios').select('*'),
    ])
    if (resU.data) setUsuarios(resU.data)
    if (resO.data) setObras(resO.data)
    if (resA.data) setAsignaciones(resA.data)

    // Buscar usuarios de auth que no tienen perfil todavía
    const { data: authUsers } = await supabase.rpc('get_auth_users_sin_perfil')
    if (authUsers) setPendientes(authUsers)

    setLoadingUsuarios(false)
  }

  useEffect(() => { cargarTodo() }, [])

  const cambiarRol = async (id, nuevoRol) => {
    await supabase.from('usuarios').update({ rol: nuevoRol }).eq('id', id)
    cargarTodo()
  }

  const toggleAsignacion = async (obraId, usuarioId) => {
    const existe = asignaciones.find(a => a.obra_id === obraId && a.usuario_id === usuarioId)
    try {
      if (existe) {
        await dbWrite('DELETE', 'obra_usuarios', null, `obra_id=eq.${obraId}&usuario_id=eq.${usuarioId}`)
      } else {
        await dbWrite('POST', 'obra_usuarios', { obra_id: obraId, usuario_id: usuarioId })
      }
    } catch(e) { window._toast?.('Error al guardar asignación: ' + e.message); return }
    cargarTodo()
  }

  const agregar = async () => {
    if (!nuevoNombre.trim()) return
    setGuardando(true)
    await supabase.from('bancos').insert([{ nombre: nuevoNombre.trim(), tipo: nuevoTipo }])
    setNuevoNombre(''); await recargarListas(); setGuardando(false)
  }

  const guardarEdicion = async () => {
    if (!editando.nombre.trim()) return
    await supabase.from('bancos').update({ nombre: editando.nombre, tipo: editando.tipo }).eq('id', editando.id)
    setEditando(null); recargarListas()
  }

  const eliminar = async (id, nombre) => {
    if (!window.confirm(`¿Eliminar "${nombre}"?`)) return
    await supabase.from('bancos').delete().eq('id', id)
    recargarListas()
  }

  const operadores = usuarios.filter(u => u.rol === 'operador')

  return (
    <div>
      <PageTitle titulo="Administración" sub="Configuración del sistema" />

      {/* Tabs de sección */}
      <div style={{ display: 'flex', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden', margin: '20px 0 24px', width: 'fit-content' }}>
        {[
          { id: 'usuarios', label: '👤 Usuarios' },
          { id: 'obras',    label: '🏗️ Asignar obras' },
          { id: 'bancos',   label: '🏦 Bancos' },
        ].map(s => (
          <button key={s.id} onClick={() => setSeccion(s.id)} style={{ padding: '7px 18px', fontSize: 13, cursor: 'pointer', border: 'none', borderRight: `1px solid ${C.border}`, fontFamily: "'Outfit', sans-serif", fontWeight: seccion === s.id ? 600 : 400, background: seccion === s.id ? C.purpleDim : C.surface, color: seccion === s.id ? C.purple : C.textMuted }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* USUARIOS */}
      {seccion === 'usuarios' && (
        <div style={{ maxWidth: 560 }}>

          {/* PENDIENTES */}
          {pendientes.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: C.orange, textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 12 }}>
                ⏳ Usuarios pendientes de aprobación ({pendientes.length})
              </div>
              <div style={{ background: C.surface, border: `1px solid #FFDCAA`, borderRadius: 12, overflow: 'hidden' }}>
                {pendientes.map((u, i) => (
                  <div key={u.id} style={{ padding: '12px 16px', borderBottom: i < pendientes.length - 1 ? `1px solid ${C.borderFaint}` : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{u.nombre}</div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{u.email}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={async () => {
                        await supabase.from('usuarios').insert([{ id: u.id, nombre: u.nombre, rol: 'operador' }])
                        cargarTodo()
                      }} style={{ padding: '5px 12px', background: C.greenDim, color: C.green, border: `1px solid #B8E6CF`, borderRadius: 7, fontSize: 12, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        ✓ Aprobar
                      </button>
                      <button onClick={async () => {
                        if (!window.confirm(`¿Rechazar a ${u.nombre}? Se eliminará su cuenta.`)) return
                        await supabase.auth.admin.deleteUser(u.id)
                        cargarTodo()
                      }} style={{ padding: '5px 10px', background: '#FFF0F0', color: '#D0021B', border: '1px solid #FFDCDC', borderRadius: 7, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* USUARIOS ACTIVOS */}
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 12 }}>Usuarios activos</div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
            {loadingUsuarios ? <div style={{ padding: '16px', color: C.textFaint, fontSize: 13, textAlign: 'center' }}>Cargando...</div>
            : usuarios.length === 0 ? <div style={{ padding: '16px', color: C.textFaint, fontSize: 13, textAlign: 'center' }}>Sin usuarios</div>
            : usuarios.map((u, i) => (
              <div key={u.id} style={{ padding: '12px 16px', borderBottom: i < usuarios.length - 1 ? `1px solid ${C.borderFaint}` : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{u.nombre}</div>
                  <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>{u.id.slice(0, 16)}...</div>
                </div>
                <select value={u.rol} onChange={e => cambiarRol(u.id, e.target.value)} style={{ ...inputSt, width: 130, padding: '5px 10px', fontSize: 12 }}>
                  <option value="operador">Operador</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ASIGNAR OBRAS */}
      {seccion === 'obras' && (
        <div style={{ maxWidth: 640 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 12 }}>Asignación de obras por operador</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>Los admins ven todas las obras. Seleccioná qué obras ve cada operador.</div>
          {operadores.length === 0 ? (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '20px', color: C.textFaint, fontSize: 13, textAlign: 'center' }}>No hay operadores registrados</div>
          ) : operadores.map(u => (
            <div key={u.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
              <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, background: C.purpleDim }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.purple }}>{u.nombre}</div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                  {asignaciones.filter(a => a.usuario_id === u.id).length} obra{asignaciones.filter(a => a.usuario_id === u.id).length !== 1 ? 's' : ''} asignada{asignaciones.filter(a => a.usuario_id === u.id).length !== 1 ? 's' : ''}
                </div>
              </div>
              <div style={{ padding: '8px 0' }}>
                {obras.map(o => {
                  const asignada = asignaciones.some(a => a.obra_id === o.id && a.usuario_id === u.id)
                  return (
                    <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={asignada} onChange={() => toggleAsignacion(o.id, u.id)} style={{ width: 16, height: 16, accentColor: C.purple, flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 13, color: C.text, fontWeight: asignada ? 600 : 400 }}>{o.nombre}</span>
                        <EstadoBadge estado={o.estado} />
                      </div>
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* BANCOS */}
      {seccion === 'bancos' && (
        <div style={{ maxWidth: 520 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 12 }}>Bancos y billeteras</div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
            {bancos.length === 0 && <div style={{ padding: '16px', color: C.textFaint, fontSize: 13, textAlign: 'center' }}>Sin bancos registrados</div>}
            {bancos.map((b, i) => (
              <div key={b.id} style={{ padding: '10px 14px', borderBottom: i < bancos.length - 1 ? `1px solid ${C.borderFaint}` : 'none' }}>
                {editando?.id === b.id ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input style={{ ...inputSt, flex: 1 }} value={editando.nombre} onChange={e => setEditando(ed => ({ ...ed, nombre: e.target.value }))} autoFocus />
                    <select style={{ ...inputSt, width: 110 }} value={editando.tipo} onChange={e => setEditando(ed => ({ ...ed, tipo: e.target.value }))}>
                      <option value="banco">Banco</option>
                      <option value="billetera">Billetera</option>
                    </select>
                    <button onClick={guardarEdicion} style={{ padding: '7px 12px', background: C.purple, color: '#fff', border: 'none', borderRadius: 7, fontSize: 12, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>✓</button>
                    <button onClick={() => setEditando(null)} style={{ padding: '7px 10px', background: 'transparent', color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 12, cursor: 'pointer' }}>✕</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                      <span style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>{b.nombre}</span>
                      <span style={{ fontSize: 10, color: C.textFaint, background: C.borderFaint, padding: '2px 8px', borderRadius: 99, fontWeight: 600 }}>{b.tipo}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => setEditando({ id: b.id, nombre: b.nombre, tipo: b.tipo })} style={{ padding: '4px 8px', background: C.purpleDim, color: C.purple, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, cursor: 'pointer', fontWeight: 500 }}>✏️</button>
                      <button onClick={() => eliminar(b.id, b.nombre)} style={{ padding: '4px 8px', background: '#FFF0F0', color: '#D0021B', border: '1px solid #FFDCDC', borderRadius: 6, fontSize: 11, cursor: 'pointer', fontWeight: 500 }}>✕</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={{ ...inputSt, flex: 1 }} value={nuevoNombre} onChange={e => setNuevoNombre(e.target.value)} placeholder="Nombre del banco / billetera" onKeyDown={e => e.key === 'Enter' && agregar()} />
            <select style={{ ...inputSt, width: 120 }} value={nuevoTipo} onChange={e => setNuevoTipo(e.target.value)}>
              <option value="banco">Banco</option>
              <option value="billetera">Billetera</option>
            </select>
            <BtnPrimary onClick={agregar}>{guardando ? '...' : '+ Agregar'}</BtnPrimary>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Modales ───────────────────────────────────────────────────
function ModalGasto({ itemEdit, obras, proveedores, obraIdDefecto, onClose, onGuardar, onNuevoProveedor }) {
  const [form, setForm] = useState(itemEdit || { obra_id: obraIdDefecto || obras[0]?.id || '', fecha: hoy(), proveedor_id: '', concepto: 'materiales', monto: '', descripcion: '', tipo_comprobante: 'factura_a', discrimina_iva: true, nro_comprobante: '', a_nombre_seate: true, iva_monto: 0, es_gasto_general: false })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return <Modal title={itemEdit ? 'Editar Gasto' : 'Registrar Gasto'} onClose={onClose} onGuardar={() => onGuardar(form)}><FormGasto form={form} set={set} obras={obras} proveedores={proveedores} onNuevoProveedor={onNuevoProveedor} /></Modal>
}

// ── Helpers de archivo (compresión de imágenes antes de subir) ──
function leerBase64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onerror = rej; r.onload = e => res(String(e.target.result).split(',')[1]); r.readAsDataURL(file) })
}

// Redimensiona la imagen (lado largo máx) y devuelve el canvas listo para exportar.
// Reduce drásticamente el peso → más rápido en mobile y menos timeouts. La IA no pierde
// precisión porque igual reescala internamente a ~1568px.
async function _canvasComprimido(file, maxLado = 1600) {
  const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onerror = rej; r.onload = e => res(e.target.result); r.readAsDataURL(file) })
  const img = await new Promise((res, rej) => { const i = new Image(); i.onerror = rej; i.onload = () => res(i); i.src = dataUrl })
  let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height
  if (w > maxLado || h > maxLado) {
    if (w >= h) { h = Math.round(h * maxLado / w); w = maxLado }
    else { w = Math.round(w * maxLado / h); h = maxLado }
  }
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  canvas.getContext('2d').drawImage(img, 0, 0, w, h)
  return canvas
}

// Para enviar a la IA (base64)
async function comprimirImagen(file, maxLado = 1600, calidad = 0.7) {
  const canvas = await _canvasComprimido(file, maxLado)
  return { base64: canvas.toDataURL('image/jpeg', calidad).split(',')[1], mimeType: 'image/jpeg' }
}

// Para subir al storage (Blob)
async function comprimirImagenBlob(file, maxLado = 1600, calidad = 0.7) {
  const canvas = await _canvasComprimido(file, maxLado)
  return await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/jpeg', calidad))
}

function ModalFoto({ obras, proveedores, obraIdDefecto, onClose, onGuardar, onNuevoProveedor }) {
  const [step, setStep] = useState('upload')
  const [form, setForm] = useState({ obra_id: obraIdDefecto || obras[0]?.id || '', fecha: hoy(), proveedor_id: '', concepto: 'materiales', monto: '', descripcion: '', imagen_url: '', tipo_comprobante: 'factura_a', discrimina_iva: true, nro_comprobante: '', a_nombre_seate: false, iva_monto: 0, distribucion: [], condicion_pago: 'contado', redondear_viernes: true, es_gasto_general: false })
  const [preview, setPreview] = useState(null)
  const [currentFile, setCurrentFile] = useState(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const procesarFoto = async (file) => {
    setPreview(URL.createObjectURL(file)); setCurrentFile(file); setStep('loading')
    let imageUrl = ''
    try {
      // 1. Preparar archivo: comprimir imágenes (más rápido en mobile, evita timeouts).
      //    PDF se manda tal cual, con tope de tamaño para no pegar contra los límites.
      let base64, mimeType
      if (file.type === 'application/pdf') {
        if (file.size > 25 * 1024 * 1024) { window._toast?.('El PDF es muy pesado (máx ~25 MB). Subí uno más liviano.'); setStep('upload'); return }
        base64 = await leerBase64(file)
        mimeType = 'application/pdf'
      } else {
        try { ({ base64, mimeType } = await comprimirImagen(file)) }
        catch { base64 = await leerBase64(file); mimeType = file.type }   // si falla la compresión, mandamos el original
      }

      // 2. La subida al storage la hace la Edge Function (server-to-server, confiable en mobile)
      //    y nos devuelve la URL en la respuesta. Ya NO subimos directo desde el cliente,
      //    porque en mobile esa subida directa se colgaba y trababa toda la pantalla.

      // 3. IA + subida de imagen en la Edge Function, con timeout de 30s
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
      const fnUrl = 'https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante'
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
      const respRaw = await Promise.race([
        fetch(fnUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}` }, body: JSON.stringify({ base64, mimeType, hoy: hoy() }) }),
        timeout
      ])
      const data = await respRaw.json()
      const error = !respRaw.ok ? data : null
      imageUrl = data?.imagen_url || ''   // la Edge Function ya subió la imagen y devolvió la URL
      if (!error && data?.content) {
        const text = data.content.map(i => i.text || '').join('')
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
        const nombreIA = parsed.proveedor || ''
        const matchProv = proveedores.find(p => p.nombre.toLowerCase().includes(nombreIA.toLowerCase()))
        // Tipo: primero lo que dice el documento, si no inferir del proveedor
        let tipo = parsed.tipo_comprobante || null
        let iva = tipo ? (TIPOS_COMPROBANTE.find(t => t.value === tipo)?.iva ?? true) : true
        if (!tipo && matchProv) { const sit = getSituacion(matchProv.situacion_impositiva); tipo = sit.comprobante; iva = sit.iva }
        if (!tipo) { tipo = 'factura_a'; iva = true }
        // Inferir situación impositiva del proveedor según la letra del comprobante
        const sitIA = tipo === 'factura_c' ? 'monotributo' : (tipo === 'factura_a' || tipo === 'factura_b') ? 'responsable_inscripto' : null
        // Crédito fiscal: SOLO Factura A a nombre de SEATE. Comparación de CUIT sin guiones/puntos.
        const soloDigitos = v => String(v ?? '').replace(/\D/g, '')
        const seateCuit = soloDigitos(SEATE_CUIT)
        let aNombreSeate = false
        if (tipo === 'factura_a') {
          const cuitRec = soloDigitos(parsed.cuit_receptor)
          const recNombre = String(parsed.receptor || '').toLowerCase()
          if (cuitRec === seateCuit || recNombre.includes(SEATE_NOMBRE.toLowerCase())) {
            aNombreSeate = true                       // detectado a nombre de SEATE
          } else if (cuitRec || recNombre) {
            aNombreSeate = false                      // detectó otro receptor → no computa
          } else {
            // No se pudo leer el receptor: preguntar al usuario
            aNombreSeate = window.confirm('No se pudo leer a nombre de quién está la Factura A.\n\n¿Está a nombre de SEATE S.R.L. (CUIT 30715138022)?\n\nAceptar = Sí (computa crédito fiscal)\nCancelar = No')
          }
        }
        const ivaMonto = parseFloat(parsed.iva_monto) || 0
        setForm(f => ({ ...f, fecha: parsed.fecha || hoy(), proveedor_id: matchProv ? matchProv.id : '', concepto: parsed.concepto || 'varios', monto: parsed.monto || '', nro_comprobante: parsed.nro_comprobante || '', descripcion: (parsed.descripcion || '') + (nombreIA && !matchProv ? ` (IA detectó prov: ${nombreIA})` : ''), imagen_url: imageUrl, tipo_comprobante: tipo, discrimina_iva: iva, a_nombre_seate: aNombreSeate, iva_monto: ivaMonto }))
        if (nombreIA && !matchProv) onNuevoProveedor && onNuevoProveedor(nombreIA, (np) => { if (!np?.id) return; const sit = getSituacion(np.situacion_impositiva); setForm(f => ({ ...f, proveedor_id: np.id, tipo_comprobante: sit.comprobante, discrimina_iva: sit.iva, descripcion: parsed.descripcion || '' })) }, parsed.cuit || null, sitIA)
      } else {
        setForm(f => ({ ...f, imagen_url: imageUrl }))
        if (error) window._toast?.('IA no disponible — completá los datos manualmente')
      }
    } catch (e) {
      console.error('procesarFoto error:', e)
      setForm(f => ({ ...f, imagen_url: imageUrl }))
      window._toast?.(e?.message === 'timeout' ? 'IA tardó demasiado — completá los datos manualmente' : 'Error al analizar la imagen — completá los datos manualmente')
    } finally {
      setStep('review')
    }
  }

  return (
    <Modal title="Cargar comprobante" onClose={onClose} onGuardar={step === 'review' ? () => onGuardar({ ...form, proveedor_id: form.proveedor_id || null, monto: parseFloat(form.monto) || 0 }) : null} guardarLabel="Guardar gasto">
      {step === 'upload' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, border: `1.5px solid ${C.purple}`, borderRadius: 12, padding: '18px 24px', textAlign: 'center', cursor: 'pointer', background: C.purpleDim }}>
            <span style={{ fontSize: 24 }}>📸</span>
            <div>
              <div style={{ fontSize: 14, color: C.purple, fontWeight: 600 }}>Tomar foto con cámara</div>
              <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>Abre la cámara directamente</div>
            </div>
            <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => e.target.files[0] && procesarFoto(e.target.files[0])} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, border: `1.5px dashed ${C.border}`, borderRadius: 12, padding: '18px 24px', textAlign: 'center', cursor: 'pointer', background: '#FAFAFA' }}>
            <span style={{ fontSize: 24 }}>🖼️📄</span>
            <div>
              <div style={{ fontSize: 14, color: C.textMuted, fontWeight: 500 }}>Elegir foto o PDF</div>
              <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>Imagen o PDF del comprobante</div>
            </div>
            <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => e.target.files[0] && procesarFoto(e.target.files[0])} />
          </label>
        </div>
      )}
      {step === 'loading' && (
        <div style={{ textAlign: 'center', padding: '32px 0' }}>
          {preview && (currentFile?.type === 'application/pdf'
            ? <div style={{ fontSize: 48, marginBottom: 16 }}>📄</div>
            : <img src={preview} alt="" style={{ maxHeight: 120, borderRadius: 8, marginBottom: 16, opacity: 0.6 }} />
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <div style={{ width: 16, height: 16, border: `2px solid ${C.purple}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <span style={{ fontSize: 13, color: C.textMuted }}>Analizando con IA...</span>
          </div>
        </div>
      )}
      {step === 'review' && (
        <div>
          {preview && <img src={preview} alt="" style={{ maxHeight: 80, borderRadius: 6, marginBottom: 12, display: 'block' }} />}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', background: C.purpleDim, color: C.purple, fontSize: 11, borderRadius: 99, marginBottom: 14, fontWeight: 600 }}>✨ Revisá los datos antes de guardar</div>
          <FormGasto form={form} set={set} obras={obras} proveedores={proveedores} onNuevoProveedor={onNuevoProveedor} />
        </div>
      )}
    </Modal>
  )
}

function ModalAltaProveedor({ datosIniciales, onClose, onGuardar, zIndex }) {
  const [form, setForm] = useState({ nombre: datosIniciales?.nombre || '', cuit: datosIniciales?.cuit || '', rubro: '', situacion_impositiva: datosIniciales?.situacion_impositiva || 'responsable_inscripto', telefono: '', contacto: '', nota: '', cbu: '', alias_cbu: '', banco: '', titular_cuenta: '' })
  const [saving, setSaving] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const sit = getSituacion(form.situacion_impositiva)

  const handleGuardar = async () => {
    if (!form.nombre?.trim()) { setErrorMsg('El nombre es obligatorio'); return }
    setSaving(true); setErrorMsg('')
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Sin respuesta del servidor. Verificá tu conexión e intentá de nuevo.')), 12000))
      await Promise.race([onGuardar(form), timeout])
    } catch (e) {
      setErrorMsg(e?.message || 'Error al guardar')
      setSaving(false)
    }
  }

  return (
    <Modal title="Dar de alta proveedor" onClose={onClose} onGuardar={handleGuardar} guardarLabel={saving ? 'Guardando...' : 'Dar de alta'} zIndex={zIndex}>
      <div style={{ background: C.purpleDim, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: C.purple }}><strong>Proveedor detectado por IA</strong> — completá los datos fiscales.</div>
      {errorMsg && <div style={{ background: '#FFF0F0', border: '1px solid #FFDCDC', color: '#D0021B', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 12, fontWeight: 500 }}>⚠ {errorMsg}</div>}
      <Campo label="Nombre / Razón Social" style={{ marginBottom: 10 }}><input style={inputSt} value={form.nombre} onChange={e => set('nombre', e.target.value)} /></Campo>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <Campo label="CUIT / RUT"><input style={inputSt} value={form.cuit} onChange={e => set('cuit', e.target.value)} placeholder="Sin guiones" /></Campo>
        <Campo label="Rubro"><select style={inputSt} value={form.rubro} onChange={e => set('rubro', e.target.value)}><option value="">— Seleccionar —</option>{RUBROS.map(r => <option key={r} value={r}>{r}</option>)}</select></Campo>
      </div>
      <Campo label="Situación impositiva" style={{ marginBottom: 12 }}><select style={inputSt} value={form.situacion_impositiva} onChange={e => set('situacion_impositiva', e.target.value)}>{SITUACIONES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Campo>
      <div style={{ background: '#F9F9F9', border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
        <div style={{ color: C.textFaint, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Se sugerirá automáticamente</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontWeight: 600, color: C.text }}>{getTipoLabel(sit.comprobante)}</span>
          <span style={{ fontSize: 11, color: sit.iva ? C.green : C.textMuted, background: sit.iva ? C.greenDim : '#F3F3F3', padding: '2px 8px', borderRadius: 99, fontWeight: 600 }}>{sit.iva ? 'Discrimina IVA' : 'Sin IVA'}</span>
        </div>
      </div>
    </Modal>
  )
}

function ModalObra({ itemEdit, clientes, onClose, onGuardar }) {
  const [form, setForm] = useState(itemEdit || { nombre: '', cliente_id: '', estado: 'activa', presupuesto: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <Modal title={itemEdit ? 'Editar Obra' : 'Nueva Obra'} onClose={onClose} onGuardar={() => onGuardar(form)}>
      <Campo label="Nombre de la obra"><input style={inputSt} value={form.nombre} onChange={e => set('nombre', e.target.value)} placeholder="Ej: Edificio Tucumán 1420" /></Campo>
      <div style={{ marginTop: 10 }}><Campo label="Cliente"><select style={inputSt} value={form.cliente_id || ''} onChange={e => set('cliente_id', e.target.value)}><option value="">Sin cliente</option>{clientes?.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></Campo></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
        <Campo label="Presupuesto"><input style={inputSt} type="number" value={form.presupuesto} onChange={e => set('presupuesto', e.target.value)} placeholder="0" /></Campo>
        <Campo label="Estado"><select style={inputSt} value={form.estado} onChange={e => set('estado', e.target.value)}>{['activa','pausada','finalizada'].map(v => <option key={v} value={v}>{v.charAt(0).toUpperCase()+v.slice(1)}</option>)}</select></Campo>
      </div>
    </Modal>
  )
}

function ModalCliente({ itemEdit, onClose, onGuardar }) {
  const [form, setForm] = useState(itemEdit || { nombre: '', telefono: '', email: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <Modal title={itemEdit ? 'Editar Cliente' : 'Nuevo Cliente'} onClose={onClose} onGuardar={() => onGuardar(form)} guardarLabel={itemEdit ? 'Actualizar' : 'Guardar'}>
      <Campo label="Nombre / Razón Social"><input style={inputSt} value={form.nombre} onChange={e => set('nombre', e.target.value)} /></Campo>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
        <Campo label="Teléfono"><input style={inputSt} value={form.telefono || ''} onChange={e => set('telefono', e.target.value)} /></Campo>
        <Campo label="Email"><input style={inputSt} type="email" value={form.email || ''} onChange={e => set('email', e.target.value)} /></Campo>
      </div>
    </Modal>
  )
}

function ModalProveedor({ itemEdit, onClose, onGuardar }) {
  const [form, setForm] = useState(itemEdit || { nombre: '', cuit: '', rubro: '', situacion_impositiva: 'responsable_inscripto', telefono: '', contacto: '', nota: '', cbu: '', alias_cbu: '', banco: '', titular_cuenta: '', condicion_pago: 'contado', redondear_viernes: true })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const sit = getSituacion(form.situacion_impositiva)
  return (
    <Modal title={itemEdit ? 'Editar Proveedor' : 'Nuevo Proveedor'} onClose={onClose} onGuardar={() => onGuardar(form)} guardarLabel={itemEdit ? 'Actualizar' : 'Guardar'}>
      <Campo label="Nombre / Razón Social"><input style={inputSt} value={form.nombre} onChange={e => set('nombre', e.target.value)} /></Campo>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
        <Campo label="CUIT / RUT"><input style={inputSt} value={form.cuit || ''} onChange={e => set('cuit', e.target.value)} /></Campo>
        <Campo label="Rubro"><select style={inputSt} value={form.rubro || ''} onChange={e => set('rubro', e.target.value)}><option value="">— Seleccionar —</option>{RUBROS.map(r => <option key={r} value={r}>{r}</option>)}</select></Campo>
      </div>
      <div style={{ marginTop: 10 }}><Campo label="Situación impositiva"><select style={inputSt} value={form.situacion_impositiva} onChange={e => set('situacion_impositiva', e.target.value)}>{SITUACIONES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Campo></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
        <Campo label="Teléfono WhatsApp"><input style={inputSt} value={form.telefono || ''} onChange={e => set('telefono', e.target.value)} placeholder="Ej: 3764123456" /></Campo>
        <Campo label="Persona de contacto"><input style={inputSt} value={form.contacto || ''} onChange={e => set('contacto', e.target.value)} placeholder="Nombre" /></Campo>
      </div>
      <div style={{ marginTop: 10 }}><Campo label="Notas"><input style={inputSt} value={form.nota || ''} onChange={e => set('nota', e.target.value)} placeholder="Observaciones, condiciones, etc." /></Campo></div>
      <div style={{ marginTop: 10 }}>
        <Campo label="Condición de pago habitual">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select style={{ ...inputSt, flex: 1 }} value={form.condicion_pago || 'contado'} onChange={e => set('condicion_pago', e.target.value)}>
              {CONDICIONES_PAGO.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            {form.condicion_pago !== 'contado' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: C.textMuted, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={!!form.redondear_viernes} onChange={e => set('redondear_viernes', e.target.checked)} style={{ accentColor: C.purple }} />
                Al viernes
              </label>
            )}
          </div>
        </Campo>
      </div>
      <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 10 }}>Datos bancarios</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <Campo label="CBU"><input style={inputSt} value={form.cbu || ''} onChange={e => set('cbu', e.target.value)} placeholder="22 dígitos" /></Campo>
          <Campo label="Alias CBU"><input style={inputSt} value={form.alias_cbu || ''} onChange={e => set('alias_cbu', e.target.value)} placeholder="Ej: proveedor.banco" /></Campo>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Campo label="Banco"><input style={inputSt} value={form.banco || ''} onChange={e => set('banco', e.target.value)} placeholder="Ej: Galicia" /></Campo>
          <Campo label="Titular de la cuenta"><input style={inputSt} value={form.titular_cuenta || ''} onChange={e => set('titular_cuenta', e.target.value)} placeholder="Nombre o razón social" /></Campo>
        </div>
      </div>
      <div style={{ background: '#F9F9F9', border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', fontSize: 12, marginTop: 12 }}>
        <div style={{ color: C.textFaint, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Comprobante sugerido</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontWeight: 600, color: C.text }}>{getTipoLabel(sit.comprobante)}</span>
          <span style={{ fontSize: 11, color: sit.iva ? C.green : C.textMuted, background: sit.iva ? C.greenDim : '#F3F3F3', padding: '2px 8px', borderRadius: 99, fontWeight: 600 }}>{sit.iva ? 'Discrimina IVA' : 'Sin IVA'}</span>
        </div>
      </div>
    </Modal>
  )
}

// ── Modal Pago ────────────────────────────────────────────────
function ModalPago({ gasto, bancos, onClose, onGuardar }) {
  const [form, setForm] = useState({ fecha_pago: hoy(), medio_pago: 'transferencia', monto: gasto?.monto ?? '', banco_id: '', nro_operacion: '', titular_tarjeta: '', observaciones: '', comprobante_url: '' })
  const [archivoNombre, setArchivoNombre] = useState('')
  const [subiendo, setSubiendo] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const necesitaBanco = ['transferencia', 'cheque', 'tarjeta'].includes(form.medio_pago)

  const subirComprobante = async (file) => {
    setSubiendo(true)
    try {
      // Validar sesión — con timeout para no trabar en mobile si la red es lenta
      try {
        const sesionP = supabase.auth.getSession().then(r => r.data?.session)
        const sesion = await Promise.race([sesionP, new Promise(r => setTimeout(() => r('timeout'), 3000))])
        if (!sesion) {
          // Sin sesión: intentar refresh (también con timeout)
          const refreshP = supabase.auth.refreshSession().then(r => r.data?.session)
          const refreshed = await Promise.race([refreshP, new Promise(r => setTimeout(() => r('timeout'), 3000))])
          if (!refreshed && refreshed !== 'timeout') {
            window._toast?.('La sesión expiró. Cerrá sesión y volvé a ingresar para subir archivos.')
            setSubiendo(false)
            return
          }
        }
      } catch { /* si falla el check, intentamos subir igual y el error del upload lo maneja el bloque siguiente */ }

      let blob = file, ext = (file.name.split('.').pop() || 'jpg')
      if (file.type === 'application/pdf') {
        if (file.size > 25 * 1024 * 1024) { window._toast?.('El PDF es muy pesado (máx ~25 MB).'); setSubiendo(false); return }
      } else {
        try { blob = await comprimirImagenBlob(file); ext = 'jpg' } catch { /* si falla, sube el original */ }
      }
      const path = `pagos/${Date.now()}.${ext}`
      // Timeout: en mobile la subida directa puede colgarse; así no traba el modal
      const subir = supabase.storage.from('comprobantes-pagos').upload(path, blob)
      const res = await Promise.race([subir, new Promise(r => setTimeout(() => r({ _timeout: true }), 15000))])
      if (res?._timeout) { window._toast?.('La subida tardó demasiado. Confirmá el pago e intentá adjuntar después.'); setSubiendo(false); return }
      if (res?.error) {
        const esAuth = res.error.statusCode === '401' || res.error.statusCode === 401 || res.error.message?.toLowerCase().includes('jwt') || res.error.message?.toLowerCase().includes('auth')
        const msg = esAuth
          ? 'Sesión expirada. Cerrá sesión y volvé a ingresar para subir archivos.'
          : 'No se pudo subir el comprobante'
        console.error('Error al subir:', res.error.message); window._toast?.(msg); setSubiendo(false); return
      }
      const url = supabase.storage.from('comprobantes-pagos').getPublicUrl(path).data.publicUrl
      set('comprobante_url', url); setArchivoNombre(file.name)
    } catch (e) {
      console.error('subirComprobante:', e); window._toast?.('No se pudo subir el comprobante')
    } finally {
      setSubiendo(false)
    }
  }

  const [verMas, setVerMas] = useState(false)
  const venc = calcVencimiento(gasto?.fecha, gasto?.condicion_pago, gasto?.redondear_viernes !== false)

  return (
    <Modal title={`Registrar pago — $ ${fmt(gasto?.monto)}`} onClose={onClose} onGuardar={() => onGuardar({ ...form, monto: parseFloat(form.monto) || 0, banco_id: form.banco_id || null })} guardarLabel="Confirmar pago">
      <div style={{ background: C.purpleDim, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 12 }}>
        {/* Fila principal: proveedor + WA */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 700, color: C.text, marginBottom: 3, fontSize: 13 }}>{gasto?.proveedores?.nombre ?? 'Sin proveedor'}</div>
            <div style={{ color: C.textMuted, display: 'flex', flexWrap: 'wrap', gap: '2px 8px', lineHeight: 1.6 }}>
              <span>{gasto?.obras?.nombre ?? '—'}</span>
              <span>·</span>
              <span>{gasto?.fecha}</span>
              <span>·</span>
              <span>{getTipoLabel(gasto?.tipo_comprobante)}</span>
              {gasto?.nro_comprobante && <><span>·</span><span style={{ fontWeight: 600, color: C.text }}>Nº {gasto.nro_comprobante}</span></>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
            {gasto?.proveedores?.telefono && (
              <a href={'https://wa.me/549' + gasto.proveedores.telefono.replace(/\D/g,'').replace(/^0/,'')} target="_blank" rel="noreferrer"
                title="WhatsApp del proveedor"
                style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', background: '#E7F9ED', borderColor: '#A8DDB5', color: '#25D366' }}>
                <WAIcon />
              </a>
            )}
            <button onClick={() => setVerMas(v => !v)}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, color: C.purple, fontWeight: 600, padding: '2px 4px', fontFamily: "'Outfit', sans-serif" }}>
              {verMas ? 'ver menos ▲' : 'ver más ▼'}
            </button>
          </div>
        </div>

        {/* Panel expandible */}
        {verMas && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 11 }}>
            {gasto?.concepto && <div><span style={{ color: C.textFaint, fontWeight: 600 }}>Concepto: </span><span style={{ color: C.text }}>{CONCEPTO_LABELS[gasto.concepto] ?? gasto.concepto}</span></div>}
            {gasto?.condicion_pago && gasto.condicion_pago !== 'contado' && <div><span style={{ color: C.textFaint, fontWeight: 600 }}>Condición: </span><span style={{ color: C.text }}>{CONDICIONES_PAGO.find(c => c.value === gasto.condicion_pago)?.label ?? gasto.condicion_pago}</span></div>}
            {venc && gasto?.condicion_pago !== 'contado' && <div><span style={{ color: C.textFaint, fontWeight: 600 }}>Vencimiento: </span><span style={{ color: C.text, fontWeight: 600 }}>{venc}</span></div>}
            {gasto?.descripcion && <div style={{ gridColumn: '1/-1' }}><span style={{ color: C.textFaint, fontWeight: 600 }}>Descripción: </span><span style={{ color: C.text }}>{gasto.descripcion}</span></div>}
            {gasto?.imagen_url && <div style={{ gridColumn: '1/-1' }}><a href={gasto.imagen_url} target="_blank" rel="noreferrer" style={{ color: C.purple, fontWeight: 600, fontSize: 11 }}>📎 Ver comprobante original</a></div>}
          </div>
        )}

        {/* Datos bancarios — siempre visibles */}
        {(gasto?.proveedores?.alias_cbu || gasto?.proveedores?.cbu) && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: C.textFaint, fontWeight: 600 }}>DATOS BANCARIOS</span>
            {gasto.proveedores.banco && <span style={{ fontSize: 12, color: C.text }}>{gasto.proveedores.banco}</span>}
            {gasto.proveedores.titular_cuenta && <span style={{ fontSize: 12, color: C.textMuted }}>{gasto.proveedores.titular_cuenta}</span>}
            {(gasto.proveedores.alias_cbu || gasto.proveedores.cbu) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 12, color: C.purple, fontWeight: 700 }}>{gasto.proveedores.alias_cbu || gasto.proveedores.cbu}</span>
                <button title="Copiar" onClick={() => navigator.clipboard.writeText(gasto.proveedores.alias_cbu || gasto.proveedores.cbu)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, padding: 0, color: C.textFaint }}>📋</button>
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Campo label="Fecha de pago"><input style={inputSt} type="date" value={form.fecha_pago} onChange={e => set('fecha_pago', e.target.value)} /></Campo>
        <Campo label="Monto pagado"><input style={inputSt} type="number" value={form.monto} onChange={e => set('monto', e.target.value)} /></Campo>
        <Campo label="Medio de pago" style={{ gridColumn: '1/-1' }}>
          <select style={inputSt} value={form.medio_pago} onChange={e => set('medio_pago', e.target.value)}>
            {MEDIOS_PAGO.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Campo>
        {necesitaBanco && <Campo label="Banco" style={{ gridColumn: '1/-1' }}><select style={inputSt} value={form.banco_id} onChange={e => set('banco_id', e.target.value)}><option value="">Seleccionar banco...</option>{bancos.map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}</select></Campo>}
        {form.medio_pago === 'tarjeta' && <Campo label="Titular de la tarjeta" style={{ gridColumn: '1/-1' }}><input style={inputSt} value={form.titular_tarjeta} onChange={e => set('titular_tarjeta', e.target.value)} placeholder="Nombre del titular" /></Campo>}
        {['transferencia','cheque'].includes(form.medio_pago) && <Campo label={form.medio_pago === 'cheque' ? 'Nro. de cheque (opcional)' : 'Nro. de operación (opcional)'} style={{ gridColumn: '1/-1' }}><input style={inputSt} value={form.nro_operacion} onChange={e => set('nro_operacion', e.target.value)} placeholder="Opcional" /></Campo>}
        <Campo label="Observaciones (opcional)" style={{ gridColumn: '1/-1' }}><textarea style={{ ...inputSt, minHeight: 56, resize: 'vertical' }} value={form.observaciones} onChange={e => set('observaciones', e.target.value)} /></Campo>
        <Campo label="Comprobante de pago (opcional)" style={{ gridColumn: '1/-1' }}>
          {form.comprobante_url ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: C.greenDim, border: `1px solid #B8E6CF`, borderRadius: 8 }}>
              <span style={{ fontSize: 16 }}>📎</span>
              <span style={{ fontSize: 12, color: C.green, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{archivoNombre}</span>
              <a href={form.comprobante_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>Ver</a>
              <button onClick={() => { set('comprobante_url', ''); setArchivoNombre('') }} style={{ fontSize: 11, color: '#D0021B', background: 'transparent', border: 'none', cursor: 'pointer' }}>✕</button>
            </div>
          ) : (
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#FAFAFA', border: `1.5px dashed ${C.border}`, borderRadius: 8, cursor: 'pointer' }}>
              <span style={{ fontSize: 20 }}>{subiendo ? '⏳' : '📎'}</span>
              <span style={{ fontSize: 12, color: C.textMuted }}>{subiendo ? 'Subiendo...' : 'Subir foto o PDF del comprobante'}</span>
              <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => e.target.files[0] && subirComprobante(e.target.files[0])} disabled={subiendo} />
            </label>
          )}
        </Campo>
      </div>
    </Modal>
  )
}



// ── Modal Adjuntar Comprobante de Pago ───────────────────────
function ModalAdjuntarComprobante({ gasto, onClose, onGuardar }) {
  const [subiendo, setSubiendo] = useState(false)
  const [url, setUrl] = useState(gasto?.pagos?.[0]?.comprobante_url || '')
  const [nombre, setNombre] = useState('')

  const subirArchivo = async (file) => {
    setSubiendo(true)
    try {
      // Validar sesión — con timeout para no trabar en mobile si la red es lenta
      try {
        const sesionP = supabase.auth.getSession().then(r => r.data?.session)
        const sesion = await Promise.race([sesionP, new Promise(r => setTimeout(() => r('timeout'), 3000))])
        if (!sesion) {
          const refreshP = supabase.auth.refreshSession().then(r => r.data?.session)
          const refreshed = await Promise.race([refreshP, new Promise(r => setTimeout(() => r('timeout'), 3000))])
          if (!refreshed && refreshed !== 'timeout') {
            window._toast?.('La sesión expiró. Cerrá sesión y volvé a ingresar para subir archivos.')
            setSubiendo(false)
            return
          }
        }
      } catch { /* intentamos subir igual */ }
      let blob = file, ext = (file.name.split('.').pop() || 'jpg')
      if (file.type !== 'application/pdf') {
        try { blob = await comprimirImagenBlob(file); ext = 'jpg' } catch {}
      }
      const path = `pagos/${Date.now()}.${ext}`
      const res = await Promise.race([
        supabase.storage.from('comprobantes-pagos').upload(path, blob),
        new Promise(r => setTimeout(() => r({ _timeout: true }), 15000))
      ])
      if (res?._timeout) { window._toast?.('La subida tardó demasiado. Intentá de nuevo.'); return }
      if (res?.error) {
        const esAuth = res.error.statusCode === '401' || res.error.statusCode === 401 || res.error.message?.toLowerCase().includes('jwt') || res.error.message?.toLowerCase().includes('auth')
        window._toast?.(esAuth ? 'Sesión expirada. Cerrá sesión y volvé a ingresar.' : 'No se pudo subir el archivo')
        return
      }
      const publicUrl = supabase.storage.from('comprobantes-pagos').getPublicUrl(path).data.publicUrl
      setUrl(publicUrl); setNombre(file.name)
    } finally { setSubiendo(false) }
  }

  return (
    <Modal title="Adjuntar comprobante de pago" onClose={onClose} onGuardar={() => url && onGuardar(url)} guardarLabel="Guardar">
      <div style={{ background: C.greenDim, border: `1px solid #B8E6CF`, borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 12 }}>
        <div style={{ fontWeight: 600, color: C.text }}>{gasto?.proveedores?.nombre ?? 'Sin proveedor'}</div>
        <div style={{ color: C.textMuted, marginTop: 2 }}>{gasto?.obras?.nombre} · {gasto?.fecha} · $ {fmt(gasto?.monto)}</div>
      </div>
      {url ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#F6FFF9', border: `1px solid #B8E6CF`, borderRadius: 8 }}>
          <span style={{ fontSize: 13, color: C.green }}>✓</span>
          <span style={{ fontSize: 12, color: C.text, flex: 1 }}>{nombre || 'Comprobante adjunto'}</span>
          <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.purple, fontWeight: 600 }}>Ver</a>
          <button onClick={() => { setUrl(''); setNombre('') }} style={{ fontSize: 12, color: '#D0021B', background: 'transparent', border: 'none', cursor: 'pointer' }}>✕</button>
        </div>
      ) : (
        <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '24px 16px', border: `2px dashed ${C.border}`, borderRadius: 10, cursor: 'pointer', background: subiendo ? '#F9F9F9' : C.surface }}>
          <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => e.target.files?.[0] && subirArchivo(e.target.files[0])} />
          <span style={{ fontSize: 28 }}>{subiendo ? '⏳' : '📎'}</span>
          <span style={{ fontSize: 13, color: C.textMuted, fontWeight: 600 }}>{subiendo ? 'Subiendo...' : 'Tocar para adjuntar'}</span>
          <span style={{ fontSize: 11, color: C.textFaint }}>Imagen o PDF del comprobante de transferencia</span>
        </label>
      )}
    </Modal>
  )
}

// ── Modal Pago Múltiple ───────────────────────────────────────
function ModalPagoMultiple({ gastos, bancos, onClose, onGuardar }) {
  const [form, setForm] = useState({ fecha_pago: hoy(), medio_pago: 'transferencia', banco_id: '', observaciones: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const total = gastos.reduce((s, g) => s + (g.monto || 0), 0)
  const necesitaBanco = ['transferencia', 'cheque', 'tarjeta'].includes(form.medio_pago)
  const proveedorNombre = gastos[0]?.proveedores?.nombre
  const mismoProveedor = gastos.every(g => g.proveedor_id === gastos[0]?.proveedor_id)

  return (
    <Modal title={`Pagar ${gastos.length} comprobantes`} onClose={onClose} onGuardar={() => onGuardar(form)} guardarLabel={`Confirmar pago $ ${fmt(total)}`}>
      {/* Resumen */}
      <div style={{ background: C.greenDim, border: `1px solid #B8E6CF`, borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: C.green, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
          {mismoProveedor && proveedorNombre ? proveedorNombre : `${gastos.length} comprobantes`}
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.green, fontVariantNumeric: 'tabular-nums' }}>{`$ ${fmt(total)}`}</div>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {gastos.map(g => (
            <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: C.textMuted }}>
              <span>{getTipoLabel(g.tipo_comprobante)}{g.nro_comprobante ? ' · ' + g.nro_comprobante : ''} — {g.fecha}</span>
              <span style={{ fontWeight: 600, color: C.text }}>{`$ ${fmt(g.monto)}`}</span>
            </div>
          ))}
        </div>
        {gastos[0]?.proveedores?.alias_cbu && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid #B8E6CF`, fontSize: 11, color: C.green, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 700 }}>CBU/Alias:</span>
            <span>{gastos[0].proveedores.alias_cbu || gastos[0].proveedores.cbu}</span>
            <button onClick={() => navigator.clipboard.writeText(gastos[0].proveedores.alias_cbu || gastos[0].proveedores.cbu)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, padding: 0 }}>📋</button>
            {gastos[0].proveedores.telefono && (
              <a href={'https://wa.me/549' + gastos[0].proveedores.telefono.replace(/\D/g,'').replace(/^0/,'')} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#25D366', textDecoration: 'none', fontWeight: 700 }}>
                <WAIcon size={13} /> WA
              </a>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Campo label="Fecha de pago"><input style={inputSt} type="date" value={form.fecha_pago} onChange={e => set('fecha_pago', e.target.value)} /></Campo>
        <Campo label="Medio de pago">
          <select style={inputSt} value={form.medio_pago} onChange={e => set('medio_pago', e.target.value)}>
            {(MEDIOS_PAGO || []).map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Campo>
        {necesitaBanco && (
          <Campo label="Banco" style={{ gridColumn: '1/-1' }}>
            <select style={inputSt} value={form.banco_id} onChange={e => set('banco_id', e.target.value)}>
              <option value="">— Seleccionar banco —</option>
              {(bancos || []).map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}
            </select>
          </Campo>
        )}
        <Campo label="Observaciones" style={{ gridColumn: '1/-1' }}>
          <input style={inputSt} value={form.observaciones} onChange={e => set('observaciones', e.target.value)} placeholder="Referencia de transferencia, etc." />
        </Campo>
      </div>
    </Modal>
  )
}

// ── FormGasto ─────────────────────────────────────────────────
function FormGasto({ form, set, obras, proveedores, onNuevoProveedor }) {
  const handleProveedorChange = (provId) => {
    set('proveedor_id', provId)
    if (!provId) return
    const prov = proveedores.find(p => p.id === provId)
    if (!prov) return
    const sit = getSituacion(prov.situacion_impositiva)
    set('tipo_comprobante', sit.comprobante)
    set('discrimina_iva', sit.iva)
    if (prov.condicion_pago) {
      set('condicion_pago', prov.condicion_pago)
      set('redondear_viernes', prov.redondear_viernes !== false)
    }
  }
  const dist = form.distribucion || []
  const setDist = (nuevo) => set('distribucion', nuevo)
  const sumaDist = dist.reduce((s, d) => s + (parseFloat(d.monto) || 0), 0)
  const montoTotal = parseFloat(form.monto) || 0
  const chipBtn = { padding: '5px 10px', background: '#F5F5F5', border: `1px solid ${C.border}`, borderRadius: 7, color: C.textMuted, cursor: 'pointer', fontSize: 12, fontFamily: "'Outfit', sans-serif" }
  const esGeneral = !!form.es_gasto_general
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      {/* Toggle gasto general */}
      <div style={{ gridColumn: '1/-1' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '10px 14px', borderRadius: 10, background: esGeneral ? '#EEF4FF' : C.surface, border: `1.5px solid ${esGeneral ? '#2D5FA8' : C.border}`, transition: 'all 0.15s' }}>
          <input type="checkbox" checked={esGeneral} onChange={e => { set('es_gasto_general', e.target.checked); if (e.target.checked) { set('obra_id', null); set('concepto', 'combustible') } else { set('obra_id', obras[0]?.id || ''); set('concepto', 'materiales') } }} style={{ accentColor: '#2D5FA8', width: 16, height: 16 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: esGeneral ? '#2D5FA8' : C.text }}>🏛️ Gasto general de empresa</div>
            <div style={{ fontSize: 11, color: C.textMuted }}>Combustible, servicios, legal, oficina — se prorratea entre obras activas</div>
          </div>
        </label>
      </div>
      <Campo label="Fecha"><input style={inputSt} type="date" value={form.fecha} onChange={e => set('fecha', e.target.value)} /></Campo>
      {!esGeneral && <Campo label="Obra"><select style={inputSt} value={form.obra_id || ''} onChange={e => set('obra_id', e.target.value)}>{obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}</select></Campo>}
      {esGeneral && <div />}
      <Campo label="Proveedor" style={{ gridColumn: '1/-1' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <select style={{ ...inputSt, flex: 1 }} value={form.proveedor_id || ''} onChange={e => handleProveedorChange(e.target.value)}>
            <option value="">Sin proveedor</option>
            {proveedores?.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
          <button type="button" onClick={() => onNuevoProveedor && onNuevoProveedor('', p => handleProveedorChange(p.id))} style={{ padding: '8px 12px', background: C.purpleDim, color: C.purple, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600 }}>+ Alta</button>
        </div>
      </Campo>
      <Campo label="Concepto"><select style={inputSt} value={form.concepto} onChange={e => set('concepto', e.target.value)}>{(esGeneral ? CONCEPTOS_GENERALES : CONCEPTOS).map(c => <option key={c} value={c}>{CONCEPTO_LABELS[c]}</option>)}</select></Campo>
      <Campo label="Monto"><input style={inputSt} type="number" value={form.monto} onChange={e => set('monto', e.target.value)} placeholder="0" /></Campo>
      <Campo label="Tipo de comprobante">
        <select style={inputSt} value={form.tipo_comprobante || 'factura_a'} onChange={e => { set('tipo_comprobante', e.target.value); const t = TIPOS_COMPROBANTE.find(t => t.value === e.target.value); if (t) set('discrimina_iva', t.iva); if (e.target.value !== 'factura_a') set('a_nombre_seate', false) }}>
          {TIPOS_COMPROBANTE.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </Campo>
      <Campo label="Nro. comprobante"><input style={inputSt} value={form.nro_comprobante || ''} onChange={e => set('nro_comprobante', e.target.value)} placeholder="0001-00012345" /></Campo>
      <Campo label="IVA" style={{ gridColumn: '1/-1' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.text, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!form.discrimina_iva} onChange={e => set('discrimina_iva', e.target.checked)} style={{ width: 15, height: 15, accentColor: C.purple }} />
          Discrimina IVA
          <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 4 }}>{form.discrimina_iva ? '→ Factura A' : '→ Sin IVA'}</span>
        </label>
      </Campo>
      {form.tipo_comprobante === 'factura_a' && (
        <Campo label="Crédito fiscal" style={{ gridColumn: '1/-1' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.text, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!form.a_nombre_seate} onChange={e => set('a_nombre_seate', e.target.checked)} style={{ width: 15, height: 15, accentColor: C.purple }} />
            Factura a nombre de SEATE S.R.L. (CUIT 30715138022)
            <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 4 }}>{form.a_nombre_seate ? '→ computa crédito fiscal' : '→ no computa'}</span>
          </label>
        </Campo>
      )}
      <Campo label="Distribución por obras" style={{ gridColumn: '1/-1' }}>
        {dist.length === 0 ? (
          <button type="button" onClick={() => setDist([{ obra_id: form.obra_id || obras[0]?.id || '', monto: montoTotal }])} style={chipBtn}>
            🏗️ Repartir entre varias obras
          </button>
        ) : (
          <div>
            {dist.map((d, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <select style={{ ...inputSt, flex: 1 }} value={d.obra_id || ''} onChange={e => setDist(dist.map((x, idx) => idx === i ? { ...x, obra_id: e.target.value } : x))}>
                  <option value="">Obra...</option>
                  {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
                </select>
                <input style={{ ...inputSt, width: 110 }} type="number" placeholder="Monto" value={d.monto} onChange={e => setDist(dist.map((x, idx) => idx === i ? { ...x, monto: e.target.value } : x))} />
                <button type="button" onClick={() => setDist(dist.filter((_, idx) => idx !== i))} style={{ background: 'transparent', border: 'none', color: '#D0021B', cursor: 'pointer', fontSize: 14 }}>✕</button>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              <button type="button" onClick={() => setDist([...dist, { obra_id: '', monto: '' }])} style={chipBtn}>+ Obra</button>
              <span style={{ fontSize: 11, color: sumaDist === montoTotal ? C.textMuted : C.orange, fontWeight: 600 }}>
                Repartido: $ {fmt(sumaDist)} / $ {fmt(montoTotal)} {sumaDist === montoTotal ? '✓' : '⚠'}
              </span>
              <button type="button" onClick={() => setDist([])} style={{ ...chipBtn, color: C.textMuted }}>Quitar (100% una obra)</button>
            </div>
          </div>
        )}
      </Campo>
      <Campo label="Descripción" style={{ gridColumn: '1/-1' }}><textarea style={{ ...inputSt, minHeight: 64, resize: 'vertical' }} value={form.descripcion || ''} onChange={e => set('descripcion', e.target.value)} /></Campo>
      <Campo label="Condición de pago" style={{ gridColumn: '1/-1' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select style={{ ...inputSt, flex: 1 }} value={form.condicion_pago || 'contado'} onChange={e => set('condicion_pago', e.target.value)}>
            {CONDICIONES_PAGO.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          {form.condicion_pago !== 'contado' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: C.textMuted, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={!!form.redondear_viernes} onChange={e => set('redondear_viernes', e.target.checked)} style={{ width: 14, height: 14, accentColor: C.purple }} />
              Al viernes siguiente
            </label>
          )}
          {form.condicion_pago !== 'contado' && form.fecha && (
            <span style={{ fontSize: 11, color: C.purple, fontWeight: 600 }}>
              Vence: {calcVencimiento(form.fecha, form.condicion_pago, !!form.redondear_viernes)}
            </span>
          )}
        </div>
      </Campo>
    </div>
  )
}

// ── UI Genérico ───────────────────────────────────────────────
function Modal({ title, children, onClose, onGuardar, guardarLabel = 'Guardar', zIndex = 200 }) {
  const [saving, setSaving] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  const handleGuardar = async () => {
    if (!onGuardar || saving) return
    setSaving(true); setErrMsg('')
    try { await onGuardar() } catch(e) { setErrMsg(e?.message || 'Error al guardar') } finally { setSaving(false) }
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 22, width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box', boxShadow: '0 8px 40px rgba(0,0,0,0.12)' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 18 }}>{title}</h3>
        {children}
        {errMsg && <div style={{ marginTop: 10, padding: '8px 12px', background: '#FFF0F0', border: '1px solid #FFCCCC', borderRadius: 8, fontSize: 12, color: '#C62828' }}>⚠ {errMsg}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button style={{ padding: '8px 16px', background: 'transparent', color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }} onClick={onClose}>Cancelar</button>
          {onGuardar && <button disabled={saving} style={{ padding: '8px 20px', background: saving ? C.textFaint : C.purple, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: saving ? 'default' : 'pointer', fontWeight: 600, fontFamily: "'Outfit', sans-serif" }} onClick={handleGuardar}>{saving ? 'Guardando...' : guardarLabel}</button>}
        </div>
      </div>
    </div>
  )
}

function Campo({ label, children, style }) {
  return (
    <div style={{ ...style }}>
      <label style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</label>
      {children}
    </div>
  )
}

function PageHeader({ titulo, sub, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
      <PageTitle titulo={titulo} sub={sub} />{children}
    </div>
  )
}

function PageTitle({ titulo, sub }) {
  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>{titulo}</h1>
      {sub && <p style={{ fontSize: 12, color: C.textMuted, margin: '3px 0 0' }}>{sub}</p>}
    </div>
  )
}

function ConceptoBadge({ concepto }) {
  const [bg, color] = CONCEPTO_COLORS[concepto] ?? CONCEPTO_COLORS.varios
  return <span style={{ background: bg, color, padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>{CONCEPTO_LABELS[concepto]}</span>
}

function ComprobanteBadge({ tipo, iva }) {
  if (!tipo || tipo === 'sin_comprobante') return <span style={{ fontSize: 11, color: C.textFaint }}>Sin comp.</span>
  return <span style={{ background: iva ? C.greenDim : '#F3F3F3', color: iva ? C.green : '#666', padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>{getTipoLabel(tipo)}</span>
}

function PagoBadge({ pagado }) {
  return <span style={{ background: pagado ? C.greenDim : '#FFF8ED', color: pagado ? C.green : '#8A5200', padding: '2px 9px', borderRadius: 99, fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-block', marginTop: 2 }}>{pagado ? '✓ Pagado' : 'Pendiente'}</span>
}

function EstadoBadge({ estado }) {
  const m = { activa: [C.purpleDim, C.purple], pausada: ['#FFF8ED','#8A5200'], finalizada: ['#F3F3F3','#888'] }
  const [bg, color] = m[estado] ?? m.finalizada
  return <span style={{ background: bg, color, padding: '2px 10px', borderRadius: 99, fontSize: 10, fontWeight: 600 }}>{estado.charAt(0).toUpperCase()+estado.slice(1)}</span>
}

function BtnPrimary({ children, onClick }) {
  return <button onClick={onClick} style={{ padding: '7px 16px', background: C.purple, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontWeight: 600, fontFamily: "'Outfit', sans-serif", whiteSpace: 'nowrap' }}>{children}</button>
}

function BtnSecondary({ children, onClick }) {
  return <button onClick={onClick} style={{ padding: '7px 14px', background: C.surface, color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, cursor: 'pointer', fontWeight: 500, fontFamily: "'Outfit', sans-serif", whiteSpace: 'nowrap' }}>{children}</button>
}

function Spinner() {
  return <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}><div style={{ width: 24, height: 24, border: `2px solid ${C.border}`, borderTopColor: C.purple, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} /></div>
}

function EmptyState({ texto }) {
  return <div style={{ textAlign: 'center', padding: '48px 20px', color: C.textFaint, fontSize: 13 }}>{texto}</div>
}

const inputSt = { width: '100%', padding: '8px 12px', fontSize: 13, fontFamily: "'Outfit', sans-serif", border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface, color: C.text, boxSizing: 'border-box', outline: 'none', colorScheme: 'light' }
const cardSt   = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 }
const tdSt     = { padding: '10px 10px', color: C.textMuted, verticalAlign: 'middle' }
const btnIconSt = { padding: '4px 6px', background: '#F5F5F5', border: `1px solid ${C.border}`, borderRadius: 6, color: C.textMuted, cursor: 'pointer', fontSize: 11, lineHeight: 1 }
