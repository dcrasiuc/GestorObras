import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'

const CONCEPTOS = ['materiales', 'mano-obra', 'equipos', 'subcontratos', 'varios']
const CONCEPTO_LABELS = { materiales: 'Materiales', 'mano-obra': 'Mano de obra', equipos: 'Equipos', subcontratos: 'Subcontratos', varios: 'Varios' }
const CONCEPTO_COLORS = { materiales: ['#EDE8F7','#6B3FA0'], 'mano-obra': ['#E8F5EE','#1F7A48'], equipos: ['#FEF3E2','#A05F1A'], subcontratos: ['#E8F0FD','#1D4FBB'], varios: ['#F1EFE8','#5F5E5A'] }

const fmt = (n) => new Intl.NumberFormat('es-AR', { style: 'decimal', maximumFractionDigits: 0 }).format(n ?? 0)
const hoy = () => new Date().toISOString().slice(0, 10)

// Paleta SEATE claro
const C = {
  bg:          '#F5F4F9',
  surface:     '#FFFFFF',
  surfaceAlt:  '#F9F8FC',
  border:      '#E8E4F3',
  borderFaint: '#F0EDF8',
  purple:      '#7B4DB5',
  purpleLight: '#9B6DD5',
  purpleDim:   '#EDE8F7',
  text:        '#2D1B4E',
  textMuted:   '#7A6A96',
  textFaint:   '#B8ADCC',
  white:       '#FFFFFF',
}

function useListas() {
  const [clientes, setClientes] = useState([])
  const [proveedores, setProveedores] = useState([])
  const cargar = useCallback(async () => {
    const [resC, resP] = await Promise.all([
      supabase.from('clientes').select('*').order('nombre'),
      supabase.from('proveedores').select('*').order('nombre'),
    ])
    if (!resC.error) setClientes(resC.data)
    if (!resP.error) setProveedores(resP.data)
  }, [])
  useEffect(() => { cargar() }, [cargar])
  return { clientes, proveedores, recargarListas: cargar }
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
    let q = supabase.from('gastos').select('*, obras(nombre), proveedores(nombre)').order('fecha', { ascending: false })
    if (obraIdFiltro) q = q.eq('obra_id', obraIdFiltro)
    const { data, error } = await q
    if (!error) setGastos(data ?? [])
    setLoading(false)
  }, [obraIdFiltro])
  useEffect(() => { cargar() }, [cargar])
  return { gastos, loading, recargar: cargar }
}

