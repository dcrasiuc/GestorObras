// src/GestorObras.jsx
import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'

// ── Constantes ────────────────────────────────────────────────
const CONCEPTOS = ['materiales', 'mano-obra', 'equipos', 'subcontratos', 'varios']
const CONCEPTO_LABELS = {
  materiales: 'Materiales',
  'mano-obra': 'Mano de obra',
  equipos: 'Equipos',
  subcontratos: 'Subcontratos',
  varios: 'Varios',
}
const CONCEPTO_COLORS = {
  materiales: '#378ADD',
  'mano-obra': '#639922',
  equipos: '#BA7517',
  subcontratos: '#7F77DD',
  varios: '#888780',
}

const fmt = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'decimal', maximumFractionDigits: 0 }).format(n ?? 0)

const hoy = () => new Date().toISOString().slice(0, 10)

// ── Hooks de datos ────────────────────────────────────────────
function useListas() {
  const [clientes, setClientes] = useState([])
  const [proveedores, setProveedores] = useState([])

  const cargar = useCallback(async () => {
    const [resClientes, resProv] = await Promise.all([
      supabase.from('clientes').select('*').order('nombre'),
      supabase.from('proveedores').select('*').order('nombre')
    ])
    if (!resClientes.error) setClientes(resClientes.data)
    if (!resProv.error) setProveedores(resProv.data)
  }, [])

  useEffect(() => { cargar() }, [cargar])

  return { clientes, proveedores, recargarListas: cargar }
}

function useObras() {
  const [obras, setObras] = useState([])
  const [loading, setLoading] = useState(true)

  const cargar = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('obras_resumen')
      .select('*')
      .order('nombre')
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
    let q = supabase
      .from('gastos')
      .select('*, obras(nombre), proveedores(nombre)')
      .order('fecha', { ascending: false })
    if (obraIdFiltro) q = q.eq('obra_id', obraIdFiltro)
    const { data, error } = await q
    if (!error) setGastos(data ?? [])
    setLoading(false)
  }, [obraIdFiltro])

  useEffect(() => { cargar() }, [cargar])
  return { gastos, loading, recargar: cargar }
}

