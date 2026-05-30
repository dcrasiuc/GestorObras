import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'

const CONCEPTOS = ['materiales', 'mano-obra', 'equipos', 'subcontratos', 'varios']
const CONCEPTO_LABELS = { materiales: 'Materiales', 'mano-obra': 'Mano de obra', equipos: 'Equipos', subcontratos: 'Subcontratos', varios: 'Varios' }
const CONCEPTO_COLORS = {
  materiales: ['#F3F0FF','#6B3FA0'], 'mano-obra': ['#EDFAF3','#1A6B3C'],
  equipos: ['#FFF8ED','#8A5200'], subcontratos: ['#EDF3FF','#1A3F8A'], varios: ['#F3F3F3','#666666'],
}
const TIPOS_COMPROBANTE = [
  { value: 'factura_a', label: 'Factura A', iva: true },
  { value: 'factura_b', label: 'Factura B', iva: false },
  { value: 'factura_c', label: 'Factura C', iva: false },
  { value: 'recibo', label: 'Recibo', iva: false },
  { value: 'ticket', label: 'Ticket', iva: false },
  { value: 'sin_comprobante', label: 'Sin comprobante', iva: false },
  { value: 'otro', label: 'Otro', iva: false },
]
const SITUACIONES = [
  { value: 'responsable_inscripto', label: 'Responsable Inscripto', comprobante: 'factura_a', iva: true },
  { value: 'monotributo', label: 'Monotributo', comprobante: 'factura_c', iva: false },
  { value: 'exento', label: 'Exento', comprobante: 'factura_b', iva: false },
  { value: 'consumidor_final', label: 'Consumidor Final', comprobante: 'ticket', iva: false },
]
const MEDIOS_PAGO = [
  { value: 'transferencia', label: 'Transferencia bancaria' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'tarjeta', label: 'Tarjeta' },
]

const getSituacion = (val) => SITUACIONES.find(s => s.value === val) ?? SITUACIONES[0]
const getTipoLabel = (val) => TIPOS_COMPROBANTE.find(t => t.value === val)?.label ?? val
const fmt = (n) => new Intl.NumberFormat('es-AR', { style: 'decimal', maximumFractionDigits: 0 }).format(n ?? 0)
const hoy = () => new Date().toISOString().slice(0, 10)

const C = {
  bg: '#F7F7F7', surface: '#FFFFFF', border: '#EBEBEB', borderFaint: '#F5F5F5',
  purple: '#7B4DB5', purpleLight: '#9B6DD5', purpleDim: '#F3F0FF',
  text: '#1A1A1A', textMuted: '#888888', textFaint: '#CDCDCD',
  green: '#1A6B3C', greenDim: '#EDFAF3',
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
  return { clientes, proveedores, bancos, recargarListas: cargar }
}

function useObras() {
  const [obras, setObras] = useState([])
  const [loading, setLoading] = useState(true)
  const cargar = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.from('obras_resumen').select('*').order('nombre')
    if (!error) setObras(data ?? [])
    setLoading(false)
  }, [])
  useEffect(() => { cargar() }, [cargar])
  return { obras, loading, recargar: cargar }
}

function useGastos(obraIdFiltro) {
  const [gastos, setGastos] = useState([])
  const [loading, setLoading] = useState(true)
  const cargar = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('gastos')
      .select('*, obras(nombre), proveedores(nombre, situacion_impositiva), pagos(id, medio_pago, monto, fecha_pago, banco_id, comprobante_url, bancos(nombre))')
      .order('fecha', { ascending: false })
    if (obraIdFiltro) q = q.eq('obra_id', obraIdFiltro)
    const { data, error } = await q
    if (!error) setGastos(data ?? [])
    setLoading(false)
  }, [obraIdFiltro])
  useEffect(() => { cargar() }, [cargar])
  return { gastos, loading, recargar: cargar }
}