export default function GestorObras() {
  const [panel, setPanel] = useState('obras')
  const [filtroObraId, setFiltroObraId] = useState('')
  const [modal, setModal] = useState(null)
  const [itemEditando, setItemEditando] = useState(null)

  const { clientes, proveedores, recargarListas } = useListas()
  const { obras, loading: loadingObras, recargar: recargarObras } = useObras()
  const { gastos, loading: loadingGastos, recargar: recargarGastos } = useGastos(
    panel === 'gastos' ? filtroObraId : ''
  )
  const recargarTodo = () => { recargarObras(); recargarGastos() }
  const abrirModal = (tipo, item = null) => { setItemEditando(item); setModal(tipo) }
  const cerrarModal = () => { setModal(null); setItemEditando(null) }

  useEffect(() => {
    document.body.style.margin = '0'
    document.body.style.padding = '0'
    document.body.style.overflowX = 'hidden'
    document.body.style.background = C.bg
  }, [])

  const TABS = [
    { id: 'obras',     label: 'Obras',     icon: '⬡' },
    { id: 'gastos',    label: 'Gastos',    icon: '🧾' },
    { id: 'informe',   label: 'Informe',   icon: '📊' },
    { id: 'contactos', label: 'Contactos', icon: '👥' },
  ]

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body { font-family: 'Outfit', sans-serif !important; background: ${C.bg}; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #C4B8E0; border-radius: 99px; }
        input, select, textarea { font-family: 'Outfit', sans-serif; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .card-hover { transition: transform 0.18s, box-shadow 0.18s, border-color 0.18s; }
        .card-hover:hover { transform: translateY(-3px); border-color: #C4B8E0 !important; box-shadow: 0 10px 32px rgba(123,77,181,0.12) !important; }
        .fade-up { animation: fadeUp 0.25s ease forwards; }
        .tab-btn:hover { color: ${C.purple} !important; background: ${C.purpleDim} !important; }
        @media (max-width: 639px) {
          .desktop-only { display: none !important; }
          .mobile-tabs  { display: flex !important; }
          .main-content { padding-bottom: 76px !important; }
          .topbar-nav   { display: none !important; }
        }
        @media (min-width: 640px) {
          .mobile-only { display: none !important; }
          .mobile-tabs { display: none !important; }
        }
      `}</style>

      <div style={{ minHeight: '100vh', background: C.bg, fontFamily: "'Outfit', sans-serif", width: '100%', overflowX: 'hidden' }}>

        {/* TOPBAR */}
        <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0, zIndex: 50, width: '100%', boxShadow: '0 1px 6px rgba(123,77,181,0.07)' }}>
          <div style={{ maxWidth: 1060, margin: '0 auto', padding: '0 20px', display: 'flex', alignItems: 'center', height: 58, gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <div style={{ width: 32, height: 32, background: C.purple, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <SeateIcon size={20} color="#fff" />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, letterSpacing: '0.06em', lineHeight: 1 }}>SEATE</div>
                <div style={{ fontSize: 9, color: C.textFaint, letterSpacing: '0.1em', fontWeight: 500, marginTop: 1 }}>CONSTRUCCIONES · OBRAS</div>
              </div>
            </div>

            <nav className="topbar-nav" style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
              {TABS.map(t => (
                <button key={t.id} className="tab-btn" onClick={() => setPanel(t.id)} style={{
                  padding: '7px 16px', borderRadius: 8, fontSize: 13, cursor: 'pointer', border: 'none',
                  fontFamily: "'Outfit', sans-serif", fontWeight: 500,
                  background: panel === t.id ? C.purpleDim : 'transparent',
                  color: panel === t.id ? C.purple : C.textMuted,
                  borderBottom: panel === t.id ? `2px solid ${C.purple}` : '2px solid transparent',
                  transition: 'all 0.15s',
                }}>
                  <span style={{ marginRight: 5 }}>{t.icon}</span>{t.label}
                </button>
              ))}
            </nav>
          </div>
        </div>

        {/* CONTENIDO */}
        <div className="main-content" style={{ maxWidth: 1060, margin: '0 auto', padding: '24px 20px', width: '100%' }}>
          <div className="fade-up" key={panel}>
            {panel === 'obras'     && <PanelObras obras={obras} loading={loadingObras} onNueva={() => abrirModal('obra')} onEditar={o => abrirModal('obra', o)} onVerGastos={id => { setFiltroObraId(id); setPanel('gastos') }} />}
            {panel === 'gastos'    && <PanelGastos obras={obras} gastos={gastos} loading={loadingGastos} filtroObraId={filtroObraId} setFiltroObraId={setFiltroObraId} onNuevoManual={() => abrirModal('gasto')} onNuevoFoto={() => abrirModal('foto')} onEditar={g => abrirModal('gasto', g)} onEliminar={async id => { if (window.confirm('¿Eliminar este gasto?')) { await supabase.from('gastos').delete().eq('id', id); recargarTodo() } }} />}
            {panel === 'informe'   && <PanelInforme obras={obras} />}
            {panel === 'contactos' && <PanelContactos clientes={clientes} proveedores={proveedores} onNuevoCliente={() => abrirModal('cliente')} onNuevoProveedor={() => abrirModal('proveedor')} onEditarCliente={c => abrirModal('cliente', c)} onEditarProveedor={p => abrirModal('proveedor', p)} />}
          </div>
        </div>

        {/* BOTTOM NAV MOBILE */}
        <div className="mobile-tabs" style={{ display: 'none', position: 'fixed', bottom: 0, left: 0, right: 0, background: C.white, borderTop: `1px solid ${C.border}`, zIndex: 50, paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}>
          <div style={{ display: 'flex' }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setPanel(t.id)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '8px 0', border: 'none', background: 'transparent', cursor: 'pointer', color: panel === t.id ? C.purple : C.textFaint, transition: 'color 0.15s' }}>
                <span style={{ fontSize: 18 }}>{t.icon}</span>
                <span style={{ fontSize: 10, fontWeight: 600, fontFamily: "'Outfit', sans-serif", letterSpacing: '0.04em' }}>{t.label}</span>
                {panel === t.id && <div style={{ width: 20, height: 2, borderRadius: 99, background: C.purple }} />}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* MODALES */}
      {modal === 'obra'      && <ModalObra      itemEdit={itemEditando} clientes={clientes} onClose={cerrarModal} onGuardar={async d => { if (!d.nombre) return alert('El nombre es obligatorio'); const res = d.id ? await supabase.from('obras').update(d).eq('id', d.id) : await supabase.from('obras').insert([d]); if (res.error) alert('Error: ' + res.error.message); else { cerrarModal(); recargarObras() } }} />}
      {modal === 'gasto'     && <ModalGasto     itemEdit={itemEditando} obras={obras} proveedores={proveedores} obraIdDefecto={filtroObraId} onClose={cerrarModal} onGuardar={async d => { if (!d.monto || d.monto <= 0) return alert('Ingresá un monto válido'); const res = d.id ? await supabase.from('gastos').update(d).eq('id', d.id) : await supabase.from('gastos').insert([d]); if (res.error) alert('Error: ' + res.error.message); else { cerrarModal(); recargarTodo() } }} />}
      {modal === 'foto'      && <ModalFoto      obras={obras} proveedores={proveedores} obraIdDefecto={filtroObraId} onClose={cerrarModal} onGuardar={async d => { const { error } = await supabase.from('gastos').insert([d]); if (error) alert('Error: ' + error.message); else { cerrarModal(); recargarTodo() } }} />}
      {modal === 'cliente'   && <ModalCliente   itemEdit={itemEditando} onClose={cerrarModal} onGuardar={async d => { if (!d.nombre) return alert('El nombre es obligatorio'); const res = d.id ? await supabase.from('clientes').update(d).eq('id', d.id) : await supabase.from('clientes').insert([d]); if (res.error) alert('Error: ' + res.error.message); else { cerrarModal(); recargarListas() } }} />}
      {modal === 'proveedor' && <ModalProveedor itemEdit={itemEditando} onClose={cerrarModal} onGuardar={async d => { if (!d.nombre) return alert('El nombre es obligatorio'); const res = d.id ? await supabase.from('proveedores').update(d).eq('id', d.id) : await supabase.from('proveedores').insert([d]); if (res.error) alert('Error: ' + res.error.message); else { cerrarModal(); recargarListas() } }} />}
    </>
  )
}

function SeateIcon({ size = 24, color = C.purple }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <polygon points="50,4 93,27.5 93,72.5 50,96 7,72.5 7,27.5" fill="none" stroke={color} strokeWidth="10"/>
      <polygon points="50,22 76,37 76,63 50,78 24,63 24,37" fill="none" stroke={color} strokeWidth="7"/>
      <line x1="50" y1="22" x2="50" y2="78" stroke={color} strokeWidth="5" opacity=".5"/>
      <line x1="24" y1="37" x2="76" y2="37" stroke={color} strokeWidth="5" opacity=".5"/>
    </svg>
  )
}

// ── Panel Obras ───────────────────────────────────────────────
function PanelObras({ obras, loading, onNueva, onVerGastos, onEditar }) {
  return (
    <div>
      <PageHeader titulo="Obras" sub={`${obras.length} proyectos registrados`}>
        <BtnPrimary onClick={onNueva}>+ Nueva obra</BtnPrimary>
      </PageHeader>
      {loading ? <Spinner /> : obras.length === 0 ? <EmptyState icon="⬡" texto="No hay obras registradas" /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: 14 }}>
          {obras.map(o => {
            const pct = o.presupuesto > 0 ? Math.min(100, Math.round((o.total_gastado / o.presupuesto) * 100)) : 0
            const sobrep = o.presupuesto > 0 && o.total_gastado > o.presupuesto
            return (
              <div key={o.id} className="card-hover" style={cardStyle} onClick={() => onVerGastos(o.id)}>
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg,${C.purple},${C.purpleLight})`, borderRadius: '12px 12px 0 0' }} />
                <button style={{ position: 'absolute', top: 14, right: 14, ...btnIconSt }} onClick={e => { e.stopPropagation(); onEditar(o) }}>✏️</button>
                <div style={{ paddingTop: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2, paddingRight: 36 }}>{o.nombre}</div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>{o.cliente || 'Sin cliente asignado'}</div>
                  <div style={{ fontSize: 26, fontWeight: 700, color: C.text, letterSpacing: '-0.02em', fontFamily: "'DM Mono', monospace" }}>$ {fmt(o.total_gastado)}</div>
                  <div style={{ fontSize: 11, color: C.textFaint, marginTop: 3, marginBottom: 12 }}>{o.cant_gastos} gasto{o.cant_gastos !== 1 ? 's' : ''} registrado{o.cant_gastos !== 1 ? 's' : ''}</div>
                  {o.presupuesto > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                        <span style={{ fontSize: 10, color: C.textFaint, fontWeight: 600, letterSpacing: '0.06em' }}>PRESUPUESTO</span>
                        <span style={{ fontSize: 10, color: sobrep ? '#C0392B' : C.textMuted, fontWeight: 700 }}>{pct}%</span>
                      </div>
                      <div style={{ height: 5, background: C.borderFaint, borderRadius: 99, overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 99, width: `${pct}%`, background: sobrep ? '#E74C3C' : `linear-gradient(90deg,${C.purple},${C.purpleLight})`, transition: 'width 0.6s' }} />
                      </div>
                      <div style={{ fontSize: 10, color: C.textFaint, marginTop: 4 }}>$ {fmt(o.presupuesto)} presupuestado</div>
                    </div>
                  )}
                  <EstadoBadge estado={o.estado} />
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
function PanelGastos({ obras, gastos, loading, filtroObraId, setFiltroObraId, onNuevoManual, onNuevoFoto, onEditar, onEliminar }) {
  const total = gastos.reduce((s, g) => s + (g.monto ?? 0), 0)
  return (
    <div>
      <PageHeader titulo="Gastos" sub={gastos.length > 0 ? `Total: $ ${fmt(total)}` : 'Sin gastos aún'}>
        <div style={{ display: 'flex', gap: 8 }}>
          <BtnOutline onClick={onNuevoFoto}>📷 Foto</BtnOutline>
          <BtnPrimary onClick={onNuevoManual}>+ Gasto</BtnPrimary>
        </div>
      </PageHeader>

      <select value={filtroObraId} onChange={e => setFiltroObraId(e.target.value)} style={{ ...inputSt, marginBottom: 18, maxWidth: 340 }}>
        <option value="">Todas las obras</option>
        {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
      </select>

      {loading ? <Spinner /> : gastos.length === 0 ? <EmptyState icon="🧾" texto="No hay gastos registrados" /> : (
        <>
          {/* MOBILE: tarjetas */}
          <div className="mobile-only" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {gastos.map(g => (
              <div key={g.id} style={{ ...cardStyle, padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{g.proveedores?.nombre ?? 'Sin proveedor'}</div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{g.obras?.nombre ?? '—'} · {g.fecha}</div>
                  </div>
                  {/* FIX: monto en una sola línea con nowrap */}
                  <div style={{ fontSize: 16, fontWeight: 700, color: C.text, fontFamily: "'DM Mono', monospace", marginLeft: 12, whiteSpace: 'nowrap' }}>$ {fmt(g.monto)}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                    <ConceptoBadge concepto={g.concepto} />
                    {g.descripcion && <span style={{ fontSize: 11, color: C.textFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{g.descripcion}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 8 }}>
                    <button style={btnIconSt} onClick={() => onEditar(g)}>✏️</button>
                    <button style={{ ...btnIconSt, color: '#C0392B', background: '#FDECEA' }} onClick={() => onEliminar(g.id)}>✕</button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* DESKTOP: tabla — FIX overflow y celdas partidas */}
          <div className="desktop-only" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 96 }} />   {/* Fecha */}
                <col style={{ width: 130 }} />  {/* Obra */}
                <col style={{ width: 140 }} />  {/* Proveedor */}
                <col style={{ width: 110 }} />  {/* Concepto */}
                <col />                          {/* Descripción — flexible */}
                <col style={{ width: 110 }} />  {/* Monto */}
                <col style={{ width: 72 }} />   {/* Acciones */}
              </colgroup>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}`, background: C.surfaceAlt }}>
                  {['Fecha', 'Obra', 'Proveedor', 'Concepto', 'Descripción', 'Monto', ''].map(h => (
                    <th key={h} style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textAlign: h === 'Monto' ? 'right' : 'left', padding: '11px 14px', textTransform: 'uppercase', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gastos.map((g, i) => (
                  <tr key={g.id} style={{ borderBottom: i < gastos.length - 1 ? `1px solid ${C.borderFaint}` : 'none' }}>
                    {/* FIX fecha: nowrap */}
                    <td style={{ ...tdSt, whiteSpace: 'nowrap' }}>
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: C.textMuted }}>{g.fecha}</span>
                    </td>
                    {/* FIX chip obra: nowrap + overflow ellipsis */}
                    <td style={tdSt}>
                      <span style={{ fontSize: 11, padding: '3px 8px', background: C.purpleDim, color: C.purple, borderRadius: 99, fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {g.obras?.nombre ?? '—'}
                      </span>
                    </td>
                    <td style={{ ...tdSt, fontWeight: 500, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.proveedores?.nombre ?? '—'}</td>
                    <td style={tdSt}><ConceptoBadge concepto={g.concepto} /></td>
                    <td style={{ ...tdSt, color: C.textMuted, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.descripcion}</td>
                    {/* FIX monto: nowrap, alineado derecha, siempre en una línea */}
                    <td style={{ ...tdSt, textAlign: 'right', fontWeight: 700, color: C.text, fontFamily: "'DM Mono', monospace", whiteSpace: 'nowrap' }}>
                      $ {fmt(g.monto)}
                    </td>
                    <td style={tdSt}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button style={btnIconSt} onClick={() => onEditar(g)}>✏️</button>
                        <button style={{ ...btnIconSt, color: '#C0392B', background: '#FDECEA' }} onClick={() => onEliminar(g.id)}>✕</button>
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
  const porConcepto = {}
  CONCEPTOS.forEach(c => { porConcepto[c] = gastos.filter(g => g.concepto === c).reduce((s, g) => s + (g.monto ?? 0), 0) })
  const maxVal = Math.max(...Object.values(porConcepto), 1)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 22, flexWrap: 'wrap', gap: 10 }}>
        <PageTitle titulo="Informe" sub="Resumen financiero de obras" />
        <select value={obraId} onChange={e => setObraId(e.target.value)} style={{ ...inputSt, width: 'auto', minWidth: 220 }}>
          <option value="">Todas las obras</option>
          {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
        </select>
      </div>

      {loading ? <Spinner /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
            {[
              { label: 'Total gastos',  value: `$ ${fmt(total)}`,                              sub: `${gastos.length} comprobantes`,  color: C.purple },
              { label: 'Materiales',    value: `$ ${fmt(porConcepto.materiales)}`,              sub: `${total > 0 ? Math.round(porConcepto.materiales/total*100) : 0}%`,  color: '#6B3FA0' },
              { label: 'Mano de obra',  value: `$ ${fmt(porConcepto['mano-obra'])}`,            sub: `${total > 0 ? Math.round(porConcepto['mano-obra']/total*100) : 0}%`, color: '#1F7A48' },
              { label: 'Obras activas', value: obras.filter(o => o.estado === 'activa').length, sub: `de ${obras.length} total`,        color: '#1D4FBB' },
            ].map(s => (
              <div key={s.label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{s.label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: s.color, fontFamily: "'DM Mono', monospace", letterSpacing: '-0.02em' }}>{s.value}</div>
                <div style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}>{s.sub}</div>
              </div>
            ))}
          </div>

          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: '20px 22px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 18 }}>Desglose por rubro</div>
            {CONCEPTOS.map(c => {
              const [bg, color] = CONCEPTO_COLORS[c]
              return (
                <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                  <div style={{ width: 108, fontSize: 12, color: C.textMuted, fontWeight: 500, flexShrink: 0 }}>{CONCEPTO_LABELS[c]}</div>
                  <div style={{ flex: 1, height: 7, background: C.borderFaint, borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 99, width: `${Math.round(porConcepto[c] / maxVal * 100)}%`, background: color, transition: 'width 0.6s' }} />
                  </div>
                  <div style={{ width: 100, fontSize: 12, fontWeight: 700, color: C.text, textAlign: 'right', fontFamily: "'DM Mono', monospace", flexShrink: 0, whiteSpace: 'nowrap' }}>$ {fmt(porConcepto[c])}</div>
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
function PanelContactos({ clientes, proveedores, onNuevoCliente, onNuevoProveedor, onEditarCliente, onEditarProveedor }) {
  return (
    <div>
      <PageTitle titulo="Contactos" sub="Clientes y proveedores" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, marginTop: 20 }}>
        <ContactoCol titulo="Clientes" items={clientes} onNuevo={onNuevoCliente} onEditar={onEditarCliente} btnLabel="+ Cliente" renderSub={c => [c.telefono, c.email].filter(Boolean).join(' · ')} />
        <ContactoCol titulo="Proveedores" items={proveedores} onNuevo={onNuevoProveedor} onEditar={onEditarProveedor} btnLabel="+ Proveedor" outline renderSub={p => [p.rubro, p.cuit && `CUIT: ${p.cuit}`].filter(Boolean).join(' · ')} />
      </div>
    </div>
  )
}

function ContactoCol({ titulo, items, onNuevo, onEditar, btnLabel, outline, renderSub }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 11, fontWeight: 700, color: C.textFaint, margin: 0, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{titulo} ({items.length})</h2>
        {outline ? <BtnOutline onClick={onNuevo}>{btnLabel}</BtnOutline> : <BtnPrimary onClick={onNuevo}>{btnLabel}</BtnPrimary>}
      </div>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
        {items.length === 0 ? (
          <div style={{ padding: '22px 16px', color: C.textFaint, fontSize: 13, textAlign: 'center' }}>Sin registros</div>
        ) : items.map((item, i) => (
          <div key={item.id} style={{ padding: '13px 16px', borderBottom: i < items.length - 1 ? `1px solid ${C.borderFaint}` : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{item.nombre}</div>
              {renderSub(item) && <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{renderSub(item)}</div>}
            </div>
            <button style={btnIconSt} onClick={() => onEditar(item)}>✏️</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Modales ───────────────────────────────────────────────────
function ModalObra({ itemEdit, clientes, onClose, onGuardar }) {
  const [form, setForm] = useState(itemEdit || { nombre: '', cliente_id: '', estado: 'activa', presupuesto: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <Modal title={itemEdit ? 'Editar Obra' : 'Nueva Obra'} onClose={onClose} onGuardar={() => onGuardar({ ...form, cliente_id: form.cliente_id || null, presupuesto: parseFloat(form.presupuesto) || 0 })}>
      <Campo label="Nombre de la obra"><input style={inputSt} value={form.nombre} onChange={e => set('nombre', e.target.value)} placeholder="Ej: Edificio Tucumán 1420" /></Campo>
      <div style={{ marginTop: 10 }}><Campo label="Cliente"><select style={inputSt} value={form.cliente_id || ''} onChange={e => set('cliente_id', e.target.value)}><option value="">Sin cliente</option>{clientes?.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></Campo></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
        <Campo label="Presupuesto"><input style={inputSt} type="number" value={form.presupuesto} onChange={e => set('presupuesto', e.target.value)} placeholder="0" /></Campo>
        <Campo label="Estado"><select style={inputSt} value={form.estado} onChange={e => set('estado', e.target.value)}>{['activa','pausada','finalizada'].map(v => <option key={v} value={v}>{v.charAt(0).toUpperCase()+v.slice(1)}</option>)}</select></Campo>
      </div>
    </Modal>
  )
}

function ModalGasto({ itemEdit, obras, proveedores, obraIdDefecto, onClose, onGuardar }) {
  const [form, setForm] = useState(itemEdit || { obra_id: obraIdDefecto || obras[0]?.id || '', fecha: hoy(), proveedor_id: '', concepto: 'materiales', monto: '', descripcion: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <Modal title={itemEdit ? 'Editar Gasto' : 'Registrar Gasto'} onClose={onClose} onGuardar={() => onGuardar({ ...form, proveedor_id: form.proveedor_id || null, monto: parseFloat(form.monto) || 0 })}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Campo label="Fecha"><input style={inputSt} type="date" value={form.fecha} onChange={e => set('fecha', e.target.value)} /></Campo>
        <Campo label="Obra"><select style={inputSt} value={form.obra_id || ''} onChange={e => set('obra_id', e.target.value)}>{obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}</select></Campo>
        <Campo label="Proveedor" style={{ gridColumn: '1/-1' }}><select style={inputSt} value={form.proveedor_id || ''} onChange={e => set('proveedor_id', e.target.value)}><option value="">Sin proveedor</option>{proveedores?.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></Campo>
        <Campo label="Concepto"><select style={inputSt} value={form.concepto} onChange={e => set('concepto', e.target.value)}>{CONCEPTOS.map(c => <option key={c} value={c}>{CONCEPTO_LABELS[c]}</option>)}</select></Campo>
        <Campo label="Monto"><input style={inputSt} type="number" value={form.monto} onChange={e => set('monto', e.target.value)} placeholder="0" /></Campo>
        <Campo label="Descripción" style={{ gridColumn: '1/-1' }}><textarea style={{ ...inputSt, minHeight: 72, resize: 'vertical' }} value={form.descripcion} onChange={e => set('descripcion', e.target.value)} /></Campo>
      </div>
    </Modal>
  )
}

function ModalFoto({ obras, proveedores, obraIdDefecto, onClose, onGuardar }) {
  const [step, setStep] = useState('upload')
  const [form, setForm] = useState({ obra_id: obraIdDefecto || obras[0]?.id || '', fecha: hoy(), proveedor_id: '', concepto: 'materiales', monto: '', descripcion: '', imagen_url: '' })
  const [preview, setPreview] = useState(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const procesarFoto = async (file) => {
    setPreview(URL.createObjectURL(file))
    setStep('loading')
    const ext = file.name.split('.').pop()
    const path = `comprobantes/${Date.now()}.${ext}`
    const { data: uploadData, error: uploadError } = await supabase.storage.from('comprobantes').upload(path, file)
    if (uploadError) console.error('Error subir foto:', uploadError)
    const imageUrl = uploadData ? supabase.storage.from('comprobantes').getPublicUrl(path).data.publicUrl : ''
    const base64 = await new Promise(res => { const r = new FileReader(); r.onload = e => res(e.target.result.split(',')[1]); r.readAsDataURL(file) })
    try {
      const { data, error } = await supabase.functions.invoke('analizar-comprobante', { body: { base64, mimeType: file.type, hoy: hoy() } })
      if (error) throw new Error('Error al conectar con la función')
      if (data?.error) { alert(`Error IA: ${data.error.message}`); setForm(f => ({ ...f, imagen_url: imageUrl })); setStep('review'); return }
      const text = data.content.map(i => i.text || '').join('')
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
      const matchProv = proveedores.find(p => p.nombre.toLowerCase().includes((parsed.proveedor || '').toLowerCase()))
      setForm(f => ({ ...f, fecha: parsed.fecha || hoy(), proveedor_id: matchProv ? matchProv.id : '', concepto: parsed.concepto || 'varios', monto: parsed.monto || '', descripcion: (parsed.descripcion || '') + (parsed.proveedor && !matchProv ? ` (prov: ${parsed.proveedor})` : ''), imagen_url: imageUrl }))
    } catch (err) { console.error(err); setForm(f => ({ ...f, imagen_url: imageUrl })) }
    setStep('review')
  }

  return (
    <Modal title="Cargar comprobante" onClose={onClose} onGuardar={step === 'review' ? () => onGuardar({ ...form, proveedor_id: form.proveedor_id || null, monto: parseFloat(form.monto) || 0 }) : null} guardarLabel="Guardar gasto">
      {step === 'upload' && (
        <label style={{ display: 'block', border: `1.5px dashed ${C.border}`, borderRadius: 14, padding: '36px 24px', textAlign: 'center', cursor: 'pointer', background: C.purpleDim, marginBottom: 8 }}>
          <div style={{ fontSize: 38, marginBottom: 10 }}>📷</div>
          <div style={{ fontSize: 14, color: C.textMuted, fontWeight: 500 }}>Tocá para subir foto del comprobante</div>
          <div style={{ fontSize: 11, color: C.textFaint, marginTop: 6 }}>JPG, PNG, WEBP — ticket, factura, remito</div>
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => e.target.files[0] && procesarFoto(e.target.files[0])} />
        </label>
      )}
      {step === 'loading' && (
        <div style={{ textAlign: 'center', padding: '36px 0' }}>
          {preview && <img src={preview} alt="" style={{ maxHeight: 130, borderRadius: 10, marginBottom: 18, opacity: 0.7 }} />}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <div style={{ width: 18, height: 18, border: `2px solid ${C.purple}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <span style={{ fontSize: 13, color: C.textMuted }}>Analizando comprobante con IA...</span>
          </div>
        </div>
      )}
      {step === 'review' && (
        <div>
          {preview && <img src={preview} alt="" style={{ maxHeight: 90, borderRadius: 8, marginBottom: 14, display: 'block' }} />}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', background: C.purpleDim, color: C.purple, fontSize: 11, borderRadius: 99, marginBottom: 16, fontWeight: 600, border: `1px solid ${C.border}` }}>✨ Datos extraídos — revisá antes de guardar</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Campo label="Fecha"><input style={inputSt} type="date" value={form.fecha} onChange={e => set('fecha', e.target.value)} /></Campo>
            <Campo label="Obra"><select style={inputSt} value={form.obra_id || ''} onChange={e => set('obra_id', e.target.value)}>{obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}</select></Campo>
            <Campo label="Proveedor" style={{ gridColumn: '1/-1' }}><select style={inputSt} value={form.proveedor_id || ''} onChange={e => set('proveedor_id', e.target.value)}><option value="">Sin proveedor</option>{proveedores?.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></Campo>
            <Campo label="Concepto"><select style={inputSt} value={form.concepto} onChange={e => set('concepto', e.target.value)}>{CONCEPTOS.map(c => <option key={c} value={c}>{CONCEPTO_LABELS[c]}</option>)}</select></Campo>
            <Campo label="Monto"><input style={inputSt} type="number" value={form.monto} onChange={e => set('monto', e.target.value)} /></Campo>
            <Campo label="Descripción" style={{ gridColumn: '1/-1' }}><textarea style={{ ...inputSt, minHeight: 60, resize: 'vertical' }} value={form.descripcion} onChange={e => set('descripcion', e.target.value)} /></Campo>
          </div>
        </div>
      )}
    </Modal>
  )
}

function ModalCliente({ itemEdit, onClose, onGuardar }) {
  const [form, setForm] = useState(itemEdit || { nombre: '', telefono: '', email: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <Modal title={itemEdit ? 'Editar Cliente' : 'Nuevo Cliente'} onClose={onClose} onGuardar={() => onGuardar(form)} guardarLabel={itemEdit ? 'Actualizar' : 'Guardar'}>
      <Campo label="Nombre / Razón Social"><input style={inputSt} value={form.nombre} onChange={e => set('nombre', e.target.value)} placeholder="Nombre del cliente" /></Campo>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
        <Campo label="Teléfono"><input style={inputSt} value={form.telefono || ''} onChange={e => set('telefono', e.target.value)} placeholder="+54..." /></Campo>
        <Campo label="Email"><input style={inputSt} type="email" value={form.email || ''} onChange={e => set('email', e.target.value)} placeholder="correo@..." /></Campo>
      </div>
    </Modal>
  )
}

function ModalProveedor({ itemEdit, onClose, onGuardar }) {
  const [form, setForm] = useState(itemEdit || { nombre: '', cuit: '', rubro: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <Modal title={itemEdit ? 'Editar Proveedor' : 'Nuevo Proveedor'} onClose={onClose} onGuardar={() => onGuardar(form)} guardarLabel={itemEdit ? 'Actualizar' : 'Guardar'}>
      <Campo label="Nombre / Razón Social"><input style={inputSt} value={form.nombre} onChange={e => set('nombre', e.target.value)} placeholder="Ferretería, Empresa..." /></Campo>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
        <Campo label="CUIT / RUT"><input style={inputSt} value={form.cuit || ''} onChange={e => set('cuit', e.target.value)} placeholder="Sin guiones" /></Campo>
        <Campo label="Rubro"><input style={inputSt} value={form.rubro || ''} onChange={e => set('rubro', e.target.value)} placeholder="Materiales, Pintura..." /></Campo>
      </div>
    </Modal>
  )
}

// ── Componentes genéricos ─────────────────────────────────────
function Modal({ title, children, onClose, onGuardar, guardarLabel = 'Guardar' }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(45,27,78,0.25)', backdropFilter: 'blur(4px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 18, padding: 22, width: '100%', maxWidth: 460, maxHeight: '88vh', overflowY: 'auto', boxSizing: 'border-box', boxShadow: '0 20px 60px rgba(123,77,181,0.18)' }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 18, letterSpacing: '-0.01em' }}>{title}</h3>
        {children}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button style={{ padding: '8px 18px', background: 'transparent', color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 9, fontSize: 13, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }} onClick={onClose}>Cancelar</button>
          {onGuardar && <button style={{ padding: '8px 20px', background: C.purple, color: '#fff', border: 'none', borderRadius: 9, fontSize: 13, cursor: 'pointer', fontWeight: 700, fontFamily: "'Outfit', sans-serif", boxShadow: '0 4px 14px rgba(123,77,181,0.35)' }} onClick={onGuardar}>{guardarLabel}</button>}
        </div>
      </div>
    </div>
  )
}

function Campo({ label, children, style }) {
  return (
    <div style={{ ...style }}>
      <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</label>
      {children}
    </div>
  )
}

function PageHeader({ titulo, sub, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 22, flexWrap: 'wrap', gap: 10 }}>
      <PageTitle titulo={titulo} sub={sub} />
      {children}
    </div>
  )
}

function PageTitle({ titulo, sub }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-0.02em' }}>{titulo}</h1>
      {sub && <p style={{ fontSize: 12, color: C.textMuted, margin: '3px 0 0' }}>{sub}</p>}
    </div>
  )
}

function ConceptoBadge({ concepto }) {
  const [bg, color] = CONCEPTO_COLORS[concepto] ?? CONCEPTO_COLORS.varios
  return <span style={{ background: bg, color, padding: '3px 9px', borderRadius: 99, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{CONCEPTO_LABELS[concepto]}</span>
}

function EstadoBadge({ estado }) {
  const m = { activa: ['#EDE8F7','#7B4DB5'], pausada: ['#FEF3E2','#A05F1A'], finalizada: ['#F1EFE8','#5F5E5A'] }
  const [bg, color] = m[estado] ?? m.finalizada
  return <span style={{ background: bg, color, padding: '3px 11px', borderRadius: 99, fontSize: 11, fontWeight: 700 }}>{estado.charAt(0).toUpperCase()+estado.slice(1)}</span>
}

function BtnPrimary({ children, onClick }) {
  return <button onClick={onClick} style={{ padding: '8px 18px', background: C.purple, color: '#fff', border: 'none', borderRadius: 9, fontSize: 13, cursor: 'pointer', fontWeight: 700, fontFamily: "'Outfit', sans-serif", whiteSpace: 'nowrap', boxShadow: '0 3px 12px rgba(123,77,181,0.3)' }}>{children}</button>
}

function BtnOutline({ children, onClick }) {
  return <button onClick={onClick} style={{ padding: '8px 16px', background: C.purpleDim, color: C.purple, border: `1px solid ${C.border}`, borderRadius: 9, fontSize: 13, cursor: 'pointer', fontWeight: 600, fontFamily: "'Outfit', sans-serif", whiteSpace: 'nowrap' }}>{children}</button>
}

function Spinner() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '52px 0', gap: 14 }}>
      <div style={{ width: 28, height: 28, border: `2.5px solid ${C.border}`, borderTopColor: C.purple, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <span style={{ fontSize: 12, color: C.textFaint }}>Cargando...</span>
    </div>
  )
}

function EmptyState({ icon, texto }) {
  return (
    <div style={{ textAlign: 'center', padding: '56px 20px' }}>
      <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.3 }}>{icon}</div>
      <div style={{ fontSize: 14, color: C.textMuted, fontWeight: 500 }}>{texto}</div>
    </div>
  )
}

// ── Estilos base ──────────────────────────────────────────────
const inputSt = {
  width: '100%', padding: '9px 13px', fontSize: 13,
  fontFamily: "'Outfit', sans-serif",
  border: `1px solid ${C.border}`, borderRadius: 9,
  background: C.white, color: C.text,
  boxSizing: 'border-box', outline: 'none', colorScheme: 'light',
}
const cardStyle = {
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: 14, padding: '16px 18px',
  cursor: 'pointer', position: 'relative', overflow: 'hidden',
}
const tdSt = { padding: '11px 14px', color: C.textMuted, verticalAlign: 'middle' }
const btnIconSt = {
  padding: '5px 8px',
  background: C.surfaceAlt,
  border: `1px solid ${C.border}`,
  borderRadius: 7, color: C.textMuted,
  cursor: 'pointer', fontSize: 12,
}