// ── Componente principal ──────────────────────────────────────
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

  const abrirModal = (tipo, item = null) => {
    setItemEditando(item)
    setModal(tipo)
  }
  const cerrarModal = () => {
    setModal(null)
    setItemEditando(null)
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f8f8f7', fontFamily: 'system-ui, sans-serif' }}>
      {/* Topbar */}
      <div style={s.topbar}>
        <span style={s.logo}>● GestorObras - TENAMIA SRL</span>
        <div style={s.navTabs}>
          {['obras', 'gastos', 'informe', 'contactos'].map((p) => (
            <button key={p} style={panel === p ? s.tabActive : s.tab} onClick={() => setPanel(p)}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 960, margin: '0 auto', padding: '20px 16px' }}>
        {panel === 'obras' && (
          <PanelObras
            obras={obras}
            loading={loadingObras}
            onNueva={() => abrirModal('obra')}
            onEditar={(o) => abrirModal('obra', o)}
            onVerGastos={(id) => { setFiltroObraId(id); setPanel('gastos') }}
          />
        )}
        {panel === 'gastos' && (
          <PanelGastos
            obras={obras}
            gastos={gastos}
            loading={loadingGastos}
            filtroObraId={filtroObraId}
            setFiltroObraId={setFiltroObraId}
            onNuevoManual={() => abrirModal('gasto')}
            onNuevoFoto={() => abrirModal('foto')}
            onEditar={(g) => abrirModal('gasto', g)}
            onEliminar={async (id) => {
              if (window.confirm('¿Seguro que querés eliminar este gasto?')) {
                await supabase.from('gastos').delete().eq('id', id)
                recargarTodo()
              }
            }}
          />
        )}
        {panel === 'informe' && (
          <PanelInforme obras={obras} />
        )}
        {panel === 'contactos' && (
          <PanelContactos 
            clientes={clientes} 
            proveedores={proveedores} 
            onNuevoCliente={() => abrirModal('cliente')}
            onNuevoProveedor={() => abrirModal('proveedor')}
            onEditarCliente={(c) => abrirModal('cliente', c)}
            onEditarProveedor={(p) => abrirModal('proveedor', p)}
          />
        )}
      </div>

      {/* Modales */}
      {modal === 'obra' && (
        <ModalObra
          itemEdit={itemEditando}
          clientes={clientes}
          onClose={cerrarModal}
          onGuardar={async (datos) => {
            if (!datos.nombre) return alert('⚠️ El nombre de la obra es obligatorio')
            let error;
            if (datos.id) {
              const res = await supabase.from('obras').update(datos).eq('id', datos.id)
              error = res.error
            } else {
              const res = await supabase.from('obras').insert([datos])
              error = res.error
            }
            if (error) alert('Error de Supabase: ' + error.message)
            else { cerrarModal(); recargarObras() }
          }}
        />
      )}
      {modal === 'gasto' && (
        <ModalGasto
          itemEdit={itemEditando}
          obras={obras}
          proveedores={proveedores}
          obraIdDefecto={filtroObraId}
          onClose={cerrarModal}
          onGuardar={async (datos) => {
            if (!datos.monto || datos.monto <= 0) return alert('⚠️ Ingresa un monto válido')
            let error;
            if (datos.id) {
              const res = await supabase.from('gastos').update(datos).eq('id', datos.id)
              error = res.error
            } else {
              const res = await supabase.from('gastos').insert([datos])
              error = res.error
            }
            if (error) alert('Error de Supabase: ' + error.message)
            else { cerrarModal(); recargarTodo() }
          }}
        />
      )}
      {modal === 'foto' && (
        <ModalFoto
          obras={obras}
          proveedores={proveedores}
          obraIdDefecto={filtroObraId}
          onClose={cerrarModal}
          onGuardar={async (datos) => {
            const { error } = await supabase.from('gastos').insert([datos])
            if (error) alert('Error de Supabase: ' + error.message)
            else { cerrarModal(); recargarTodo() }
          }}
        />
      )}
      {modal === 'cliente' && (
        <ModalCliente
          itemEdit={itemEditando}
          onClose={cerrarModal}
          onGuardar={async (datos) => {
            if (!datos.nombre) return alert('⚠️ El nombre del cliente es obligatorio')
            let error;
            if (datos.id) {
              const res = await supabase.from('clientes').update(datos).eq('id', datos.id)
              error = res.error
            } else {
              const res = await supabase.from('clientes').insert([datos])
              error = res.error
            }
            if (error) alert('Error de Supabase: ' + error.message)
            else { cerrarModal(); recargarListas() }
          }}
        />
      )}
      {modal === 'proveedor' && (
        <ModalProveedor
          itemEdit={itemEditando}
          onClose={cerrarModal}
          onGuardar={async (datos) => {
            if (!datos.nombre) return alert('⚠️ El nombre del proveedor es obligatorio')
            let error;
            if (datos.id) {
              const res = await supabase.from('proveedores').update(datos).eq('id', datos.id)
              error = res.error
            } else {
              const res = await supabase.from('proveedores').insert([datos])
              error = res.error
            }
            if (error) alert('Error de Supabase: ' + error.message)
            else { cerrarModal(); recargarListas() }
          }}
        />
      )}
    </div>
  )
}