// ── App ───────────────────────────────────────────────────────
export default function GestorObras({ usuario }) {
  const esAdmin = usuario?.perfil?.rol === 'admin'
  const [panel, setPanel] = useState('obras')
  const [filtroObraId, setFiltroObraId] = useState('')
  const [modal, setModal] = useState(null)
  const [itemEditando, setItemEditando] = useState(null)
  const [proveedorPendiente, setProveedorPendiente] = useState(null)
  const [onProveedorCreado, setOnProveedorCreado] = useState(null)

  const { clientes, proveedores, bancos, recargarListas } = useListas()
  const { obras, loading: loadingObras, recargar: recargarObras } = useObras()
  const { gastos, loading: loadingGastos, recargar: recargarGastos } = useGastos(
    panel === 'gastos' ? filtroObraId : ''
  )
  const recargarTodo = () => { recargarObras(); recargarGastos() }
  const abrirModal = (tipo, item = null) => { setItemEditando(item); setModal(tipo) }
  const cerrarModal = () => { setModal(null); setItemEditando(null) }

  const handleLogout = async () => {
    await supabase.auth.signOut()
  }

  useEffect(() => {
    document.body.style.margin = '0'
    document.body.style.padding = '0'
    document.body.style.overflowX = 'hidden'
    document.body.style.background = C.bg
  }, [])

  const TABS = [
    { id: 'obras', label: 'Obras' },
    { id: 'gastos', label: 'Gastos' },
    { id: 'informe', label: 'Informe' },
    { id: 'contactos', label: 'Contactos' },
    ...(esAdmin ? [{ id: 'admin', label: '⚙ Admin' }] : []),
  ]

  const guardarProveedor = async (datos) => {
    const { nombre, cuit, rubro, situacion_impositiva } = datos
    const { data, error } = await supabase.from('proveedores').insert([{ nombre, cuit, rubro, situacion_impositiva }]).select().single()
    if (error) { alert('Error: ' + error.message); return }
    await recargarListas()
    if (onProveedorCreado) onProveedorCreado(data)
    setProveedorPendiente(null)
    setOnProveedorCreado(null)
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body { font-family: 'Outfit', sans-serif !important; background: ${C.bg}; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #DCDCDC; border-radius: 99px; }
        input, select, textarea { font-family: 'Outfit', sans-serif; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .card-hover { transition: box-shadow 0.15s, border-color 0.15s; }
        .card-hover:hover { border-color: #D0D0D0 !important; box-shadow: 0 4px 16px rgba(0,0,0,0.06) !important; }
        .fade-up { animation: fadeUp 0.22s ease forwards; }
        @media (max-width: 639px) {
          .desktop-only { display: none !important; }
          .mobile-tabs { display: flex !important; }
          .main-content { padding-bottom: 72px !important; }
          .topbar-nav { display: none !important; }
        }
        @media (min-width: 640px) {
          .mobile-only { display: none !important; }
          .mobile-tabs { display: none !important; }
        }
      `}</style>

      <div style={{ minHeight: '100vh', background: C.bg, fontFamily: "'Outfit', sans-serif", width: '100%', overflowX: 'hidden' }}>
        {/* TOPBAR */}
        <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0, zIndex: 50 }}>
          <div style={{ maxWidth: 1060, margin: '0 auto', padding: '0 20px', display: 'flex', alignItems: 'center', height: 54, gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
              <div style={{ width: 30, height: 30, background: C.purple, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="17" height="17" viewBox="0 0 100 100" fill="none">
                  <polygon points="50,4 93,27.5 93,72.5 50,96 7,72.5 7,27.5" fill="none" stroke="#fff" strokeWidth="11"/>
                  <polygon points="50,24 74,37 74,63 50,76 26,63 26,37" fill="none" stroke="#fff" strokeWidth="8"/>
                  <line x1="50" y1="24" x2="50" y2="76" stroke="#fff" strokeWidth="5" opacity=".4"/>
                  <line x1="26" y1="37" x2="74" y2="37" stroke="#fff" strokeWidth="5" opacity=".4"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text, letterSpacing: '0.06em', lineHeight: 1 }}>SEATE</div>
                <div style={{ fontSize: 9, color: C.textFaint, letterSpacing: '0.1em', marginTop: 1 }}>CONSTRUCCIONES</div>
              </div>
            </div>

            <nav className="topbar-nav" style={{ display: 'flex', marginLeft: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
              {TABS.map(t => (
                <button key={t.id} onClick={() => setPanel(t.id)} style={{
                  padding: '6px 16px', fontSize: 12, cursor: 'pointer', border: 'none',
                  borderRight: `1px solid ${C.border}`, fontFamily: "'Outfit', sans-serif",
                  fontWeight: panel === t.id ? 600 : 400,
                  background: panel === t.id ? C.purpleDim : C.surface,
                  color: panel === t.id ? C.purple : C.textMuted,
                  transition: 'all 0.12s', whiteSpace: 'nowrap',
                }}>
                  {t.label}
                </button>
              ))}
            </nav>

            {/* Usuario + logout */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8, flexShrink: 0 }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{usuario?.perfil?.nombre ?? usuario?.email}</div>
                <div style={{ fontSize: 10, color: esAdmin ? C.purple : C.textFaint, fontWeight: 600 }}>{esAdmin ? 'Admin' : 'Operador'}</div>
              </div>
              <button onClick={handleLogout} style={{ padding: '5px 10px', background: 'transparent', color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 11, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>
                Salir
              </button>
            </div>
          </div>
        </div>

        {/* CONTENIDO */}
        <div className="main-content" style={{ maxWidth: 1060, margin: '0 auto', padding: '24px 20px', width: '100%' }}>
          <div className="fade-up" key={panel}>
            {panel === 'obras'     && <PanelObras obras={obras} loading={loadingObras} esAdmin={esAdmin} onNueva={() => abrirModal('obra')} onEditar={o => abrirModal('obra', o)} onVerGastos={id => { setFiltroObraId(id); setPanel('gastos') }} />}
            {panel === 'gastos'    && <PanelGastos obras={obras} gastos={gastos} loading={loadingGastos} filtroObraId={filtroObraId} setFiltroObraId={setFiltroObraId} esAdmin={esAdmin} onNuevoManual={() => abrirModal('gasto')} onNuevoFoto={() => abrirModal('foto')} onEditar={g => abrirModal('gasto', g)} onPagar={g => abrirModal('pago', g)} onEliminar={async id => { if (window.confirm('¿Eliminar este gasto?')) { await supabase.from('gastos').delete().eq('id', id); recargarTodo() } }} onRecargar={recargarGastos} />}
            {panel === 'informe'   && <PanelInforme obras={obras} />}
            {panel === 'contactos' && <PanelContactos clientes={clientes} proveedores={proveedores} esAdmin={esAdmin} onNuevoCliente={() => abrirModal('cliente')} onNuevoProveedor={() => abrirModal('proveedor')} onEditarCliente={c => abrirModal('cliente', c)} onEditarProveedor={p => abrirModal('proveedor', p)} />}
            {panel === 'admin' && esAdmin && <PanelAdmin bancos={bancos} recargarListas={recargarListas} />}
          </div>
        </div>

        {/* BOTTOM NAV MOBILE */}
        <div className="mobile-tabs" style={{ display: 'none', position: 'fixed', bottom: 0, left: 0, right: 0, background: C.surface, borderTop: `1px solid ${C.border}`, zIndex: 50, paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}>
          <div style={{ display: 'flex' }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setPanel(t.id)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '8px 0', border: 'none', background: 'transparent', cursor: 'pointer', color: panel === t.id ? C.purple : C.textFaint }}>
                <span style={{ fontSize: 10, fontWeight: panel === t.id ? 600 : 400, fontFamily: "'Outfit', sans-serif" }}>{t.label}</span>
                {panel === t.id && <div style={{ width: 20, height: 2, borderRadius: 99, background: C.purple }} />}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* MODALES */}
      {modal === 'obra' && <ModalObra itemEdit={itemEditando} clientes={clientes} onClose={cerrarModal} onGuardar={async d => {
        if (!d.nombre) return alert('El nombre es obligatorio')
        const { id, nombre, cliente_id, estado, presupuesto } = d
        const payload = { nombre, cliente_id: cliente_id || null, estado, presupuesto: parseFloat(presupuesto) || 0 }
        const res = id ? await supabase.from('obras').update(payload).eq('id', id) : await supabase.from('obras').insert([payload])
        if (res.error) alert('Error: ' + res.error.message)
        else { cerrarModal(); recargarObras() }
      }} />}

      {modal === 'gasto' && <ModalGasto itemEdit={itemEditando} obras={obras} proveedores={proveedores} obraIdDefecto={filtroObraId} onClose={cerrarModal}
        onNuevoProveedor={(nombre, cb) => { setProveedorPendiente({ nombre }); setOnProveedorCreado(() => cb) }}
        onGuardar={async d => {
          if (!d.monto || d.monto <= 0) return alert('Ingresá un monto válido')
          const { id, obra_id, fecha, proveedor_id, concepto, monto, descripcion, tipo_comprobante, discrimina_iva, nro_comprobante } = d
          const payload = { obra_id, fecha, proveedor_id: proveedor_id || null, concepto, monto: parseFloat(monto) || 0, descripcion, tipo_comprobante, discrimina_iva, nro_comprobante }
          const res = id ? await supabase.from('gastos').update(payload).eq('id', id) : await supabase.from('gastos').insert([payload])
          if (res.error) alert('Error: ' + res.error.message)
          else { cerrarModal(); recargarTodo() }
        }}
      />}

      {modal === 'foto' && <ModalFoto obras={obras} proveedores={proveedores} obraIdDefecto={filtroObraId} onClose={cerrarModal}
        onNuevoProveedor={(nombre, cb) => { setProveedorPendiente({ nombre }); setOnProveedorCreado(() => cb) }}
        onGuardar={async d => {
          const { error } = await supabase.from('gastos').insert([d])
          if (error) alert('Error: ' + error.message)
          else { cerrarModal(); recargarTodo() }
        }}
      />}

      {modal === 'pago' && esAdmin && <ModalPago gasto={itemEditando} bancos={bancos} onClose={cerrarModal} onGuardar={async d => {
        const payload = { ...d, gasto_id: itemEditando.id, creado_por: usuario.id }
        const { error } = await supabase.from('pagos').insert([payload])
        if (error) { alert('Error: ' + error.message); return }
        await supabase.from('gastos').update({ pagado: true }).eq('id', itemEditando.id)
        cerrarModal(); recargarGastos()
      }} />}

      {modal === 'cliente'   && <ModalCliente   itemEdit={itemEditando} onClose={cerrarModal} onGuardar={async d => { if (!d.nombre) return alert('Nombre obligatorio'); const { id, nombre, telefono, email } = d; const res = id ? await supabase.from('clientes').update({ nombre, telefono, email }).eq('id', id) : await supabase.from('clientes').insert([{ nombre, telefono, email }]); if (res.error) alert('Error: ' + res.error.message); else { cerrarModal(); recargarListas() } }} />}
      {modal === 'proveedor' && <ModalProveedor itemEdit={itemEditando} onClose={cerrarModal} onGuardar={async d => { if (!d.nombre) return alert('Nombre obligatorio'); const { id, nombre, cuit, rubro, situacion_impositiva } = d; const res = id ? await supabase.from('proveedores').update({ nombre, cuit, rubro, situacion_impositiva }).eq('id', id) : await supabase.from('proveedores').insert([{ nombre, cuit, rubro, situacion_impositiva }]); if (res.error) alert('Error: ' + res.error.message); else { cerrarModal(); recargarListas() } }} />}

      {proveedorPendiente && <ModalAltaProveedor datosIniciales={proveedorPendiente} onClose={() => { setProveedorPendiente(null); setOnProveedorCreado(null) }} onGuardar={guardarProveedor} />}
    </>
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
              <button key={f.value} onClick={() => setFiltroEstado(f.value)} style={{
                padding: '6px 12px', fontSize: 12, cursor: 'pointer', border: 'none',
                borderRight: `1px solid ${C.border}`, fontFamily: "'Outfit', sans-serif",
                fontWeight: filtroEstado === f.value ? 600 : 400,
                background: filtroEstado === f.value ? C.purpleDim : C.surface,
                color: filtroEstado === f.value ? C.purple : C.textMuted,
                whiteSpace: 'nowrap',
              }}>{f.label}</button>
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
                    <div style={{ fontSize: 24, fontWeight: 700, color: C.text, fontFamily: "'DM Mono', monospace", letterSpacing: '-0.02em' }}>$ {fmt(o.total_gastado)}</div>
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
function PanelGastos({ obras, gastos, loading, filtroObraId, setFiltroObraId, esAdmin, onNuevoManual, onNuevoFoto, onEditar, onPagar, onEliminar, onRecargar }) {
  const total = gastos.reduce((s, g) => s + (g.monto ?? 0), 0)
  const pagados = gastos.filter(g => g.pagado).reduce((s, g) => s + (g.monto ?? 0), 0)
  const pendientes = total - pagados

  return (
    <div>
      <PageHeader titulo="Gastos" sub={`Total: $ ${fmt(total)}`}>
        <div style={{ display: 'flex', gap: 8 }}>
          <BtnSecondary onClick={onNuevoFoto}>📷 Foto</BtnSecondary>
          <BtnPrimary onClick={onNuevoManual}>+ Gasto</BtnPrimary>
        </div>
      </PageHeader>

      {/* Resumen pagos */}
      {gastos.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
          {[
            { label: 'Total', value: `$ ${fmt(total)}`, color: C.text },
            { label: 'Pagado', value: `$ ${fmt(pagados)}`, color: C.green },
            { label: 'Pendiente', value: `$ ${fmt(pendientes)}`, color: pendientes > 0 ? '#D0021B' : C.textFaint },
          ].map(s => (
            <div key={s.label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ fontSize: 10, color: C.textFaint, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{s.label}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: s.color, fontFamily: "'DM Mono', monospace" }}>{s.value}</div>
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
          <div className="mobile-only" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {gastos.map(g => (
              <div key={g.id} style={{ ...cardSt, padding: '13px 15px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{g.proveedores?.nombre ?? 'Sin proveedor'}</div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{g.obras?.nombre ?? '—'} · {g.fecha}</div>
                  </div>
                  <div style={{ textAlign: 'right', marginLeft: 12 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.text, fontFamily: "'DM Mono', monospace", whiteSpace: 'nowrap' }}>$ {fmt(g.monto)}</div>
                    <PagoBadge pagado={g.pagado} />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    <ConceptoBadge concepto={g.concepto} />
                    {g.tipo_comprobante && <ComprobanteBadge tipo={g.tipo_comprobante} iva={g.discrimina_iva} />}
                  </div>
                  <div style={{ display: 'flex', gap: 5 }}>
                    {esAdmin && !g.pagado && <button style={{ ...btnIconSt, color: C.green, background: C.greenDim, borderColor: '#B8E6CF' }} onClick={() => onPagar(g)}>$ Pagar</button>}
                    {g.imagen_url && <a href={g.imagen_url} target="_blank" rel="noreferrer" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>📎</a>}
                    {g.pagos?.length > 0 && g.pagos[0].comprobante_url && <a href={g.pagos[0].comprobante_url} target="_blank" rel="noreferrer" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', color: C.green }}>🧾</a>}
                    <button style={btnIconSt} onClick={() => onEditar(g)}>✏️</button>
                    <button style={{ ...btnIconSt, color: '#D0021B', background: '#FFF0F0', borderColor: '#FFDCDC' }} onClick={() => onEliminar(g.id)}>✕</button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* DESKTOP */}
          <div className="desktop-only" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 86 }} />
                <col style={{ width: 108 }} />
                <col style={{ width: 118 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 98 }} />
                <col />
                <col style={{ width: 110 }} />
                <col style={{ width: 72 }} />
                <col style={{ width: esAdmin ? 120 : 90 }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}`, background: '#FAFAFA' }}>
                  {['Fecha','Obra','Proveedor','Concepto','Comprobante','Descripción','Monto','Estado', ''].map((h,i) => (
                    <th key={h+i} style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textAlign: h==='Monto'?'right':'left', padding: '10px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gastos.map((g, i) => (
                  <tr key={g.id} style={{ borderBottom: i < gastos.length - 1 ? `1px solid ${C.borderFaint}` : 'none', background: g.pagado ? '#FAFFFE' : 'white' }}>
                    <td style={{ ...tdSt, whiteSpace: 'nowrap', fontFamily: "'DM Mono', monospace", fontSize: 11, color: C.textMuted }}>{g.fecha}</td>
                    <td style={tdSt}><span style={{ fontSize: 11, padding: '2px 7px', background: C.purpleDim, color: C.purple, borderRadius: 99, fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.obras?.nombre ?? '—'}</span></td>
                    <td style={{ ...tdSt, fontWeight: 500, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.proveedores?.nombre ?? '—'}</td>
                    <td style={tdSt}><ConceptoBadge concepto={g.concepto} /></td>
                    <td style={tdSt}><ComprobanteBadge tipo={g.tipo_comprobante} iva={g.discrimina_iva} /></td>
                    <td style={{ ...tdSt, color: C.textMuted, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.descripcion}</td>
                    <td style={{ ...tdSt, textAlign: 'right', fontWeight: 700, color: C.text, fontFamily: "'DM Mono', monospace", whiteSpace: 'nowrap' }}>$ {fmt(g.monto)}</td>
                    <td style={tdSt}><PagoBadge pagado={g.pagado} /></td>
                    <td style={{ ...tdSt, padding: '8px 8px' }}>
                      <div style={{ display: 'flex', gap: 3, justifyContent: 'flex-end' }}>
                        {esAdmin && !g.pagado && <button style={{ ...btnIconSt, fontSize: 10, color: C.green, background: C.greenDim, borderColor: '#B8E6CF', padding: '4px 7px' }} onClick={() => onPagar(g)}>Pagar</button>}
                        {g.imagen_url && <a href={g.imagen_url} target="_blank" rel="noreferrer" title="Ver factura" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>📎</a>}
                        {g.pagos?.length > 0 && g.pagos[0].comprobante_url && <a href={g.pagos[0].comprobante_url} target="_blank" rel="noreferrer" title="Ver comprobante de pago" style={{ ...btnIconSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', color: C.green }}>🧾</a>}
                        <button style={btnIconSt} onClick={() => onEditar(g)}>✏️</button>
                        <button style={{ ...btnIconSt, color: '#D0021B', background: '#FFF0F0', borderColor: '#FFDCDC' }} onClick={() => onEliminar(g.id)}>✕</button>
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
function PanelInforme({ obras }) {
  const [obraId, setObraId] = useState('')
  const { gastos, loading } = useGastos(obraId)
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
              { label: 'Total gastos',  value: `$ ${fmt(total)}`,              sub: `${gastos.length} comprobantes` },
              { label: 'Pagado',        value: `$ ${fmt(pagado)}`,             sub: `${total > 0 ? Math.round(pagado/total*100) : 0}% del total` },
              { label: 'Pendiente',     value: `$ ${fmt(total - pagado)}`,     sub: `${gastos.filter(g => !g.pagado).length} facturas` },
              { label: 'Obras activas', value: obras.filter(o => o.estado === 'activa').length, sub: `de ${obras.length} total` },
            ].map(s => (
              <div key={s.label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px' }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{s.label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: C.text, fontFamily: "'DM Mono', monospace" }}>{s.value}</div>
                <div style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}>{s.sub}</div>
              </div>
            ))}
          </div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '18px 20px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>Desglose por rubro</div>
            {CONCEPTOS.map(c => {
              const [, color] = CONCEPTO_COLORS[c]
              return (
                <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <div style={{ width: 100, fontSize: 12, color: C.textMuted, flexShrink: 0 }}>{CONCEPTO_LABELS[c]}</div>
                  <div style={{ flex: 1, height: 4, background: C.borderFaint, borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 99, width: `${Math.round(porConcepto[c] / maxVal * 100)}%`, background: color, transition: 'width 0.5s' }} />
                  </div>
                  <div style={{ width: 96, fontSize: 12, fontWeight: 600, color: C.text, textAlign: 'right', fontFamily: "'DM Mono', monospace", flexShrink: 0, whiteSpace: 'nowrap' }}>$ {fmt(porConcepto[c])}</div>
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
function PanelContactos({ clientes, proveedores, esAdmin, onNuevoCliente, onNuevoProveedor, onEditarCliente, onEditarProveedor }) {
  return (
    <div>
      <PageTitle titulo="Contactos" sub="Clientes y proveedores" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, marginTop: 20 }}>
        <ContactoCol titulo="Clientes" items={clientes} onNuevo={onNuevoCliente} onEditar={onEditarCliente} btnLabel="+ Cliente" renderSub={c => [c.telefono, c.email].filter(Boolean).join(' · ')} />
        <ContactoCol titulo="Proveedores" items={proveedores} onNuevo={onNuevoProveedor} onEditar={onEditarProveedor} btnLabel="+ Proveedor" outline renderSub={p => { const sit = getSituacion(p.situacion_impositiva); return [sit.label, p.cuit && `CUIT: ${p.cuit}`].filter(Boolean).join(' · ') }} />
      </div>
    </div>
  )
}

function ContactoCol({ titulo, items, onNuevo, onEditar, btnLabel, outline, renderSub }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h2 style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, margin: 0, textTransform: 'uppercase', letterSpacing: '0.09em' }}>{titulo} ({items.length})</h2>
        {onNuevo && (outline ? <BtnSecondary onClick={onNuevo}>{btnLabel}</BtnSecondary> : <BtnPrimary onClick={onNuevo}>{btnLabel}</BtnPrimary>)}
      </div>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        {items.length === 0 ? <div style={{ padding: '20px 16px', color: C.textFaint, fontSize: 13, textAlign: 'center' }}>Sin registros</div>
        : items.map((item, i) => (
          <div key={item.id} style={{ padding: '12px 16px', borderBottom: i < items.length - 1 ? `1px solid ${C.borderFaint}` : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{item.nombre}</div>
              {renderSub(item) && <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{renderSub(item)}</div>}
            </div>
            {onEditar && <button style={btnIconSt} onClick={() => onEditar(item)}>✏️</button>}
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

  const agregarBanco = async () => {
    if (!nuevoNombre.trim()) return
    setGuardando(true)
    await supabase.from('bancos').insert([{ nombre: nuevoNombre.trim(), tipo: nuevoTipo }])
    setNuevoNombre('')
    await recargarListas()
    setGuardando(false)
  }

  return (
    <div>
      <PageTitle titulo="Administración" sub="Configuración del sistema" />
      <div style={{ marginTop: 20, maxWidth: 480 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 12 }}>Bancos y billeteras</div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
          {bancos.map((b, i) => (
            <div key={b.id} style={{ padding: '10px 16px', borderBottom: i < bancos.length - 1 ? `1px solid ${C.borderFaint}` : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: C.text }}>{b.nombre}</span>
              <span style={{ fontSize: 10, color: C.textFaint, background: C.borderFaint, padding: '2px 8px', borderRadius: 99, fontWeight: 600 }}>{b.tipo}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...inputSt, flex: 1 }} value={nuevoNombre} onChange={e => setNuevoNombre(e.target.value)} placeholder="Nombre del banco / billetera" />
          <select style={{ ...inputSt, width: 120 }} value={nuevoTipo} onChange={e => setNuevoTipo(e.target.value)}>
            <option value="banco">Banco</option>
            <option value="billetera">Billetera</option>
          </select>
          <BtnPrimary onClick={agregarBanco}>{guardando ? '...' : '+ Agregar'}</BtnPrimary>
        </div>
      </div>
    </div>
  )
}

// ── Modal Pago ────────────────────────────────────────────────
function ModalPago({ gasto, bancos, onClose, onGuardar }) {
  const [form, setForm] = useState({
    fecha_pago: hoy(),
    medio_pago: 'transferencia',
    monto: gasto?.monto ?? '',
    banco_id: '',
    nro_operacion: '',
    titular_tarjeta: '',
    observaciones: '',
    comprobante_url: '',
  })
  const [archivoNombre, setArchivoNombre] = useState('')
  const [subiendo, setSubiendo] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const necesitaBanco = ['transferencia', 'cheque', 'tarjeta'].includes(form.medio_pago)

  const subirComprobante = async (file) => {
    setSubiendo(true)
    const ext = file.name.split('.').pop()
    const path = `pagos/${Date.now()}.${ext}`
    const { data, error } = await supabase.storage.from('comprobantes-pagos').upload(path, file)
    if (error) { alert('Error al subir archivo: ' + error.message); setSubiendo(false); return }
    const url = supabase.storage.from('comprobantes-pagos').getPublicUrl(path).data.publicUrl
    set('comprobante_url', url)
    setArchivoNombre(file.name)
    setSubiendo(false)
  }

  return (
    <Modal title={`Registrar pago — $ ${fmt(gasto?.monto)}`} onClose={onClose} onGuardar={() => onGuardar({ ...form, monto: parseFloat(form.monto) || 0, banco_id: form.banco_id || null })} guardarLabel="Confirmar pago">
      {/* Info del gasto */}
      <div style={{ background: C.purpleDim, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12 }}>
        <div style={{ fontWeight: 600, color: C.text, marginBottom: 2 }}>{gasto?.proveedores?.nombre ?? 'Sin proveedor'}</div>
        <div style={{ color: C.textMuted }}>{gasto?.obras?.nombre} · {gasto?.fecha} · {getTipoLabel(gasto?.tipo_comprobante)}</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Campo label="Fecha de pago">
          <input style={inputSt} type="date" value={form.fecha_pago} onChange={e => set('fecha_pago', e.target.value)} />
        </Campo>
        <Campo label="Monto pagado">
          <input style={inputSt} type="number" value={form.monto} onChange={e => set('monto', e.target.value)} />
        </Campo>
        <Campo label="Medio de pago" style={{ gridColumn: '1/-1' }}>
          <select style={inputSt} value={form.medio_pago} onChange={e => set('medio_pago', e.target.value)}>
            {MEDIOS_PAGO.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Campo>

        {necesitaBanco && (
          <Campo label="Banco" style={{ gridColumn: '1/-1' }}>
            <select style={inputSt} value={form.banco_id} onChange={e => set('banco_id', e.target.value)}>
              <option value="">Seleccionar banco...</option>
              {bancos.map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}
            </select>
          </Campo>
        )}

        {form.medio_pago === 'tarjeta' && (
          <Campo label="Titular de la tarjeta" style={{ gridColumn: '1/-1' }}>
            <input style={inputSt} value={form.titular_tarjeta} onChange={e => set('titular_tarjeta', e.target.value)} placeholder="Nombre del titular" />
          </Campo>
        )}

        {['transferencia', 'cheque'].includes(form.medio_pago) && (
          <Campo label={form.medio_pago === 'cheque' ? 'Nro. de cheque (opcional)' : 'Nro. de operación (opcional)'} style={{ gridColumn: '1/-1' }}>
            <input style={inputSt} value={form.nro_operacion} onChange={e => set('nro_operacion', e.target.value)} placeholder="Opcional" />
          </Campo>
        )}

        <Campo label="Observaciones (opcional)" style={{ gridColumn: '1/-1' }}>
          <textarea style={{ ...inputSt, minHeight: 56, resize: 'vertical' }} value={form.observaciones} onChange={e => set('observaciones', e.target.value)} />
        </Campo>

        {/* Comprobante de pago */}
        <Campo label="Comprobante de pago (opcional)" style={{ gridColumn: '1/-1' }}>
          {form.comprobante_url ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: C.greenDim, border: `1px solid #B8E6CF`, borderRadius: 8 }}>
              <span style={{ fontSize: 18 }}>📎</span>
              <span style={{ fontSize: 12, color: C.green, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{archivoNombre}</span>
              <a href={form.comprobante_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>Ver</a>
              <button onClick={() => { set('comprobante_url', ''); setArchivoNombre('') }} style={{ fontSize: 11, color: '#D0021B', background: 'transparent', border: 'none', cursor: 'pointer' }}>✕</button>
            </div>
          ) : (
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#FAFAFA', border: `1.5px dashed ${C.border}`, borderRadius: 8, cursor: 'pointer' }}>
              <span style={{ fontSize: 18 }}>{subiendo ? '⏳' : '📎'}</span>
              <span style={{ fontSize: 12, color: C.textMuted }}>{subiendo ? 'Subiendo...' : 'Subir foto o PDF del comprobante'}</span>
              <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => e.target.files[0] && subirComprobante(e.target.files[0])} disabled={subiendo} />
            </label>
          )}
        </Campo>
      </div>
    </Modal>
  )
}

// ── FormGasto compartido ──────────────────────────────────────
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
          <button type="button" onClick={() => onNuevoProveedor && onNuevoProveedor('', (p) => handleProveedorChange(p.id))}
            style={{ padding: '8px 12px', background: C.purpleDim, color: C.purple, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600 }}>
            + Alta
          </button>
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
          <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 4 }}>{form.discrimina_iva ? '→ Factura A (Resp. Inscripto)' : '→ Sin IVA discriminado'}</span>
        </label>
      </Campo>
      <Campo label="Descripción" style={{ gridColumn: '1/-1' }}><textarea style={{ ...inputSt, minHeight: 64, resize: 'vertical' }} value={form.descripcion || ''} onChange={e => set('descripcion', e.target.value)} /></Campo>
    </div>
  )
}

// ── Modales ───────────────────────────────────────────────────
function ModalGasto({ itemEdit, obras, proveedores, obraIdDefecto, onClose, onGuardar, onNuevoProveedor }) {
  const [form, setForm] = useState(itemEdit || { obra_id: obraIdDefecto || obras[0]?.id || '', fecha: hoy(), proveedor_id: '', concepto: 'materiales', monto: '', descripcion: '', tipo_comprobante: 'factura_a', discrimina_iva: true, nro_comprobante: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <Modal title={itemEdit ? 'Editar Gasto' : 'Registrar Gasto'} onClose={onClose} onGuardar={() => onGuardar(form)}>
      <FormGasto form={form} set={set} obras={obras} proveedores={proveedores} onNuevoProveedor={onNuevoProveedor} />
    </Modal>
  )
}

function ModalFoto({ obras, proveedores, obraIdDefecto, onClose, onGuardar, onNuevoProveedor }) {
  const [step, setStep] = useState('upload')
  const [form, setForm] = useState({ obra_id: obraIdDefecto || obras[0]?.id || '', fecha: hoy(), proveedor_id: '', concepto: 'materiales', monto: '', descripcion: '', imagen_url: '', tipo_comprobante: 'factura_a', discrimina_iva: true, nro_comprobante: '' })
  const [preview, setPreview] = useState(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const procesarFoto = async (file) => {
    setPreview(URL.createObjectURL(file))
    setStep('loading')
    const ext = file.name.split('.').pop()
    const path = `comprobantes/${Date.now()}.${ext}`
    const { data: uploadData } = await supabase.storage.from('comprobantes').upload(path, file)
    const imageUrl = uploadData ? supabase.storage.from('comprobantes').getPublicUrl(path).data.publicUrl : ''
    const base64 = await new Promise(res => { const r = new FileReader(); r.onload = e => res(e.target.result.split(',')[1]); r.readAsDataURL(file) })
    try {
      const { data, error } = await supabase.functions.invoke('analizar-comprobante', { body: { base64, mimeType: file.type, hoy: hoy() } })
      if (error) throw new Error('Error al conectar')
      if (data?.error) { setForm(f => ({ ...f, imagen_url: imageUrl })); setStep('review'); return }
      const text = data.content.map(i => i.text || '').join('')
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
      const nombreIA = parsed.proveedor || ''
      const matchProv = proveedores.find(p => p.nombre.toLowerCase().includes(nombreIA.toLowerCase()))
      let tipo = 'factura_a', iva = true
      if (matchProv) { const sit = getSituacion(matchProv.situacion_impositiva); tipo = sit.comprobante; iva = sit.iva }
      setForm(f => ({ ...f, fecha: parsed.fecha || hoy(), proveedor_id: matchProv ? matchProv.id : '', concepto: parsed.concepto || 'varios', monto: parsed.monto || '', descripcion: (parsed.descripcion || '') + (nombreIA && !matchProv ? ` (IA detectó prov: ${nombreIA})` : ''), imagen_url: imageUrl, tipo_comprobante: tipo, discrimina_iva: iva }))
      if (nombreIA && !matchProv) {
        onNuevoProveedor && onNuevoProveedor(nombreIA, (nuevoProv) => {
          const sit = getSituacion(nuevoProv.situacion_impositiva)
          setForm(f => ({ ...f, proveedor_id: nuevoProv.id, tipo_comprobante: sit.comprobante, discrimina_iva: sit.iva, descripcion: parsed.descripcion || '' }))
        })
      }
    } catch (err) { console.error(err); setForm(f => ({ ...f, imagen_url: imageUrl })) }
    setStep('review')
  }

  return (
    <Modal title="Cargar comprobante" onClose={onClose} onGuardar={step === 'review' ? () => onGuardar({ ...form, proveedor_id: form.proveedor_id || null, monto: parseFloat(form.monto) || 0 }) : null} guardarLabel="Guardar gasto">
      {step === 'upload' && (
        <label style={{ display: 'block', border: `1.5px dashed ${C.border}`, borderRadius: 10, padding: '32px 24px', textAlign: 'center', cursor: 'pointer', background: '#FAFAFA' }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>📷</div>
          <div style={{ fontSize: 14, color: C.textMuted, fontWeight: 500 }}>Tocá para subir foto del comprobante</div>
          <div style={{ fontSize: 11, color: C.textFaint, marginTop: 6 }}>JPG, PNG, WEBP — ticket, factura, remito</div>
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => e.target.files[0] && procesarFoto(e.target.files[0])} />
        </label>
      )}
      {step === 'loading' && (
        <div style={{ textAlign: 'center', padding: '32px 0' }}>
          {preview && <img src={preview} alt="" style={{ maxHeight: 120, borderRadius: 8, marginBottom: 16, opacity: 0.6 }} />}
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

function ModalAltaProveedor({ datosIniciales, onClose, onGuardar }) {
  const [form, setForm] = useState({ nombre: datosIniciales?.nombre || '', cuit: '', rubro: '', situacion_impositiva: 'responsable_inscripto' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const sit = getSituacion(form.situacion_impositiva)
  return (
    <Modal title="Dar de alta proveedor" onClose={onClose} onGuardar={() => onGuardar(form)} guardarLabel="Dar de alta">
      <div style={{ background: C.purpleDim, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: C.purple }}>
        <strong>Proveedor detectado por IA</strong> — completá los datos fiscales.
      </div>
      <Campo label="Nombre / Razón Social" style={{ marginBottom: 10 }}><input style={inputSt} value={form.nombre} onChange={e => set('nombre', e.target.value)} /></Campo>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <Campo label="CUIT / RUT"><input style={inputSt} value={form.cuit} onChange={e => set('cuit', e.target.value)} placeholder="Sin guiones" /></Campo>
        <Campo label="Rubro"><input style={inputSt} value={form.rubro} onChange={e => set('rubro', e.target.value)} /></Campo>
      </div>
      <Campo label="Situación impositiva" style={{ marginBottom: 12 }}>
        <select style={inputSt} value={form.situacion_impositiva} onChange={e => set('situacion_impositiva', e.target.value)}>
          {SITUACIONES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </Campo>
      <div style={{ background: '#F9F9F9', border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
        <div style={{ color: C.textFaint, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Se sugerirá automáticamente</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontWeight: 600, color: C.text }}>{getTipoLabel(sit.comprobante)}</span>
          <span style={{ fontSize: 11, color: sit.iva ? C.green : C.textMuted, background: sit.iva ? C.greenDim : '#F3F3F3', padding: '2px 8px', borderRadius: 99, fontWeight: 600 }}>
            {sit.iva ? 'Discrimina IVA' : 'Sin IVA'}
          </span>
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
        <Campo label="Rubro"><input style={inputSt} value={form.rubro || ''} onChange={e => set('rubro', e.target.value)} /></Campo>
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

// ── UI genérico ───────────────────────────────────────────────
function Modal({ title, children, onClose, onGuardar, guardarLabel = 'Guardar' }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 22, width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box', boxShadow: '0 8px 40px rgba(0,0,0,0.12)' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 18 }}>{title}</h3>
        {children}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button style={{ padding: '8px 16px', background: 'transparent', color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }} onClick={onClose}>Cancelar</button>
          {onGuardar && <button style={{ padding: '8px 20px', background: C.purple, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontWeight: 600, fontFamily: "'Outfit', sans-serif" }} onClick={onGuardar}>{guardarLabel}</button>}
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
  return <span style={{ background: pagado ? C.greenDim : '#FFF8ED', color: pagado ? C.green : '#8A5200', padding: '2px 9px', borderRadius: 99, fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>{pagado ? '✓ Pagado' : 'Pendiente'}</span>
}

function EstadoBadge({ estado }) {
  const m = { activa: [C.purpleDim, C.purple], pausada: ['#FFF8ED','#8A5200'], finalizada: ['#F3F3F3','#888888'] }
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
const cardSt   = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, cursor: 'pointer' }
const tdSt     = { padding: '10px 10px', color: C.textMuted, verticalAlign: 'middle' }
const btnIconSt = { padding: '4px 6px', background: '#F5F5F5', border: `1px solid ${C.border}`, borderRadius: 6, color: C.textMuted, cursor: 'pointer', fontSize: 11, lineHeight: 1 }
