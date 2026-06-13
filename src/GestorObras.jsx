import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'
import CuentaCorriente from './CuentaCorriente'
import { C, CONCEPTOS, CONCEPTO_LABELS, CONCEPTO_COLORS, CONCEPTO_ICONS, TIPOS_COMPROBANTE, SITUACIONES, MEDIOS_PAGO, RUBROS } from './constants'
import { fmt, fmtK, hoy, getSituacion, getTipoLabel, dbWrite } from './utils'
import './toast'

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
    const ids = JSON.parse(idsClave)
    if (ids === undefined) return
    if (showLoading) setLoading(true)
    const failsafe = showLoading ? setTimeout(() => setLoading(false), 12000) : null
    try {
      let q = supabase.from('gastos')
        .select('*, obras(nombre), proveedores(nombre, situacion_impositiva), pagos(id, medio_pago, monto, fecha_pago, banco_id, comprobante_url)')
        .order('fecha', { ascending: false })
      if (ids !== null) q = q.in('obra_id', ids)
      const { data, error } = await q
      if (error) { console.error('useGastos error:', error) }
      else setGastos(data ?? [])
    } catch (e) { console.error('useGastos catch:', e) }
    if (failsafe) clearTimeout(failsafe)
    if (showLoading) setLoading(false)
  }, [idsClave])
  useEffect(() => { cargar() }, [cargar])
  return { gastos, setGastos, loading, recargar: cargar }
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
  const gastos = filtroObraId ? todosGastos.filter(g => g.obra_id === filtroObraId) : todosGastos
  // silent=true → refresca en background sin mostrar spinner (post-save en mobile)
  const recargarTodo = (silent = false) => { recargarObras(!silent); recargarGastos(!silent) }

  // Realtime: auto-actualiza cuando otro dispositivo guarda o borra datos
  useEffect(() => {
    let timerG, timerO, timerL
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
      .subscribe()
    return () => { supabase.removeChannel(ch); clearTimeout(timerG); clearTimeout(timerO); clearTimeout(timerL) }
  }, [recargarGastos, recargarObras, recargarListas])

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
    { id: 'cc',      label: 'Cta Cte', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg> },
    { id: 'informe', label: 'Informe', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> },
    { id: 'mas',     label: 'Más',     icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg> },
  ]

  const guardarProveedor = async (datos) => {
    const { nombre, cuit, rubro, situacion_impositiva } = datos
    let nuevoProv = null
    try {
      nuevoProv = await dbWrite('POST', 'proveedores',
        { nombre: nombre.trim(), cuit: cuit?.trim() || null, rubro: rubro || null, situacion_impositiva },
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
        .fade-up { animation: fadeUp 0.22s ease forwards; }
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
              {['inicio','obras','gastos','cc','informe'].map(id => {
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
            <MobileHeaderStats obras={obras} gastos={todosGastos} />
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
            {panel === 'inicio'    && <PanelInicio obras={obras} gastos={todosGastos} esAdmin={esAdmin} onVerGastos={(id) => { setFiltroObraId(id); setPanel('gastos') }} onVerObras={() => setPanel('obras')} onNuevoGasto={() => abrirModal('gasto')} onNuevoFoto={() => abrirModal('foto')} />}
            {panel === 'obras'     && <PanelObras obras={obras} loading={loadingObras} esAdmin={esAdmin} onNueva={() => abrirModal('obra')} onEditar={o => abrirModal('obra', o)} onVerGastos={id => { setFiltroObraId(id); setPanel('gastos') }} />}
            {panel === 'gastos'    && <PanelGastos obras={obras} gastos={gastos} loading={loadingGastos} filtroObraId={filtroObraId} setFiltroObraId={setFiltroObraId} esAdmin={esAdmin} onNuevoManual={() => abrirModal('gasto')} onNuevoFoto={() => abrirModal('foto')} onEditar={g => abrirModal('gasto', g)} onPagar={g => abrirModal('pago', g)} onEliminar={async g => { if (window.confirm('¿Eliminar este gasto?')) { await dbWrite('DELETE', 'gastos', null, `id=eq.${g.id}`); setGastos(prev => prev.filter(x => x.id !== g.id)); recargarObras(true); recargarGastos(false) } }} />}
            {panel === 'cc'        && <CuentaCorriente esAdmin={esAdmin} usuario={usuario} />}
            {panel === 'informe'   && <PanelInforme obras={obras} gastos={todosGastos} loading={loadingGastos} />}
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
        const res = id ? await supabase.from('obras').update(payload).eq('id', id) : await supabase.from('obras').insert([payload])
        if (res.error) console.error('Error:', res.error.message)
        else { cerrarModal(); recargarObras() }
      }} />}

      {modal === 'gasto' && obras.length > 0 && <ModalGasto itemEdit={itemEditando} obras={obras} proveedores={proveedores} obraIdDefecto={filtroObraId} onClose={cerrarModal}
        onNuevoProveedor={(nombre, cb) => { setProveedorPendiente({ nombre }); setOnProveedorCreado(() => cb) }}
        onGuardar={async d => {
          if (!d.monto || d.monto <= 0) { window._toast?.('Ingresá un monto válido'); throw new Error('Ingresá un monto válido') }
          const { id, obra_id, fecha, proveedor_id, concepto, monto, descripcion, tipo_comprobante, discrimina_iva, nro_comprobante } = d
          const payload = { obra_id, fecha, proveedor_id: proveedor_id || null, concepto, monto: parseFloat(monto) || 0, descripcion, tipo_comprobante, discrimina_iva, nro_comprobante }
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
          cerrarModal(); recargarTodo(true); setPanel('gastos')
        }}
      />}

      {modal === 'foto' && obras.length > 0 && <ModalFoto obras={obras} proveedores={proveedores} obraIdDefecto={filtroObraId} onClose={cerrarModal}
        onNuevoProveedor={(nombre, cb) => { setProveedorPendiente({ nombre }); setOnProveedorCreado(() => cb) }}
        onGuardar={async d => {
          const saved = await dbWrite('POST', 'gastos', d, null, true)
          // Actualización optimista
          const obraObj = obras.find(o => o.id === d.obra_id)
          const provObj = proveedores.find(p => p.id === d.proveedor_id)
          if (saved?.id) {
            setGastos(prev => [{ ...d, id: saved.id, obras: obraObj ? { nombre: obraObj.nombre } : null, proveedores: provObj ? { nombre: provObj.nombre, situacion_impositiva: provObj.situacion_impositiva } : null, pagos: [] }, ...prev])
          }
          cerrarModal(); recargarTodo(true)
        }}
      />}

      {modal === 'pago' && esAdmin && <ModalPago gasto={itemEditando} bancos={bancos} onClose={cerrarModal} onGuardar={async d => {
        const payload = { ...d, gasto_id: itemEditando.id, creado_por: usuario.id }
        const { error } = await supabase.from('pagos').insert([payload])
        if (error) { console.error('Error:', error.message); return }
        await supabase.from('gastos').update({ pagado: true }).eq('id', itemEditando.id)
        cerrarModal(); recargarGastos()
      }} />}

      {modal === 'cliente'   && <ModalCliente   itemEdit={itemEditando} onClose={cerrarModal} onGuardar={async d => {
        if (!d.nombre) throw new Error('Nombre obligatorio')
        const { id, nombre, telefono, email } = d
        await dbWrite(id ? 'PATCH' : 'POST', 'clientes', { nombre, telefono, email }, id ? `id=eq.${id}` : null)
        cerrarModal(); recargarListas()
      }} />}
      {modal === 'proveedor' && <ModalProveedor itemEdit={itemEditando} onClose={cerrarModal} onGuardar={async d => {
        if (!d.nombre) throw new Error('Nombre obligatorio')
        const { id, nombre, cuit, rubro, situacion_impositiva } = d
        await dbWrite(id ? 'PATCH' : 'POST', 'proveedores', { nombre, cuit, rubro, situacion_impositiva }, id ? `id=eq.${id}` : null)
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
function MobileHeaderStats({ obras, gastos }) {
  const obrasActivas = obras.filter(o => o.estado === 'activa').length
  const idsActivas = new Set(obras.filter(o => o.estado === 'activa').map(o => o.id))
  const gastosActivas = gastos.filter(g => idsActivas.has(g.obra_id))
  const totalGastos = gastosActivas.reduce((s, g) => s + (g.monto ?? 0), 0)
  const pendiente = gastosActivas.filter(g => !g.pagado).reduce((s, g) => s + (g.monto ?? 0), 0)
  return (
    <div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>Total gastado</div>
      <div style={{ fontSize: 38, fontWeight: 800, color: '#fff', fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.04em', lineHeight: 1 }}>$ {fmt(totalGastos)}</div>
      <div style={{ display: 'flex', gap: 14, marginTop: 6 }}>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>🏗️ {obrasActivas} obra{obrasActivas !== 1 ? 's' : ''} activa{obrasActivas !== 1 ? 's' : ''}</span>
        {pendiente > 0 && <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>⏳ {fmtK(pendiente)} pendiente</span>}
      </div>
    </div>
  )
}

// ── Panel Inicio ──────────────────────────────────────────────
function PanelInicio({ obras, gastos, esAdmin, onVerGastos, onVerObras, onNuevoGasto, onNuevoFoto }) {
  const obrasActivas = obras.filter(o => o.estado === 'activa')
  const idsActivas = new Set(obrasActivas.map(o => o.id))
  const gastosActivas = gastos.filter(g => idsActivas.has(g.obra_id))
  const totalGastos = gastosActivas.reduce((s, g) => s + (g.monto ?? 0), 0)
  const pagado = gastosActivas.filter(g => g.pagado).reduce((s, g) => s + (g.monto ?? 0), 0)
  const pendiente = totalGastos - pagado
  const ultimosGastos = gastos.slice(0, 5)

  return (
    <div>
      {/* Stats desktop (en mobile se ve en el header) */}
      <div className="desktop-only" style={{ marginBottom: 20 }}>
        <PageHeader titulo="Inicio" sub="Resumen general">
          <div style={{ display: 'flex', gap: 8 }}>
          <BtnSecondary onClick={onNuevoFoto}>📎 Comprobante</BtnSecondary>
          <BtnPrimary onClick={onNuevoGasto}>+ Gasto</BtnPrimary>
          </div>
        </PageHeader>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
          {[
            { label: 'Total gastos',   value: `$ ${fmt(totalGastos)}`, sub: `${gastosActivas.length} comprobantes` },
            { label: 'Pagado',         value: `$ ${fmt(pagado)}`,      sub: `${totalGastos > 0 ? Math.round(pagado/totalGastos*100) : 0}%` },
            { label: 'Pendiente',      value: `$ ${fmt(pendiente)}`,   sub: `${gastosActivas.filter(g=>!g.pagado).length} facturas`, alert: pendiente > 0 },
            { label: 'Obras activas',  value: obrasActivas.length,     sub: `de ${obras.length} total` },
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
      <div className="mobile-only" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, color: C.textFaint, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Pagado</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.green, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>{fmtK(pagado)}</div>
          <div style={{ fontSize: 10, color: C.textFaint, marginTop: 3 }}>{totalGastos > 0 ? Math.round(pagado/totalGastos*100) : 0}% del total</div>
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, color: C.textFaint, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Pendiente</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: pendiente > 0 ? '#D0021B' : C.textFaint, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>{fmtK(pendiente)}</div>
          <div style={{ fontSize: 10, color: C.textFaint, marginTop: 3 }}>{gastosActivas.filter(g=>!g.pagado).length} facturas</div>
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
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{g.obras?.nombre} · {g.fecha}</div>
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
function PanelObras({ obras, loading, esAdmin, onNueva, onVerGastos, onEditar }) {
  const [filtroEstado, setFiltroEstado] = useState('activa')
  const obrasFiltradas = filtroEstado === 'todas' ? obras : obras.filter(o => o.estado === filtroEstado)
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
          <BtnPrimary onClick={onNueva}>+ Nueva obra</BtnPrimary>
        </div>
      </PageHeader>
      {loading ? <Spinner /> : obrasFiltradas.length === 0 ? <EmptyState texto={`No hay obras ${filtroEstado === 'todas' ? 'registradas' : filtroEstado + 's'}`} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {obrasFiltradas.map(o => {
            const pct = o.presupuesto > 0 ? Math.min(100, Math.round((o.total_gastado / o.presupuesto) * 100)) : 0
            const sobrep = o.presupuesto > 0 && o.total_gastado > o.presupuesto
            return (
              <div key={o.id} className="card-hover" style={{ ...cardSt, padding: 0, overflow: 'hidden' }} onClick={() => onVerGastos(o.id)}>
                <div style={{ display: 'flex' }}>
                  <div style={{ width: 3, background: o.estado === 'activa' ? C.purple : C.border, flexShrink: 0 }} />
                  <div style={{ flex: 1, padding: '16px 16px 16px 14px', position: 'relative' }}>
                    <button style={{ position: 'absolute', top: 12, right: 12, ...btnIconSt }} onClick={e => { e.stopPropagation(); onEditar(o) }}>✏️</button>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2, paddingRight: 32 }}>{o.nombre}</div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 14 }}>{o.cliente || 'Sin cliente'}</div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: C.text, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.04em' }}>$ {fmt(o.total_gastado)}</div>
                    <div style={{ fontSize: 11, color: C.textFaint, marginTop: 3, marginBottom: o.presupuesto > 0 ? 10 : 12 }}>{o.cant_gastos} gasto{o.cant_gastos !== 1 ? 's' : ''}</div>
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
function PanelGastos({ obras, gastos, loading, filtroObraId, setFiltroObraId, esAdmin, onNuevoManual, onNuevoFoto, onEditar, onPagar, onEliminar }) {
  const total = gastos.reduce((s, g) => s + (g.monto ?? 0), 0)
  const pagado = gastos.filter(g => g.pagado).reduce((s, g) => s + (g.monto ?? 0), 0)
  return (
    <div>
      <PageHeader titulo="Gastos" sub={`Total: $ ${fmt(total)}`}>
        <div style={{ display: 'flex', gap: 8 }}>
          <BtnSecondary onClick={onNuevoFoto}>📎 Comprobante</BtnSecondary>
          <BtnPrimary onClick={onNuevoManual}>+ Gasto</BtnPrimary>
        </div>
      </PageHeader>

      {gastos.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
          {[
            { label: 'Total', value: `$ ${fmt(total)}`, color: C.text },
            { label: 'Pagado', value: `$ ${fmt(pagado)}`, color: C.green },
            { label: 'Pendiente', value: `$ ${fmt(total - pagado)}`, color: total - pagado > 0 ? '#D0021B' : C.textFaint },
          ].map(s => (
            <div key={s.label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 14px' }}>
              <div style={{ fontSize: 10, color: C.textFaint, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{s.label}</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: s.color, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      <select value={filtroObraId} onChange={e => setFiltroObraId(e.target.value)} style={{ ...inputSt, marginBottom: 16, maxWidth: 320 }}>
        <option value="">Todas las obras</option>
        {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
      </select>

      {loading ? <Spinner /> : gastos.length === 0 ? <EmptyState texto="No hay gastos registrados" /> : (
        <>
          {/* MOBILE */}
          <div className="mobile-only" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {gastos.map(g => {
              const [iconBg] = CONCEPTO_COLORS[g.concepto] ?? CONCEPTO_COLORS.varios
              return (
                <div key={g.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 12, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
                      {CONCEPTO_ICONS[g.concepto] ?? '📦'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{g.proveedores?.nombre ?? 'Sin proveedor'}</div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{g.obras?.nombre ?? '—'} · {g.fecha}</div>
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
                      {g.imagen_url && <a href={g.imagen_url} target="_blank" rel="noreferrer" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>📎</a>}
                      {g.pagos?.length > 0 && g.pagos[0].comprobante_url && <a href={g.pagos[0].comprobante_url} target="_blank" rel="noreferrer" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', color: C.green }}>🧾</a>}
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
                <col style={{ width: 86 }} /><col style={{ width: 108 }} /><col style={{ width: 118 }} />
                <col style={{ width: 90 }} /><col style={{ width: 98 }} /><col />
                <col style={{ width: 110 }} /><col style={{ width: 72 }} /><col style={{ width: 120 }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}`, background: '#FAFAFA' }}>
                  {['Fecha','Obra','Proveedor','Concepto','Comprobante','Descripción','Monto','Estado',''].map((h,i) => (
                    <th key={h+i} style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textAlign: h==='Monto'?'right':'left', padding: '11px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gastos.map((g, i) => (
                  <tr key={g.id} style={{ borderBottom: i < gastos.length-1 ? `1px solid ${C.borderFaint}` : 'none', background: g.pagado ? '#FAFFFE' : C.surface }}>
                    <td style={{ ...tdSt, whiteSpace: 'nowrap', fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', fontSize: 11, color: C.textMuted }}>{g.fecha}</td>
                    <td style={tdSt}><span style={{ fontSize: 11, padding: '2px 7px', background: C.purpleDim, color: C.purple, borderRadius: 99, fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.obras?.nombre ?? '—'}</span></td>
                    <td style={{ ...tdSt, fontWeight: 500, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.proveedores?.nombre ?? '—'}</td>
                    <td style={tdSt}><ConceptoBadge concepto={g.concepto} /></td>
                    <td style={tdSt}><ComprobanteBadge tipo={g.tipo_comprobante} iva={g.discrimina_iva} /></td>
                    <td style={{ ...tdSt, color: C.textMuted, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.descripcion}</td>
                    <td style={{ ...tdSt, textAlign: 'right', fontWeight: 700, color: C.text, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>$ {fmt(g.monto)}</td>
                    <td style={tdSt}><PagoBadge pagado={g.pagado} /></td>
                    <td style={{ ...tdSt, padding: '8px 8px' }}>
                      <div style={{ display: 'flex', gap: 3, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        {esAdmin && !g.pagado && <button style={{ ...btnIconSt, fontSize: 10, color: C.green, background: C.greenDim, borderColor: '#B8E6CF', padding: '4px 7px', whiteSpace: 'nowrap' }} onClick={() => onPagar(g)}>Pagar</button>}
                        {g.imagen_url && <a href={g.imagen_url} target="_blank" rel="noreferrer" title="Ver factura" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>📎</a>}
                        {g.pagos?.length > 0 && g.pagos[0].comprobante_url && <a href={g.pagos[0].comprobante_url} target="_blank" rel="noreferrer" title="Comprobante pago" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', color: C.green }}>🧾</a>}
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
function PanelInforme({ obras, gastos: todosGastosInforme, loading }) {
  const [obraId, setObraId] = useState('')
  const gastos = obraId ? todosGastosInforme.filter(g => g.obra_id === obraId) : todosGastosInforme
  const total = gastos.reduce((s, g) => s + (g.monto ?? 0), 0)
  const pagado = gastos.filter(g => g.pagado).reduce((s, g) => s + (g.monto ?? 0), 0)
  const porConcepto = {}
  CONCEPTOS.forEach(c => { porConcepto[c] = gastos.filter(g => g.concepto === c).reduce((s, g) => s + (g.monto ?? 0), 0) })
  const maxVal = Math.max(...Object.values(porConcepto), 1)
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 22, flexWrap: 'wrap', gap: 10 }}>
        <PageTitle titulo="Informe" sub="Resumen financiero" />
        <select value={obraId} onChange={e => setObraId(e.target.value)} style={{ ...inputSt, width: 'auto', minWidth: 220 }}>
          <option value="">Todas las obras</option>
          {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
        </select>
      </div>
      {loading ? <Spinner /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 20 }}>
            {[
              { label: 'Total gastos',  value: `$ ${fmt(total)}`,          sub: `${gastos.length} comprobantes` },
              { label: 'Pagado',        value: `$ ${fmt(pagado)}`,          sub: `${total > 0 ? Math.round(pagado/total*100) : 0}%` },
              { label: 'Pendiente',     value: `$ ${fmt(total - pagado)}`,  sub: `${gastos.filter(g=>!g.pagado).length} facturas`, alert: (total - pagado) > 0 },
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
          </div>
        </>
      )}
    </div>
  )
}

// ── Panel Contactos ───────────────────────────────────────────
function PanelContactos({ clientes, proveedores, onNuevoCliente, onNuevoProveedor, onEditarCliente, onEditarProveedor, onEliminarCliente, onEliminarProveedor }) {
  return (
    <div>
      <PageTitle titulo="Contactos" sub="Clientes y proveedores" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, marginTop: 20 }}>
        <ContactoCol titulo="Clientes" items={clientes} onNuevo={onNuevoCliente} onEditar={onEditarCliente} onEliminar={onEliminarCliente} btnLabel="+ Cliente" renderSub={c => [c.telefono, c.email].filter(Boolean).join(' · ')} />
        <ContactoCol titulo="Proveedores" items={proveedores} onNuevo={onNuevoProveedor} onEditar={onEditarProveedor} onEliminar={onEliminarProveedor} btnLabel="+ Proveedor" outline renderSub={p => { const sit = getSituacion(p.situacion_impositiva); return [sit.label, p.cuit && `CUIT: ${p.cuit}`].filter(Boolean).join(' · ') }} />
      </div>
    </div>
  )
}

function ContactoCol({ titulo, items, onNuevo, onEditar, onEliminar, btnLabel, outline, renderSub }) {
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
            </div>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
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
    if (existe) {
      await supabase.from('obra_usuarios').delete().eq('obra_id', obraId).eq('usuario_id', usuarioId)
    } else {
      await supabase.from('obra_usuarios').insert([{ obra_id: obraId, usuario_id: usuarioId }])
    }
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
  const [form, setForm] = useState(itemEdit || { obra_id: obraIdDefecto || obras[0]?.id || '', fecha: hoy(), proveedor_id: '', concepto: 'materiales', monto: '', descripcion: '', tipo_comprobante: 'factura_a', discrimina_iva: true, nro_comprobante: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return <Modal title={itemEdit ? 'Editar Gasto' : 'Registrar Gasto'} onClose={onClose} onGuardar={() => onGuardar(form)}><FormGasto form={form} set={set} obras={obras} proveedores={proveedores} onNuevoProveedor={onNuevoProveedor} /></Modal>
}

function ModalFoto({ obras, proveedores, obraIdDefecto, onClose, onGuardar, onNuevoProveedor }) {
  const [step, setStep] = useState('upload')
  const [form, setForm] = useState({ obra_id: obraIdDefecto || obras[0]?.id || '', fecha: hoy(), proveedor_id: '', concepto: 'materiales', monto: '', descripcion: '', imagen_url: '', tipo_comprobante: 'factura_a', discrimina_iva: true, nro_comprobante: '' })
  const [preview, setPreview] = useState(null)
  const [currentFile, setCurrentFile] = useState(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const procesarFoto = async (file) => {
    setPreview(URL.createObjectURL(file)); setCurrentFile(file); setStep('loading')
    let imageUrl = ''
    try {
      // 1. Base64 primero (local, no depende de red)
      const base64 = await new Promise(res => { const r = new FileReader(); r.onload = e => res(e.target.result.split(',')[1]); r.readAsDataURL(file) })

      // 2. Storage en paralelo (sin bloquear la IA)
      const ext = file.name.split('.').pop()
      supabase.storage.from('comprobantes').upload(`comprobantes/${Date.now()}.${ext}`, file)
        .then(({ data: uploadData }) => {
          if (uploadData) imageUrl = supabase.storage.from('comprobantes').getPublicUrl(uploadData.path).data.publicUrl
        }).catch(() => {})

      // 3. IA con fetch directo + timeout de 30s
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
      const fnUrl = 'https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante'
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
      const respRaw = await Promise.race([
        fetch(fnUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}` }, body: JSON.stringify({ base64, mimeType: file.type, hoy: hoy() }) }),
        timeout
      ])
      const data = await respRaw.json()
      const error = !respRaw.ok ? data : null
      if (!error && data?.content) {
        const text = data.content.map(i => i.text || '').join('')
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
        const nombreIA = parsed.proveedor || ''
        const matchProv = proveedores.find(p => p.nombre.toLowerCase().includes(nombreIA.toLowerCase()))
        let tipo = 'factura_a', iva = true
        if (matchProv) { const sit = getSituacion(matchProv.situacion_impositiva); tipo = sit.comprobante; iva = sit.iva }
        setForm(f => ({ ...f, fecha: parsed.fecha || hoy(), proveedor_id: matchProv ? matchProv.id : '', concepto: parsed.concepto || 'varios', monto: parsed.monto || '', nro_comprobante: parsed.nro_comprobante || '', descripcion: (parsed.descripcion || '') + (nombreIA && !matchProv ? ` (IA detectó prov: ${nombreIA})` : ''), imagen_url: imageUrl, tipo_comprobante: tipo, discrimina_iva: iva }))
        if (nombreIA && !matchProv) onNuevoProveedor && onNuevoProveedor(nombreIA, (np) => { if (!np?.id) return; const sit = getSituacion(np.situacion_impositiva); setForm(f => ({ ...f, proveedor_id: np.id, tipo_comprobante: sit.comprobante, discrimina_iva: sit.iva, descripcion: parsed.descripcion || '' })) })
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
  const [form, setForm] = useState({ nombre: datosIniciales?.nombre || '', cuit: '', rubro: '', situacion_impositiva: 'responsable_inscripto' })
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
  const [form, setForm] = useState(itemEdit || { nombre: '', cuit: '', rubro: '', situacion_impositiva: 'responsable_inscripto' })
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
    const ext = file.name.split('.').pop()
    const path = `pagos/${Date.now()}.${ext}`
    const { data, error } = await supabase.storage.from('comprobantes-pagos').upload(path, file)
    if (error) { console.error('Error al subir:', error.message); setSubiendo(false); return }
    const url = supabase.storage.from('comprobantes-pagos').getPublicUrl(path).data.publicUrl
    set('comprobante_url', url); setArchivoNombre(file.name); setSubiendo(false)
  }

  return (
    <Modal title={`Registrar pago — $ ${fmt(gasto?.monto)}`} onClose={onClose} onGuardar={() => onGuardar({ ...form, monto: parseFloat(form.monto) || 0, banco_id: form.banco_id || null })} guardarLabel="Confirmar pago">
      <div style={{ background: C.purpleDim, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12 }}>
        <div style={{ fontWeight: 600, color: C.text, marginBottom: 2 }}>{gasto?.proveedores?.nombre ?? 'Sin proveedor'}</div>
        <div style={{ color: C.textMuted }}>{gasto?.obras?.nombre} · {gasto?.fecha} · {getTipoLabel(gasto?.tipo_comprobante)}</div>
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
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      <Campo label="Fecha"><input style={inputSt} type="date" value={form.fecha} onChange={e => set('fecha', e.target.value)} /></Campo>
      <Campo label="Obra"><select style={inputSt} value={form.obra_id || ''} onChange={e => set('obra_id', e.target.value)}>{obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}</select></Campo>
      <Campo label="Proveedor" style={{ gridColumn: '1/-1' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <select style={{ ...inputSt, flex: 1 }} value={form.proveedor_id || ''} onChange={e => handleProveedorChange(e.target.value)}>
            <option value="">Sin proveedor</option>
            {proveedores?.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
          <button type="button" onClick={() => onNuevoProveedor && onNuevoProveedor('', p => handleProveedorChange(p.id))} style={{ padding: '8px 12px', background: C.purpleDim, color: C.purple, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600 }}>+ Alta</button>
        </div>
      </Campo>
      <Campo label="Concepto"><select style={inputSt} value={form.concepto} onChange={e => set('concepto', e.target.value)}>{CONCEPTOS.map(c => <option key={c} value={c}>{CONCEPTO_LABELS[c]}</option>)}</select></Campo>
      <Campo label="Monto"><input style={inputSt} type="number" value={form.monto} onChange={e => set('monto', e.target.value)} placeholder="0" /></Campo>
      <Campo label="Tipo de comprobante">
        <select style={inputSt} value={form.tipo_comprobante || 'factura_a'} onChange={e => { set('tipo_comprobante', e.target.value); const t = TIPOS_COMPROBANTE.find(t => t.value === e.target.value); if (t) set('discrimina_iva', t.iva) }}>
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
      <Campo label="Descripción" style={{ gridColumn: '1/-1' }}><textarea style={{ ...inputSt, minHeight: 64, resize: 'vertical' }} value={form.descripcion || ''} onChange={e => set('descripcion', e.target.value)} /></Campo>
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