// ── Panel Contactos ───────────────────────────────────
function PanelContactos({ clientes, proveedores, onNuevoCliente, onNuevoProveedor, onEditarCliente, onEditarProveedor }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
      {/* Columna Clientes */}
      <div>
        <div style={s.panelHeader}>
          <h2 style={s.panelTitle}>Clientes</h2>
          <button style={s.btnPrimary} onClick={onNuevoCliente}>+ Nuevo cliente</button>
        </div>
        <div style={{ background: '#fff', border: '0.5px solid #e5e5e3', borderRadius: 12, overflow: 'hidden' }}>
          {clientes.map(c => (
            <div key={c.id} style={{ padding: '12px 16px', borderBottom: '0.5px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{c.nombre}</div>
                {(c.telefono || c.email) && (
                  <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                    {c.telefono} {c.telefono && c.email && ' • '} {c.email}
                  </div>
                )}
              </div>
              <button style={s.btnAction} onClick={() => onEditarCliente(c)}>✏️</button>
            </div>
          ))}
          {clientes.length === 0 && <div style={{ padding: 16, color: '#aaa', fontSize: 13 }}>No hay clientes registrados.</div>}
        </div>
      </div>

      {/* Columna Proveedores */}
      <div>
        <div style={s.panelHeader}>
          <h2 style={s.panelTitle}>Proveedores</h2>
          <button style={s.btnOutline} onClick={onNuevoProveedor}>+ Nuevo proveedor</button>
        </div>
        <div style={{ background: '#fff', border: '0.5px solid #e5e5e3', borderRadius: 12, overflow: 'hidden' }}>
          {proveedores.map(p => (
            <div key={p.id} style={{ padding: '12px 16px', borderBottom: '0.5px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{p.nombre}</div>
                {(p.rubro || p.cuit) && (
                  <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                    {p.rubro || 'Sin rubro'} {p.cuit && ` • CUIT/RUT: ${p.cuit}`}
                  </div>
                )}
              </div>
              <button style={s.btnAction} onClick={() => onEditarProveedor(p)}>✏️</button>
            </div>
          ))}
          {proveedores.length === 0 && <div style={{ padding: 16, color: '#aaa', fontSize: 13 }}>No hay proveedores registrados.</div>}
        </div>
      </div>
    </div>
  )
}

// ── Panel Obras ───────────────────────────────────────────────
function PanelObras({ obras, loading, onNueva, onVerGastos, onEditar }) {
  return (
    <div>
      <div style={s.panelHeader}>
        <h2 style={s.panelTitle}>Obras</h2>
        <button style={s.btnPrimary} onClick={onNueva}>+ Nueva obra</button>
      </div>
      {loading ? <p style={s.muted}>Cargando...</p> : (
        <div style={s.obrasGrid}>
          {obras.length === 0 && <p style={s.muted}>No hay obras. Creá la primera.</p>}
          {obras.map((o) => (
            <div key={o.id} style={{...s.obraCard, position: 'relative'}} onClick={() => onVerGastos(o.id)}>
              <button 
                style={{position: 'absolute', top: 12, right: 12, ...s.btnAction}} 
                onClick={(e) => { e.stopPropagation(); onEditar(o); }}
              >✏️</button>
              
              <div style={s.obraNombre}>{o.nombre}</div>
              <div style={s.obraCliente}>{o.cliente || 'Sin cliente'}</div>
              <div style={s.obraTotal}>$ {fmt(o.total_gastado)}</div>
              <div style={s.obraSub}>{o.cant_gastos} gasto{o.cant_gastos !== 1 ? 's' : ''}</div>
              {o.presupuesto > 0 && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ ...s.barWrap }}>
                    <div style={{ ...s.bar, width: `${Math.min(100, (o.total_gastado / o.presupuesto) * 100)}%`, background: o.total_gastado > o.presupuesto ? '#E24B4A' : '#378ADD' }} />
                  </div>
                  <div style={s.obraSub}>{Math.round((o.total_gastado / o.presupuesto) * 100)}% del presupuesto</div>
                </div>
              )}
              <span style={{ ...s.statusBadge, ...estadoStyle(o.estado) }}>{o.estado}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Panel Gastos ──────────────────────────────────────────────
function PanelGastos({ obras, gastos, loading, filtroObraId, setFiltroObraId, onNuevoManual, onNuevoFoto, onEditar, onEliminar }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={s.select} value={filtroObraId} onChange={e => setFiltroObraId(e.target.value)}>
          <option value="">Todas las obras</option>
          {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
        </select>
        <button style={s.btnOutline} onClick={onNuevoFoto}>📷 Cargar por foto</button>
        <button style={s.btnPrimary} onClick={onNuevoManual}>+ Gasto manual</button>
      </div>

      {loading ? <p style={s.muted}>Cargando...</p> : gastos.length === 0 ? (
        <p style={s.muted}>No hay gastos registrados.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={s.tabla}>
            <thead>
              <tr>{['Fecha', 'Obra', 'Proveedor', 'Concepto', 'Descripción', 'Monto', 'Acciones'].map(h => (
                <th key={h} style={s.th}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {gastos.map(g => (
                <tr key={g.id}>
                  <td style={s.td}>{g.fecha}</td>
                  <td style={s.td}><span style={s.chipObra}>{g.obras?.nombre ?? '—'}</span></td>
                  <td style={s.td}>{g.proveedores?.nombre ?? '—'}</td>
                  <td style={s.td}><ConceptoBadge concepto={g.concepto} /></td>
                  <td style={{ ...s.td, color: '#888', fontSize: 12 }}>{g.descripcion}</td>
                  <td style={{ ...s.td, textAlign: 'right', fontWeight: 500 }}>$ {fmt(g.monto)}</td>
                  <td style={s.td}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button style={s.btnAction} onClick={() => onEditar(g)}>✏️</button>
                      <button style={s.btnDanger} onClick={() => onEliminar(g.id)}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Panel Informe ─────────────────────────────────────────────
function PanelInforme({ obras }) {
  const [obraId, setObraId] = useState('')
  const { gastos } = useGastos(obraId)

  const total = gastos.reduce((s, g) => s + (g.monto ?? 0), 0)
  const porConcepto = {}
  CONCEPTOS.forEach(c => {
    porConcepto[c] = gastos.filter(g => g.concepto === c).reduce((s, g) => s + (g.monto ?? 0), 0)
  })
  const maxVal = Math.max(...Object.values(porConcepto), 1)

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center' }}>
        <select style={s.select} value={obraId} onChange={e => setObraId(e.target.value)}>
          <option value="">Todas las obras</option>
          {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
        </select>
      </div>

      <div style={s.statsRow}>
        <StatCard label="Total gastos" value={`$ ${fmt(total)}`} sub={`${gastos.length} comprobantes`} />
        <StatCard label="Materiales" value={`$ ${fmt(porConcepto.materiales)}`} sub={`${total > 0 ? Math.round(porConcepto.materiales / total * 100) : 0}%`} />
        <StatCard label="Mano de obra" value={`$ ${fmt(porConcepto['mano-obra'])}`} sub={`${total > 0 ? Math.round(porConcepto['mano-obra'] / total * 100) : 0}%`} />
        <StatCard label="Obras activas" value={obras.filter(o => o.estado === 'activa').length} sub={`de ${obras.length}`} />
      </div>

      <div style={s.sectionTitle}>Gasto por concepto</div>
      {CONCEPTOS.map(c => (
        <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ width: 110, fontSize: 12, color: '#888' }}>{CONCEPTO_LABELS[c]}</div>
          <div style={s.barWrap}>
            <div style={{ ...s.bar, width: `${Math.round(porConcepto[c] / maxVal * 100)}%`, background: CONCEPTO_COLORS[c], transition: 'width 0.4s' }} />
          </div>
          <div style={{ width: 90, fontSize: 12, fontWeight: 500, textAlign: 'right' }}>$ {fmt(porConcepto[c])}</div>
        </div>
      ))}
    </div>
  )
}

// ── Modales ───────────────────────────────────────────────────
function ModalObra({ itemEdit, clientes, onClose, onGuardar }) {
  const [form, setForm] = useState(itemEdit || { nombre: '', cliente_id: '', estado: 'activa', presupuesto: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <Modal title={itemEdit ? "Editar Obra" : "Nueva Obra"} onClose={onClose} onGuardar={() => onGuardar({ ...form, cliente_id: form.cliente_id || null, presupuesto: parseFloat(form.presupuesto) || 0 })}>
      <Campo label="Nombre de la obra"><input style={s.input} value={form.nombre} onChange={e => set('nombre', e.target.value)} placeholder="Ej: Edificio Tucumán 1420" /></Campo>
      <Campo label="Cliente">
        <select style={s.input} value={form.cliente_id || ''} onChange={e => set('cliente_id', e.target.value)}>
          <option value="">Seleccionar cliente...</option>
          {clientes?.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
      </Campo>
      <Campo label="Presupuesto (opcional)"><input style={s.input} type="number" value={form.presupuesto} onChange={e => set('presupuesto', e.target.value)} placeholder="0" /></Campo>
      <Campo label="Estado">
        <select style={s.input} value={form.estado} onChange={e => set('estado', e.target.value)}>
          {['activa', 'pausada', 'finalizada'].map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </Campo>
    </Modal>
  )
}

function ModalGasto({ itemEdit, obras, proveedores, obraIdDefecto, onClose, onGuardar }) {
  const [form, setForm] = useState(itemEdit || { obra_id: obraIdDefecto || obras[0]?.id || '', fecha: hoy(), proveedor_id: '', concepto: 'materiales', monto: '', descripcion: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <Modal title={itemEdit ? "Editar Gasto" : "Registrar Gasto"} onClose={onClose} onGuardar={() => onGuardar({ ...form, proveedor_id: form.proveedor_id || null, monto: parseFloat(form.monto) || 0 })}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Campo label="Fecha"><input style={s.input} type="date" value={form.fecha} onChange={e => set('fecha', e.target.value)} /></Campo>
        <Campo label="Obra">
          <select style={s.input} value={form.obra_id || ''} onChange={e => set('obra_id', e.target.value)}>
            {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
          </select>
        </Campo>
        <Campo label="Proveedor" style={{ gridColumn: '1/-1' }}>
          <select style={s.input} value={form.proveedor_id || ''} onChange={e => set('proveedor_id', e.target.value)}>
            <option value="">Seleccionar proveedor...</option>
            {proveedores?.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </Campo>
        <Campo label="Concepto">
          <select style={s.input} value={form.concepto} onChange={e => set('concepto', e.target.value)}>
            {CONCEPTOS.map(c => <option key={c} value={c}>{CONCEPTO_LABELS[c]}</option>)}
          </select>
        </Campo>
        <Campo label="Monto"><input style={s.input} type="number" value={form.monto} onChange={e => set('monto', e.target.value)} placeholder="0" /></Campo>
        <Campo label="Descripción" style={{ gridColumn: '1/-1' }}><textarea style={{ ...s.input, minHeight: 64, resize: 'vertical' }} value={form.descripcion} onChange={e => set('descripcion', e.target.value)} /></Campo>
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

    // 1. Subir imagen a Supabase Storage
    const ext = file.name.split('.').pop()
    const path = `comprobantes/${Date.now()}.${ext}`
    
    const { data: uploadData, error: uploadError } = await supabase.storage.from('comprobantes').upload(path, file)
    if (uploadError) console.error("Error al subir foto:", uploadError)
    
    const imageUrl = uploadData ? supabase.storage.from('comprobantes').getPublicUrl(path).data.publicUrl : ''

    // 2. Convertir a base64
    const base64 = await new Promise(res => {
      const r = new FileReader()
      r.onload = e => res(e.target.result.split(',')[1])
      r.readAsDataURL(file)
    })

    try {
      // 3. Llamar a tu función SEGURA en Supabase (¡Adiós error de CORS!)
      const { data, error } = await supabase.functions.invoke('analizar-comprobante', {
        body: { base64, mimeType: file.type, hoy: hoy() }
      })

      if (error) throw new Error('Error al conectar con la función de Supabase')
      
      if (data?.error) {
        alert(`❌ Rechazo de la IA: ${data.error.message || 'Error desconocido'}\n\nRevisa tu saldo o clave en Supabase.`)
        setForm(f => ({ ...f, imagen_url: imageUrl }))
        setStep('review')
        return
      }

      const text = data.content.map(i => i.text || '').join('')
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
      
      const provNombre = parsed.proveedor || ''
      const matchProv = proveedores.find(p => p.nombre.toLowerCase().includes(provNombre.toLowerCase()))

      setForm(f => ({
        ...f,
        fecha: parsed.fecha || hoy(),
        proveedor_id: matchProv ? matchProv.id : '',
        concepto: parsed.concepto || 'varios',
        monto: parsed.monto || '',
        descripcion: (parsed.descripcion || '') + (provNombre && !matchProv ? ` (IA detectó prov: ${provNombre})` : ''),
        imagen_url: imageUrl,
      }))
    } catch (err) {
      alert('⚠️ Hubo un problema técnico analizando el comprobante. Revisa la consola.')
      console.error(err)
      setForm(f => ({ ...f, imagen_url: imageUrl }))
    }
    setStep('review')
  }

  return (
    <Modal
      title="Cargar por foto"
      onClose={onClose}
      onGuardar={step === 'review' ? () => onGuardar({ ...form, proveedor_id: form.proveedor_id || null, monto: parseFloat(form.monto) || 0 }) : null}
      guardarLabel="Guardar gasto"
    >
      {step === 'upload' && (
        <label style={s.uploadZone}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📷</div>
          <div style={{ fontSize: 13, color: '#888' }}>Tocá para subir foto del comprobante</div>
          <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>JPG, PNG, WEBP</div>
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => e.target.files[0] && procesarFoto(e.target.files[0])} />
        </label>
      )}
      {step === 'loading' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          {preview && <img src={preview} alt="comprobante" style={{ maxHeight: 120, borderRadius: 8, marginBottom: 12 }} />}
          <div style={s.aiBadge}>🧠 Analizando comprobante con IA...</div>
        </div>
      )}
      {step === 'review' && (
        <div>
          {preview && <img src={preview} alt="comprobante" style={{ maxHeight: 100, borderRadius: 8, marginBottom: 10 }} />}
          <div style={{ ...s.aiBadge, marginBottom: 12 }}>✨ Datos extraídos — revisá antes de guardar</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Campo label="Fecha"><input style={s.input} type="date" value={form.fecha} onChange={e => set('fecha', e.target.value)} /></Campo>
            <Campo label="Obra">
              <select style={s.input} value={form.obra_id || ''} onChange={e => set('obra_id', e.target.value)}>
                {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
              </select>
            </Campo>
            <Campo label="Proveedor" style={{ gridColumn: '1/-1' }}>
              <select style={s.input} value={form.proveedor_id || ''} onChange={e => set('proveedor_id', e.target.value)}>
                <option value="">Seleccionar proveedor...</option>
                {proveedores?.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
            </Campo>
            <Campo label="Concepto">
              <select style={s.input} value={form.concepto} onChange={e => set('concepto', e.target.value)}>
                {CONCEPTOS.map(c => <option key={c} value={c}>{CONCEPTO_LABELS[c]}</option>)}
              </select>
            </Campo>
            <Campo label="Monto"><input style={s.input} type="number" value={form.monto} onChange={e => set('monto', e.target.value)} /></Campo>
            <Campo label="Descripción" style={{ gridColumn: '1/-1' }}><textarea style={{ ...s.input, minHeight: 56, resize: 'vertical' }} value={form.descripcion} onChange={e => set('descripcion', e.target.value)} /></Campo>
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
    <Modal title={itemEdit ? "Editar Cliente" : "Nuevo Cliente"} onClose={onClose} onGuardar={() => onGuardar(form)} guardarLabel={itemEdit ? "Actualizar" : "Guardar"}>
      <Campo label="Nombre / Razón Social" style={{ marginBottom: 12 }}>
        <input style={s.input} value={form.nombre} onChange={e => set('nombre', e.target.value)} placeholder="Nombre del cliente" />
      </Campo>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Campo label="Teléfono (opcional)">
          <input style={s.input} value={form.telefono || ''} onChange={e => set('telefono', e.target.value)} placeholder="Ej: +54..." />
        </Campo>
        <Campo label="Email (opcional)">
          <input style={s.input} type="email" value={form.email || ''} onChange={e => set('email', e.target.value)} placeholder="correo@ejemplo.com" />
        </Campo>
      </div>
    </Modal>
  )
}

function ModalProveedor({ itemEdit, onClose, onGuardar }) {
  const [form, setForm] = useState(itemEdit || { nombre: '', cuit: '', rubro: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <Modal title={itemEdit ? "Editar Proveedor" : "Nuevo Proveedor"} onClose={onClose} onGuardar={() => onGuardar(form)} guardarLabel={itemEdit ? "Actualizar" : "Guardar"}>
      <Campo label="Nombre / Razón Social" style={{ marginBottom: 12 }}>
        <input style={s.input} value={form.nombre} onChange={e => set('nombre', e.target.value)} placeholder="Ferretería, Empresa..." />
      </Campo>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Campo label="CUIT / RUT (opcional)">
          <input style={s.input} value={form.cuit || ''} onChange={e => set('cuit', e.target.value)} placeholder="Sin guiones" />
        </Campo>
        <Campo label="Rubro (opcional)">
          <input style={s.input} value={form.rubro || ''} onChange={e => set('rubro', e.target.value)} placeholder="Ej: Materiales, Pintura..." />
        </Campo>
      </div>
    </Modal>
  )
}

// ── Componentes genéricos ────────────────────────────────────
function Modal({ title, children, onClose, onGuardar, guardarLabel = 'Guardar' }) {
  return (
    <div style={s.modalBg} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        <h3 style={{ fontSize: 15, fontWeight: 500, marginBottom: 14 }}>{title}</h3>
        {children}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button style={s.btnSecondary} onClick={onClose}>Cancelar</button>
          {onGuardar && <button style={s.btnPrimary} onClick={onGuardar}>{guardarLabel}</button>}
        </div>
      </div>
    </div>
  )
}

function Campo({ label, children, style }) {
  return (
    <div style={style}>
      <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  )
}

function StatCard({ label, value, sub }) {
  return (
    <div style={s.statCard}>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 500 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function ConceptoBadge({ concepto }) {
  const colors = { materiales: ['#E6F1FB', '#185FA5'], 'mano-obra': ['#EAF3DE', '#3B6D11'], equipos: ['#FAEEDA', '#854F0B'], subcontratos: ['#EEEDFE', '#534AB7'], varios: ['#F1EFE8', '#5F5E5A'] }
  const [bg, color] = colors[concepto] ?? colors.varios
  return <span style={{ background: bg, color, padding: '2px 8px', borderRadius: 99, fontSize: 11 }}>{CONCEPTO_LABELS[concepto]}</span>
}

function estadoStyle(estado) {
  const m = { activa: ['#EAF3DE', '#3B6D11'], pausada: ['#FAEEDA', '#854F0B'], finalizada: ['#F1EFE8', '#5F5E5A'] }
  const [bg, color] = m[estado] ?? m.finalizada
  return { background: bg, color }
}

// ── Estilos ───────────────────────────────────────────────────
// ── Estilos ───────────────────────────────────────────────────
const s = {
  topbar: { background: '#fff', borderBottom: '0.5px solid #e5e5e3', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '12px 16px', position: 'sticky', top: 0, zIndex: 10 },
  logo: { fontSize: 15, fontWeight: 500, flexGrow: 1, minWidth: 200 },
  navTabs: { display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 4, scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' },
  tab: { padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer', border: '0.5px solid transparent', background: 'transparent', color: '#888', whiteSpace: 'nowrap' },
  tabActive: { padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer', border: '0.5px solid #1B2A4A', background: '#1B2A4A', color: '#fff', whiteSpace: 'nowrap' },
  panelHeader: { display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  panelTitle: { fontSize: 16, fontWeight: 500 },
  obrasGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 },
  obraCard: { background: '#fff', border: '0.5px solid #e5e5e3', borderRadius: 12, padding: '14px 16px', cursor: 'pointer', transition: 'all 0.2s' },
  obraNombre: { fontSize: 14, fontWeight: 500, marginBottom: 2, paddingRight: 20 },
  obraCliente: { fontSize: 12, color: '#888', marginBottom: 8 },
  obraTotal: { fontSize: 20, fontWeight: 500, color: '#1B2A4A' },
  obraSub: { fontSize: 11, color: '#aaa', marginTop: 2 },
  statusBadge: { display: 'inline-block', marginTop: 8, fontSize: 11, padding: '2px 8px', borderRadius: 99 },
  btnPrimary: { padding: '7px 14px', background: '#1B2A4A', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' },
  btnSecondary: { padding: '6px 12px', background: 'transparent', color: '#333', border: '0.5px solid #ccc', borderRadius: 8, fontSize: 12, cursor: 'pointer' },
  btnOutline: { padding: '7px 14px', background: 'transparent', color: '#1B2A4A', border: '0.5px solid #1B2A4A', borderRadius: 8, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' },
  btnDanger: { padding: '4px 8px', background: '#FFF0F0', color: '#D32F2F', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
  btnAction: { padding: '4px 8px', background: '#F0F4F8', color: '#1B2A4A', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
  select: { padding: '7px 10px', border: '0.5px solid #ccc', borderRadius: 8, fontSize: 13, background: '#fff', maxWidth: '100%' },
  input: { width: '100%', padding: '7px 10px', fontSize: 13, border: '0.5px solid #ccc', borderRadius: 8, background: '#fff', boxSizing: 'border-box' },
  tabla: { width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 600 },
  th: { fontSize: 11, fontWeight: 500, color: '#888', textAlign: 'left', padding: '8px 10px', borderBottom: '0.5px solid #e5e5e3', textTransform: 'uppercase', letterSpacing: '0.04em' },
  td: { padding: '9px 10px', borderBottom: '0.5px solid #f0f0ee' },
  chipObra: { fontSize: 11, padding: '2px 8px', background: '#E6F1FB', color: '#185FA5', borderRadius: 99 },
  muted: { color: '#aaa', fontSize: 13, padding: '20px 0' },
  statsRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 20 },
  statCard: { background: '#f4f4f2', borderRadius: 8, padding: 14 },
  sectionTitle: { fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 },
  barWrap: { flex: 1, height: 6, background: '#eee', borderRadius: 99, overflow: 'hidden' },
  bar: { height: '100%', borderRadius: 99 },
  modalBg: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  modal: { background: '#fff', borderRadius: 12, border: '0.5px solid #ddd', padding: 20, width: '100%', maxWidth: 440, maxHeight: '85vh', overflowY: 'auto', boxSizing: 'border-box' },
  uploadZone: { display: 'block', border: '1.5px dashed #ccc', borderRadius: 12, padding: 24, textAlign: 'center', cursor: 'pointer', background: '#fafafa', marginBottom: 8 },
  aiBadge: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', background: '#E6F1FB', color: '#0C447C', fontSize: 11, borderRadius: 99 },
}