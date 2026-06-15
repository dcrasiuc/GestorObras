import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'
import { C, MEDIOS_PAGO, IVA } from './constants'
import { fmt, hoy, dbWrite } from './utils'
import { toast } from './toast'

// ── Hooks ────────────────────────────────────────────────────
function useProveedores() {
  const [proveedores, setProveedores] = useState([])
  useEffect(() => {
    supabase.from('proveedores').select('*').order('nombre').then(({ data }) => {
      if (data) setProveedores(data)
    })
  }, [])
  return proveedores
}

function useObras() {
  const [obras, setObras] = useState([])
  useEffect(() => {
    supabase.from('obras').select('id, nombre').eq('estado', 'activa').order('nombre').then(({ data }) => {
      if (data) setObras(data)
    })
  }, [])
  return obras
}

function useBancos() {
  const [bancos, setBancos] = useState([])
  useEffect(() => {
    supabase.from('bancos').select('*').order('nombre').then(({ data }) => {
      if (data) setBancos(data)
    })
  }, [])
  return bancos
}

function useRemitos(proveedorId) {
  const [remitos, setRemitos] = useState([])
  const [loading, setLoading] = useState(false)
  const cargar = useCallback(async () => {
    if (!proveedorId) { setRemitos([]); return }
    setLoading(true)
    const failsafe = setTimeout(() => setLoading(false), 12000)
    try {
      const { data, error } = await supabase
        .from('remitos')
        .select('*, remito_items(*)')
        .eq('proveedor_id', proveedorId)
        .order('fecha', { ascending: false })
      if (error) console.error('useRemitos error:', error)
      let lista = data ?? []
      // Distribución por obras: comprobante_obras es polimórfica (sin FK directo), se trae aparte
      if (lista.length > 0) {
        const ids = lista.map(r => r.id)
        const { data: dist } = await supabase.from('comprobante_obras').select('*').eq('tipo', 'remito').in('referencia_id', ids)
        if (dist) lista = lista.map(r => ({ ...r, comprobante_obras: dist.filter(d => d.referencia_id === r.id) }))
      }
      setRemitos(lista)
    } catch (e) {
      console.error('useRemitos exception:', e)
    }
    clearTimeout(failsafe)
    setLoading(false)
  }, [proveedorId])
  useEffect(() => { cargar() }, [cargar])
  return { remitos, loading, recargar: cargar }
}

function useCCPagos(proveedorId) {
  const [pagos, setPagos] = useState([])
  const cargar = useCallback(async () => {
    if (!proveedorId) { setPagos([]); return }
    const { data } = await supabase
      .from('cc_pagos')
      .select('*, bancos(nombre), cc_pago_items(*)')
      .eq('proveedor_id', proveedorId)
      .order('fecha_pago', { ascending: false })
    setPagos(data ?? [])
  }, [proveedorId])
  useEffect(() => { cargar() }, [cargar])
  return { pagos, recargar: cargar }
}

function useResumenCC() {
  const [resumen, setResumen] = useState([])
  const [loading, setLoading] = useState(true)
  const cargar = useCallback(async () => {
    setLoading(true)
    const failsafe = setTimeout(() => setLoading(false), 12000)
    try {
      const { data, error } = await supabase
        .from('remitos')
        .select('*, proveedores(id, nombre, situacion_impositiva)')
        .eq('estado', 'pendiente')
        .order('fecha', { ascending: false })
      if (error) {
        console.error('useResumenCC error:', error)
      } else if (data) {
        const mapa = {}
        data.forEach(r => {
          const pId = r.proveedor_id
          if (!mapa[pId]) mapa[pId] = { proveedor: r.proveedores, remitos: [], totalNeto: 0 }
          mapa[pId].remitos.push(r)
          mapa[pId].totalNeto += r.monto_neto ?? 0
        })
        setResumen(Object.values(mapa).sort((a, b) => b.totalNeto - a.totalNeto))
      }
    } catch (e) {
      console.error('useResumenCC exception:', e)
      setResumen([])
    }
    clearTimeout(failsafe)
    setLoading(false)
  }, [])
  useEffect(() => { cargar() }, [cargar])
  return { resumen, loading, recargar: cargar }
}


// ── Componente principal ─────────────────────────────────────
export default function CuentaCorriente({ esAdmin, usuario }) {
  const proveedores = useProveedores()
  const obras = useObras()
  const bancos = useBancos()
  const [proveedorId, setProveedorId] = useState(null) // null = vista general
  const [tab, setTab] = useState('remitos')
  const [modal, setModal] = useState(null)
  const [itemEditando, setItemEditando] = useState(null)

  const { resumen, loading: loadingResumen, recargar: recargarResumen } = useResumenCC()
  const { remitos, loading: loadingRemitos, recargar: recargarRemitos } = useRemitos(proveedorId)
  const { pagos, recargar: recargarPagos } = useCCPagos(proveedorId)

  const proveedor = proveedores.find(p => p.id === proveedorId)
  const esRI = proveedor?.situacion_impositiva === 'responsable_inscripto'
  const remitosP = remitos.filter(r => r.estado === 'pendiente' || r.estado === 'facturado')
  const saldoPendiente = remitosP.reduce((s, r) => s + (r.monto_neto ?? 0), 0)
  const saldoConIva = esRI ? saldoPendiente * (1 + IVA) : saldoPendiente

  const abrirModal = (tipo, item = null) => { setItemEditando(item); setModal(tipo) }
  const cerrarModal = () => { setModal(null); setItemEditando(null) }
  const recargarTodo = () => { recargarRemitos(); recargarResumen(); recargarPagos() }

  // Vista general — lista de proveedores con saldo pendiente
  if (!proveedorId) {
    const totalPendiente = resumen.reduce((s, r) => s + r.totalNeto, 0)
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>Cuenta Corriente</h1>
            <p style={{ fontSize: 12, color: C.textMuted, margin: '3px 0 0' }}>Estado general de proveedores</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <BtnSecondary onClick={() => abrirModal('foto')}>📎 Remito</BtnSecondary>
            <BtnPrimary onClick={() => abrirModal('remito')}>+ Remito</BtnPrimary>
          </div>
        </div>

        {/* Total general */}
        {totalPendiente > 0 && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '16px 20px', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Total pendiente de pago</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: C.orange, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.03em' }}>$ {fmt(totalPendiente)}</div>
            </div>
            <div style={{ fontSize: 13, color: C.textMuted }}>{resumen.length} proveedor{resumen.length !== 1 ? 'es' : ''}</div>
          </div>
        )}

        {loadingResumen ? <Spinner /> : resumen.length === 0 ? (
          <EmptyState texto="No hay remitos pendientes" />
        ) : (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
            {resumen.map((item, i) => {
              const esRi = item.proveedor?.situacion_impositiva === 'responsable_inscripto'
              const conIva = esRi ? item.totalNeto * (1 + IVA) : item.totalNeto
              return (
                <button key={item.proveedor?.id} onClick={() => setProveedorId(item.proveedor?.id)} style={{ width: '100%', display: 'flex', alignItems: 'center', padding: '14px 18px', borderBottom: i < resumen.length - 1 ? `1px solid ${C.borderFaint}` : 'none', background: 'transparent', border: 'none', borderBottom: i < resumen.length - 1 ? `1px solid ${C.borderFaint}` : 'none', cursor: 'pointer', textAlign: 'left', gap: 14, fontFamily: "'Outfit', sans-serif" }}>
                  <div style={{ width: 40, height: 40, borderRadius: 12, background: C.purpleDim, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0, fontWeight: 700, color: C.purple }}>
                    {(item.proveedor?.nombre ?? '?').charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{item.proveedor?.nombre ?? 'Sin nombre'}</div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                      {item.remitos.length} remito{item.remitos.length !== 1 ? 's' : ''} pendiente{item.remitos.length !== 1 ? 's' : ''}
                      {esRi && <span style={{ color: C.orange, marginLeft: 6 }}>· Resp. Inscripto</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: C.text, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>$ {fmt(item.totalNeto)}</div>
                    {esRi && <div style={{ fontSize: 10, color: C.orange, marginTop: 2 }}>c/IVA: $ {fmt(conIva)}</div>}
                  </div>
                  <div style={{ color: C.textFaint, fontSize: 16, flexShrink: 0 }}>›</div>
                </button>
              )
            })}
          </div>
        )}

        {/* Modales desde vista general */}
        {modal === 'remito' && <ModalRemito proveedorId={null} proveedores={proveedores} obras={obras} onClose={cerrarModal} onGuardar={async (datos, items, dist) => {
          const row = await dbWrite('POST', 'remitos', { proveedor_id: datos.proveedor_id || null, fecha: datos.fecha, nro_remito: datos.nro_remito, monto_neto: parseFloat(datos.monto_neto) || 0, observaciones: datos.observaciones, estado: 'pendiente' }, null, true)
          if (items.length > 0) await dbWrite('POST', 'remito_items', items.map(it => ({ ...it, remito_id: row.id })))
          if (dist.length > 0) await dbWrite('POST', 'comprobante_obras', dist.map(d => ({ tipo: 'remito', referencia_id: row.id, obra_id: d.obra_id, monto: parseFloat(d.monto) || 0, porcentaje: parseFloat(d.porcentaje) || 0 })))
          cerrarModal(); recargarResumen()
        }} />}
        {modal === 'foto' && <ModalFotoRemito proveedorId={null} proveedores={proveedores} obras={obras} onClose={cerrarModal} onGuardar={async (datos, items, dist) => {
          const row = await dbWrite('POST', 'remitos', { proveedor_id: datos.proveedor_id, fecha: datos.fecha, nro_remito: datos.nro_remito, monto_neto: parseFloat(datos.monto_neto) || 0, observaciones: datos.observaciones, estado: 'pendiente', imagen_url: datos.imagen_url }, null, true)
          if (items.length > 0) await dbWrite('POST', 'remito_items', items.map(it => ({ ...it, remito_id: row.id })))
          if (dist.length > 0) await dbWrite('POST', 'comprobante_obras', dist.map(d => ({ tipo: 'remito', referencia_id: row.id, obra_id: d.obra_id, monto: parseFloat(d.monto) || 0, porcentaje: parseFloat(d.porcentaje) || 0 })))
          cerrarModal(); recargarResumen()
        }} />}
      </div>
    )
  }

  // Vista detalle de un proveedor
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <button onClick={() => setProveedorId(null)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: C.purpleDim, border: `1px solid ${C.border}`, borderRadius: 8, cursor: 'pointer', color: C.purple, fontSize: 14, fontWeight: 600, fontFamily: "'Outfit', sans-serif", padding: '9px 16px', marginBottom: 10 }}>
            ← Volver
          </button>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>{proveedor?.nombre}</h1>
          <p style={{ fontSize: 12, color: C.textMuted, margin: '3px 0 0' }}>{esRI ? 'Responsable Inscripto · Factura A + IVA' : proveedor?.situacion_impositiva === 'monotributo' ? 'Monotributo · Factura C' : 'Cuenta corriente'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <BtnSecondary onClick={() => abrirModal('foto')}>📎 Remito</BtnSecondary>
          <BtnPrimary onClick={() => abrirModal('remito')}>+ Remito</BtnPrimary>
        </div>
      </div>

      {!proveedorId ? null : (
        <>
          {/* Stats del proveedor */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 20 }}>
            <StatCard label="Sin pagar" value={remitosP.length} sub={`${remitos.filter(r=>r.estado==='facturado').length} facturado${remitos.filter(r=>r.estado==='facturado').length!==1?'s':''}`} />
            <StatCard label="Saldo neto" value={`$ ${fmt(saldoPendiente)}`} sub="sin IVA" />
            {esRI && <StatCard label={`Saldo c/ IVA (21%)`} value={`$ ${fmt(saldoConIva)}`} sub="estimado con factura A" color={C.orange} />}
            <StatCard label="Situación fiscal" value={proveedor?.situacion_impositiva === 'responsable_inscripto' ? 'Resp. Inscripto' : proveedor?.situacion_impositiva === 'monotributo' ? 'Monotributo' : 'Otro'} sub={esRI ? 'Factura A + IVA' : 'Factura C'} color={C.purple} />
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden', marginBottom: 16, width: 'fit-content' }}>
            {[{ id: 'remitos', label: `Remitos (${remitos.length})` }, { id: 'pagos', label: `Pagos (${pagos.length})` }].map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: '7px 18px', fontSize: 13, cursor: 'pointer', border: 'none', borderRight: `1px solid ${C.border}`, fontFamily: "'Outfit', sans-serif", fontWeight: tab === t.id ? 600 : 400, background: tab === t.id ? C.purpleDim : C.surface, color: tab === t.id ? C.purple : C.textMuted }}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Lista remitos */}
          {tab === 'remitos' && (
            loadingRemitos ? <Spinner /> : remitos.length === 0 ? <EmptyState texto="No hay remitos para este proveedor" /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {remitos.map(r => (
                  <RemitoCard key={r.id} remito={r} obras={obras} esAdmin={esAdmin} esRI={esRI}
                    onEditar={() => abrirModal('editarRemito', r)}
                    onDistribuir={() => abrirModal('distribuir', r)}
                    onVincularFactura={() => abrirModal('vincularFactura', r)}
                    onEliminar={async () => {
                      if (!window.confirm('¿Anular este remito? Se elimina de la cuenta corriente.')) return
                      // Vía dbWrite: el delete directo se cuelga en mobile
                      await dbWrite('DELETE', 'remitos', null, `id=eq.${r.id}`)
                      recargarTodo()
                    }}
                  />
                ))}
              </div>
            )
          )}

          {/* Lista pagos CC */}
          {tab === 'pagos' && (
            pagos.length === 0 ? <EmptyState texto="No hay pagos registrados" /> : (
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
                {pagos.map((p, i) => (
                  <div key={p.id} style={{ padding: '14px 16px', borderBottom: i < pagos.length - 1 ? `1px solid ${C.borderFaint}` : 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{MEDIOS_PAGO.find(m => m.value === p.medio_pago)?.label ?? p.medio_pago}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{p.fecha_pago} · {p.bancos?.nombre ?? ''} {p.nro_operacion ? `· Op: ${p.nro_operacion}` : ''}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.green, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>$ {fmt(p.monto_total)}</div>
                        <div style={{ fontSize: 10, color: C.textFaint, marginTop: 2 }}>{p.cc_pago_items?.length ?? 0} remito{p.cc_pago_items?.length !== 1 ? 's' : ''} cancelado{p.cc_pago_items?.length !== 1 ? 's' : ''}</div>
                      </div>
                    </div>
                    {p.comprobante_url && <a href={p.comprobante_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: C.purple, fontWeight: 500 }}>📎 Ver comprobante</a>}
                  </div>
                ))}
              </div>
            )
          )}

          {/* Botón pagar CC */}
          {tab === 'remitos' && remitosP.length > 0 && esAdmin && (
            <div style={{ marginTop: 16 }}>
              <BtnPrimary onClick={() => abrirModal('pagarCC')}>
                💳 Registrar pago de cuenta corriente
              </BtnPrimary>
            </div>
          )}
        </>
      )}

      {/* MODALES */}
      {(modal === 'remito' || modal === 'editarRemito') && (
        <ModalRemito itemEdit={itemEditando} proveedorId={proveedorId} proveedores={proveedores} obras={obras} onClose={cerrarModal}
          onGuardar={async (datos, items, dist) => {
            let remitoId = datos.id
            if (remitoId) {
              await dbWrite('PATCH', 'remitos', { proveedor_id: datos.proveedor_id || proveedorId, fecha: datos.fecha, nro_remito: datos.nro_remito, monto_neto: datos.monto_neto, observaciones: datos.observaciones }, `id=eq.${remitoId}`)
              await dbWrite('DELETE', 'remito_items', null, `remito_id=eq.${remitoId}`)
            } else {
              const row = await dbWrite('POST', 'remitos', { proveedor_id: datos.proveedor_id || proveedorId, fecha: datos.fecha, nro_remito: datos.nro_remito, monto_neto: parseFloat(datos.monto_neto) || 0, observaciones: datos.observaciones, estado: 'pendiente' }, null, true)
              remitoId = row.id
            }
            if (items.length > 0) await dbWrite('POST', 'remito_items', items.map(it => ({ ...it, remito_id: remitoId })))
            if (dist.length > 0) {
              await dbWrite('DELETE', 'comprobante_obras', null, `referencia_id=eq.${remitoId}&tipo=eq.remito`)
              await dbWrite('POST', 'comprobante_obras', dist.map(d => ({ tipo: 'remito', referencia_id: remitoId, obra_id: d.obra_id, monto: parseFloat(d.monto) || 0, porcentaje: parseFloat(d.porcentaje) || 0 })))
            }
            cerrarModal(); recargarTodo()
          }}
        />
      )}

      {modal === 'foto' && (
        <ModalFotoRemito proveedorId={proveedorId} proveedores={proveedores} obras={obras} onClose={cerrarModal}
          onGuardar={async (datos, items, dist) => {
            const row = await dbWrite('POST', 'remitos', { proveedor_id: datos.proveedor_id || proveedorId, fecha: datos.fecha, nro_remito: datos.nro_remito, monto_neto: parseFloat(datos.monto_neto) || 0, observaciones: datos.observaciones, estado: 'pendiente', imagen_url: datos.imagen_url }, null, true)
            if (items.length > 0) await dbWrite('POST', 'remito_items', items.map(it => ({ ...it, remito_id: row.id })))
            if (dist.length > 0) await dbWrite('POST', 'comprobante_obras', dist.map(d => ({ tipo: 'remito', referencia_id: row.id, obra_id: d.obra_id, monto: parseFloat(d.monto) || 0, porcentaje: parseFloat(d.porcentaje) || 0 })))
            if (datos.proveedor_id && datos.proveedor_id !== proveedorId) setProveedorId(datos.proveedor_id)
            cerrarModal(); recargarTodo()
          }}
        />
      )}

      {modal === 'distribuir' && (
        <ModalDistribuir remito={itemEditando} obras={obras} esRI={esRI} onClose={cerrarModal}
          onGuardar={async (dist) => {
            await dbWrite('DELETE', 'comprobante_obras', null, `referencia_id=eq.${itemEditando.id}&tipo=eq.remito`)
            await dbWrite('POST', 'comprobante_obras', dist.map(d => ({ tipo: 'remito', referencia_id: itemEditando.id, obra_id: d.obra_id, monto: parseFloat(d.monto) || 0, porcentaje: parseFloat(d.porcentaje) || 0 })))
            cerrarModal(); recargarTodo()
          }}
        />
      )}

      {modal === 'vincularFactura' && (
        <ModalVincularFactura
          remito={itemEditando}
          remitosDisponibles={remitos.filter(r => r.estado === 'pendiente')}
          esRI={esRI}
          onClose={cerrarModal}
          onGuardar={async (datos, remitoIds) => {
            await dbWrite('PATCH', 'remitos', { nro_factura: datos.nro_factura, fecha_factura: datos.fecha_factura, monto_factura: parseFloat(datos.monto_factura) || null, estado: 'facturado' }, `id=in.(${remitoIds.join(',')})`)
            cerrarModal(); recargarTodo()
          }}
        />
      )}

      {modal === 'pagarCC' && (
        <ModalPagarCC proveedor={proveedor} remitos={remitosP} bancos={bancos} esRI={esRI} onClose={cerrarModal}
          onGuardar={async (pago, remitoIds, montosAplicados) => {
            const row = await dbWrite('POST', 'cc_pagos', { ...pago, proveedor_id: proveedorId, creado_por: usuario?.id }, null, true)
            await dbWrite('POST', 'cc_pago_items', remitoIds.map((rid, i) => ({ pago_id: row.id, tipo: 'remito', referencia_id: rid, monto_aplicado: montosAplicados[i] })))
            await dbWrite('PATCH', 'remitos', { estado: 'cancelado' }, `id=in.(${remitoIds.join(',')})`)
            cerrarModal(); recargarTodo()
          }}
        />
      )}
    </div>
  )
}

// ── RemitoCard ────────────────────────────────────────────────
function RemitoCard({ remito, obras, esAdmin, esRI, onEditar, onDistribuir, onVincularFactura, onEliminar }) {
  const [expandido, setExpandido] = useState(false)
  const dist = remito.comprobante_obras ?? []
  const montoConIva = esRI ? (remito.monto_neto ?? 0) * (1 + IVA) : remito.monto_neto ?? 0

  const estadoColor = { pendiente: [C.orangeDim, C.orange], facturado: [C.purpleDim, C.purple], cancelado: [C.greenDim, C.green] }
  const [stBg, stColor] = estadoColor[remito.estado] ?? estadoColor.pendiente

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
      {/* Header del remito */}
      <div style={{ padding: '14px 16px', cursor: 'pointer' }} onClick={() => setExpandido(!expandido)}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
                {remito.nro_remito ? `Remito ${remito.nro_remito}` : 'Sin nro.'}
              </span>
              <span style={{ background: stBg, color: stColor, padding: '2px 8px', borderRadius: 99, fontSize: 10, fontWeight: 600 }}>
                {remito.estado.charAt(0).toUpperCase() + remito.estado.slice(1)}
              </span>
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>{remito.fecha}</div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>
              {remito.monto_neto > 0 ? `$ ${fmt(remito.monto_neto)}` : 'Sin importe'}
            </div>
            {esRI && remito.monto_neto > 0 && (
              <div style={{ fontSize: 10, color: C.orange, marginTop: 2 }}>c/IVA: $ {fmt(montoConIva)}</div>
            )}
            <div style={{ fontSize: 10, color: C.textFaint, marginTop: 1 }}>{expandido ? '▲' : '▼'}</div>
          </div>
        </div>

        {/* Distribución por obras (resumen) */}
        {dist.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {dist.map(d => {
              const obra = d.obra_id
              return (
                <span key={d.id} style={{ fontSize: 10, padding: '2px 7px', background: C.purpleDim, color: C.purple, borderRadius: 99, fontWeight: 500 }}>
                  $ {fmt(d.monto)}
                </span>
              )
            })}
          </div>
        )}

        {/* Acciones rápidas (siempre visibles, sin expandir) */}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
          {remito.estado === 'pendiente' && <button style={{ ...btnSt, color: C.purple, background: C.purpleDim, borderColor: C.border }} onClick={onVincularFactura}>🔗 Vincular factura</button>}
          {remito.estado === 'facturado' && <button style={{ ...btnSt, color: C.purple, background: C.purpleDim, borderColor: C.border }} onClick={onVincularFactura}>✏️ Editar factura</button>}
          {esAdmin && <button style={btnSt} onClick={onEditar}>✏️ Editar</button>}
          {esAdmin && remito.estado === 'pendiente' && <button style={{ ...btnSt, color: '#D0021B', background: '#FFF0F0', borderColor: '#FFDCDC' }} onClick={onEliminar}>✕ Anular</button>}
        </div>
      </div>

      {/* Detalle expandido */}
      {expandido && (
        <div style={{ borderTop: `1px solid ${C.borderFaint}`, padding: '12px 16px', background: '#FAFAFA' }}>
          {/* Ítems */}
          {remito.remito_items?.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Ítems del remito</div>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
                {remito.remito_items.map((item, i) => (
                  <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderBottom: i < remito.remito_items.length - 1 ? `1px solid ${C.borderFaint}` : 'none', fontSize: 12 }}>
                    <span style={{ color: C.text, flex: 1 }}>{item.descripcion}</span>
                    <span style={{ color: C.textMuted, marginLeft: 10 }}>{item.cantidad} {item.unidad}</span>
                    {item.precio_unitario > 0 && <span style={{ color: C.text, fontWeight: 600, marginLeft: 10, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>$ {fmt(item.subtotal)}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Distribución por obras */}
          {dist.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Distribución por obras</div>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
                {dist.map((d, i) => (
                  <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderBottom: i < dist.length - 1 ? `1px solid ${C.borderFaint}` : 'none', fontSize: 12 }}>
                    <span style={{ color: C.text }}>{d.porcentaje > 0 ? `${d.porcentaje}%` : ''}</span>
                    <span style={{ fontWeight: 600, color: C.purple, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>$ {fmt(d.monto)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {remito.observaciones && <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>{remito.observaciones}</div>}

          {/* Factura vinculada */}
          {remito.nro_factura && (
            <div style={{ background: C.purpleDim, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 12 }}>
              <div style={{ fontWeight: 600, color: C.purple, marginBottom: 2 }}>🔗 Factura vinculada</div>
              <div style={{ color: C.text }}>N° {remito.nro_factura}{remito.fecha_factura ? ` · ${remito.fecha_factura}` : ''}</div>
              {remito.monto_factura > 0 && <div style={{ color: C.textMuted, marginTop: 2 }}>Monto factura: $ {fmt(remito.monto_factura)}</div>}
            </div>
          )}

          {/* Acciones secundarias */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {remito.imagen_url && <a href={remito.imagen_url} target="_blank" rel="noreferrer" style={{ ...btnSt, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>📎 Ver remito</a>}
            <button style={btnSt} onClick={onDistribuir}>🏗️ Distribuir obras</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Modal Remito (manual) ─────────────────────────────────────
function ModalRemito({ itemEdit, proveedorId, proveedores = [], obras, onClose, onGuardar }) {
  const [form, setForm] = useState(itemEdit ? { ...itemEdit } : { proveedor_id: proveedorId || '', fecha: hoy(), nro_remito: '', monto_neto: '', observaciones: '' })
  const [items, setItems] = useState(itemEdit?.remito_items ?? [])
  const [dist, setDist] = useState(itemEdit?.comprobante_obras ?? [])
  const [tieneImporte, setTieneImporte] = useState(itemEdit ? (itemEdit.monto_neto > 0) : true)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const agregarItem = () => setItems(i => [...i, { descripcion: '', cantidad: '', unidad: 'un', precio_unitario: '', subtotal: '' }])
  const setItem = (idx, k, v) => {
    setItems(items => items.map((it, i) => {
      if (i !== idx) return it
      const updated = { ...it, [k]: v }
      if (k === 'cantidad' || k === 'precio_unitario') {
        const cant = parseFloat(k === 'cantidad' ? v : it.cantidad) || 0
        const precio = parseFloat(k === 'precio_unitario' ? v : it.precio_unitario) || 0
        updated.subtotal = cant * precio
      }
      return updated
    }))
  }
  const totalItems = items.reduce((s, it) => s + (parseFloat(it.subtotal) || 0), 0)

  return (
    <Modal title={itemEdit ? 'Editar Remito' : 'Nuevo Remito'} onClose={onClose} onGuardar={() => { if (!form.proveedor_id) { toast('Seleccioná un proveedor'); return } onGuardar({ ...form, monto_neto: tieneImporte ? form.monto_neto : 0 }, items.filter(it => it.descripcion), dist) }} ancho={560}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Campo label="Proveedor" style={{ gridColumn: '1/-1' }}>
          <select style={inputSt} value={form.proveedor_id || ''} onChange={e => set('proveedor_id', e.target.value)}>
            <option value="">Seleccionar proveedor...</option>
            {proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </Campo>
        <Campo label="Fecha"><input style={inputSt} type="date" value={form.fecha} onChange={e => set('fecha', e.target.value)} /></Campo>
        <Campo label="Nro. remito"><input style={inputSt} value={form.nro_remito} onChange={e => set('nro_remito', e.target.value)} placeholder="R 0001-00001234" /></Campo>
      </div>

      <div style={{ marginTop: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.text, cursor: 'pointer', marginBottom: 10 }}>
          <input type="checkbox" checked={tieneImporte} onChange={e => setTieneImporte(e.target.checked)} style={{ accentColor: C.purple }} />
          El remito tiene importe (neto, sin IVA)
        </label>
        {tieneImporte && (
          <Campo label="Monto neto (sin IVA)">
            <input style={inputSt} type="number" value={form.monto_neto} onChange={e => set('monto_neto', e.target.value)} placeholder="0" />
          </Campo>
        )}
      </div>

      {/* Ítems */}
      <div style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Ítems (opcional)</div>
          <button onClick={agregarItem} style={{ ...btnSt, fontSize: 11 }}>+ Agregar ítem</button>
        </div>
        {items.map((it, idx) => (
          <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 50px 80px 80px 24px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <input style={{ ...inputSt, fontSize: 11 }} value={it.descripcion} onChange={e => setItem(idx, 'descripcion', e.target.value)} placeholder="Descripción" />
            <input style={{ ...inputSt, fontSize: 11 }} type="number" value={it.cantidad} onChange={e => setItem(idx, 'cantidad', e.target.value)} placeholder="Cant" />
            <input style={{ ...inputSt, fontSize: 11 }} value={it.unidad} onChange={e => setItem(idx, 'unidad', e.target.value)} placeholder="Un" />
            <input style={{ ...inputSt, fontSize: 11 }} type="number" value={it.precio_unitario} onChange={e => setItem(idx, 'precio_unitario', e.target.value)} placeholder="Precio" />
            <div style={{ fontSize: 11, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', color: C.text, textAlign: 'right' }}>$ {fmt(it.subtotal || 0)}</div>
            <button onClick={() => setItems(items.filter((_, i) => i !== idx))} style={{ background: 'transparent', border: 'none', color: '#D0021B', cursor: 'pointer', fontSize: 14 }}>✕</button>
          </div>
        ))}
        {items.length > 0 && totalItems > 0 && (
          <div style={{ textAlign: 'right', fontSize: 12, fontWeight: 600, color: C.text, marginTop: 4 }}>
            Total ítems: $ {fmt(totalItems)}
            {tieneImporte && Math.abs(totalItems - parseFloat(form.monto_neto || 0)) > 1 && (
              <span style={{ color: C.orange, marginLeft: 8, fontWeight: 400 }}>⚠ No coincide con el monto</span>
            )}
          </div>
        )}
      </div>

      {/* Distribución por obras */}
      <DistribucionObras obras={obras} dist={dist} setDist={setDist} montoTotal={tieneImporte ? parseFloat(form.monto_neto || 0) : totalItems} />

      <Campo label="Observaciones" style={{ marginTop: 12 }}>
        <textarea style={{ ...inputSt, minHeight: 56, resize: 'vertical' }} value={form.observaciones || ''} onChange={e => set('observaciones', e.target.value)} />
      </Campo>
    </Modal>
  )
}

// ── Modal Foto Remito ─────────────────────────────────────────
function ModalFotoRemito({ proveedorId, proveedores, obras, onClose, onGuardar }) {
  const [step, setStep] = useState('upload')
  const [form, setForm] = useState({ proveedor_id: proveedorId || '', fecha: hoy(), nro_remito: '', monto_neto: '', observaciones: '', imagen_url: '' })
  const [items, setItems] = useState([])
  const [dist, setDist] = useState([])
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
      supabase.storage.from('comprobantes').upload(`remitos/${Date.now()}.${ext}`, file)
        .then(({ data: uploadData }) => {
          if (uploadData) imageUrl = supabase.storage.from('comprobantes').getPublicUrl(uploadData.path).data.publicUrl
        }).catch(() => {})

      // 3. IA con fetch directo + timeout de 30s
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
      const fnUrl = 'https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante'
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
      const instruccion = 'Este documento puede ser un REMITO o una FACTURA. Detectá el tipo. Para remitos extraé: nro_remito, fecha, proveedor, monto_neto (neto sin IVA, 0 si no tiene precio), items (array con descripcion, cantidad, unidad, precio_unitario, subtotal). Responde SOLO JSON con campos: tipo (remito|factura), nro_remito, fecha, proveedor, monto_neto, items.'
      const respRaw = await Promise.race([
        fetch(fnUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}` }, body: JSON.stringify({ base64, mimeType: file.type, hoy: hoy(), instruccion }) }),
        timeout
      ])
      const data = await respRaw.json()
      if (respRaw.ok && data?.content) {
        const text = data.content.map(i => i.text || '').join('')
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
        const matchProv = proveedores.find(p => p.nombre.toLowerCase().includes((parsed.proveedor || '').toLowerCase()))
        setForm(f => ({
          ...f,
          proveedor_id: matchProv ? matchProv.id : f.proveedor_id,
          fecha: parsed.fecha || hoy(),
          nro_remito: parsed.nro_remito || '',
          monto_neto: parsed.monto_neto || '',
          observaciones: parsed.tipo === 'factura' ? '⚠ La IA detectó que esto podría ser una FACTURA, no un remito.' : '',
          imagen_url: imageUrl,
        }))
        if (parsed.items?.length > 0) setItems(parsed.items)
      } else {
        setForm(f => ({ ...f, imagen_url: imageUrl }))
        toast('IA no disponible — completá los datos manualmente')
      }
    } catch (e) {
      setForm(f => ({ ...f, imagen_url: imageUrl }))
      toast(e?.message === 'timeout' ? 'IA tardó demasiado — completá los datos manualmente' : 'Error al analizar — completá los datos manualmente')
    } finally {
      setStep('review')
    }
  }

  return (
    <Modal title="Cargar remito" onClose={onClose} onGuardar={step === 'review' ? () => { if (!form.proveedor_id) { toast('Seleccioná un proveedor'); return } onGuardar(form, items.filter(it => it.descripcion), dist) } : null} guardarLabel="Guardar remito" ancho={560}>
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
              <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>Imagen o PDF del remito</div>
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
          {preview && (currentFile?.type === 'application/pdf'
            ? <div style={{ fontSize: 36, marginBottom: 12 }}>📄</div>
            : <img src={preview} alt="" style={{ maxHeight: 80, borderRadius: 6, marginBottom: 12, display: 'block' }} />
          )}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', background: C.purpleDim, color: C.purple, fontSize: 11, borderRadius: 99, marginBottom: 14, fontWeight: 600 }}>✨ Revisá los datos antes de guardar</div>
          {form.observaciones && <div style={{ background: '#FFF8ED', border: `1px solid #FFDCAA`, borderRadius: 8, padding: '8px 12px', fontSize: 12, color: C.orange, marginBottom: 12 }}>{form.observaciones}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Campo label="Proveedor" style={{ gridColumn: '1/-1' }}>
              <select style={inputSt} value={form.proveedor_id || ''} onChange={e => set('proveedor_id', e.target.value)}>
                <option value="">Sin proveedor</option>
                {proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
            </Campo>
            <Campo label="Fecha"><input style={inputSt} type="date" value={form.fecha} onChange={e => set('fecha', e.target.value)} /></Campo>
            <Campo label="Nro. remito"><input style={inputSt} value={form.nro_remito} onChange={e => set('nro_remito', e.target.value)} placeholder="R 0001-00001234" /></Campo>
            <Campo label="Monto neto (sin IVA, 0 si no tiene)" style={{ gridColumn: '1/-1' }}>
              <input style={inputSt} type="number" value={form.monto_neto} onChange={e => set('monto_neto', e.target.value)} placeholder="0" />
            </Campo>
          </div>
          {items.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Ítems detectados</div>
              <div style={{ background: '#FAFAFA', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
                {items.map((it, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 12px', borderBottom: i < items.length - 1 ? `1px solid ${C.borderFaint}` : 'none', fontSize: 12 }}>
                    <span style={{ color: C.text }}>{it.descripcion}</span>
                    <span style={{ color: C.textMuted }}>{it.cantidad} {it.unidad}</span>
                    {it.subtotal > 0 && <span style={{ fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>$ {fmt(it.subtotal)}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          <DistribucionObras obras={obras} dist={dist} setDist={setDist} montoTotal={parseFloat(form.monto_neto || 0)} />
          <Campo label="Observaciones" style={{ marginTop: 12 }}>
            <textarea style={{ ...inputSt, minHeight: 48, resize: 'vertical' }} value={form.observaciones || ''} onChange={e => set('observaciones', e.target.value)} />
          </Campo>
        </div>
      )}
    </Modal>
  )
}

// ── Modal Distribuir obras ────────────────────────────────────
function ModalDistribuir({ remito, obras, esRI, onClose, onGuardar }) {
  const montoBase = remito.monto_neto ?? 0
  const montoConIva = esRI ? montoBase * (1 + IVA) : montoBase
  const [dist, setDist] = useState(remito.comprobante_obras ?? [])
  const [usarConIva, setUsarConIva] = useState(false)
  const montoUsar = usarConIva ? montoConIva : montoBase

  return (
    <Modal title="Distribuir entre obras" onClose={onClose} onGuardar={() => onGuardar(dist)} ancho={500}>
      <div style={{ background: C.purpleDim, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12 }}>
        <div style={{ fontWeight: 600, color: C.text }}>Remito {remito.nro_remito || 'sin nro.'} — {remito.fecha}</div>
        {montoBase > 0 && (
          <div style={{ marginTop: 6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: C.textMuted }}>Neto: $ {fmt(montoBase)}</span>
            {esRI && <span style={{ color: C.orange }}>Con IVA 21%: $ {fmt(montoConIva)}</span>}
            {esRI && montoBase > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, cursor: 'pointer', color: C.text }}>
                <input type="checkbox" checked={usarConIva} onChange={e => setUsarConIva(e.target.checked)} style={{ accentColor: C.purple }} />
                Distribuir con IVA incluido
              </label>
            )}
          </div>
        )}
      </div>
      <DistribucionObras obras={obras} dist={dist} setDist={setDist} montoTotal={montoUsar} />
    </Modal>
  )
}

// ── Modal Vincular Factura ────────────────────────────────────
function ModalVincularFactura({ remito, remitosDisponibles, esRI, onClose, onGuardar }) {
  const [seleccionados, setSeleccionados] = useState([remito.id])
  const [form, setForm] = useState({
    nro_factura: remito.nro_factura || '',
    fecha_factura: remito.fecha_factura || hoy(),
    monto_factura: remito.monto_factura || '',
  })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const toggle = (id) => {
    if (id === remito.id) return // el remito origen siempre incluido
    setSeleccionados(sel => sel.includes(id) ? sel.filter(s => s !== id) : [...sel, id])
  }

  const remitosSel = remitosDisponibles.filter(r => seleccionados.includes(r.id))
  const totalNeto = remitosSel.reduce((s, r) => s + (r.monto_neto ?? 0), 0)
  const totalConIva = esRI ? totalNeto * 1.21 : totalNeto

  return (
    <Modal title="Vincular a Factura" onClose={onClose} ancho={500}
      onGuardar={() => {
        if (!form.nro_factura.trim()) return toast('Ingresá el número de factura')
        onGuardar(form, seleccionados)
      }}
      guardarLabel="Vincular y marcar como facturado"
    >
      {/* Remitos a incluir */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
          Remitos que cubre esta factura
        </div>
        <div style={{ background: '#FAFAFA', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          {remitosDisponibles.map((r, i) => (
            <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: i < remitosDisponibles.length - 1 ? `1px solid ${C.borderFaint}` : 'none', cursor: r.id === remito.id ? 'default' : 'pointer', background: r.id === remito.id ? C.purpleDim : 'transparent' }}>
              <input type="checkbox" checked={seleccionados.includes(r.id)} onChange={() => toggle(r.id)} disabled={r.id === remito.id} style={{ accentColor: C.purple, width: 15, height: 15 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: r.id === remito.id ? 600 : 400, color: C.text }}>
                  {r.nro_remito || 'Sin nro.'} — {r.fecha}
                  {r.id === remito.id && <span style={{ fontSize: 10, color: C.purple, marginLeft: 6 }}>este remito</span>}
                </div>
                {r.monto_neto > 0 && <div style={{ fontSize: 11, color: C.textMuted }}>$ {fmt(r.monto_neto)} neto</div>}
              </div>
            </label>
          ))}
        </div>
        {totalNeto > 0 && (
          <div style={{ marginTop: 6, padding: '6px 12px', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: C.textMuted }}>Total remitos seleccionados (neto): $ {fmt(totalNeto)}</span>
            {esRI && <span style={{ color: C.orange }}>c/IVA: $ {fmt(totalConIva)}</span>}
          </div>
        )}
      </div>

      {/* Datos de la factura */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Campo label="Nro. de factura" style={{ gridColumn: '1/-1' }}>
          <input style={inputSt} value={form.nro_factura} onChange={e => set('nro_factura', e.target.value)} placeholder="A 0001-00001234" />
        </Campo>
        <Campo label="Fecha de factura">
          <input style={inputSt} type="date" value={form.fecha_factura} onChange={e => set('fecha_factura', e.target.value)} />
        </Campo>
        <Campo label={`Monto factura${esRI ? ' (c/IVA)' : ''}`}>
          <input style={inputSt} type="number" value={form.monto_factura} onChange={e => set('monto_factura', e.target.value)} placeholder={totalConIva > 0 ? fmt(totalConIva) : '0'} />
        </Campo>
      </div>

      <div style={{ marginTop: 12, padding: '10px 14px', background: '#FFF8ED', border: `1px solid #FFDCAA`, borderRadius: 8, fontSize: 12, color: C.orange }}>
        ⚠ Los remitos seleccionados pasarán a estado <strong>Facturado</strong> y quedarán pendientes de pago.
      </div>
    </Modal>
  )
}

// ── Modal Pagar CC ────────────────────────────────────────────
function ModalPagarCC({ proveedor, remitos, bancos, esRI, onClose, onGuardar }) {
  const [seleccionados, setSeleccionados] = useState(remitos.map(r => r.id))
  const [form, setForm] = useState({ fecha_pago: hoy(), medio_pago: 'transferencia', banco_id: '', nro_operacion: '', titular_tarjeta: '', observaciones: '', comprobante_url: '' })
  const [subiendo, setSubiendo] = useState(false)
  const [archivoNombre, setArchivoNombre] = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const remitosSel = remitos.filter(r => seleccionados.includes(r.id))
  const totalNeto = remitosSel.reduce((s, r) => s + (r.monto_neto ?? 0), 0)
  const totalConIva = esRI ? totalNeto * (1 + IVA) : totalNeto
  const necesitaBanco = ['transferencia', 'cheque', 'tarjeta'].includes(form.medio_pago)

  const toggleRemito = (id) => setSeleccionados(sel => sel.includes(id) ? sel.filter(s => s !== id) : [...sel, id])

  const subirComp = async (file) => {
    setSubiendo(true)
    const ext = file.name.split('.').pop()
    const { data } = await supabase.storage.from('comprobantes-pagos').upload(`cc/${Date.now()}.${ext}`, file)
    if (data) { const url = supabase.storage.from('comprobantes-pagos').getPublicUrl(data.path).data.publicUrl; set('comprobante_url', url); setArchivoNombre(file.name) }
    setSubiendo(false)
  }

  return (
    <Modal title="Pago de cuenta corriente" onClose={onClose} ancho={520}
      onGuardar={() => {
        if (seleccionados.length === 0) return toast('Seleccioná al menos un remito')
        const montosAplicados = remitosSel.map(r => esRI ? (r.monto_neto ?? 0) * (1 + IVA) : (r.monto_neto ?? 0))
        onGuardar({ ...form, monto_total: totalConIva, banco_id: form.banco_id || null }, seleccionados, montosAplicados)
      }}
      guardarLabel={`Confirmar pago $ ${fmt(totalConIva)}`}>

      {/* Remitos a cancelar */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Remitos a cancelar</div>
        <div style={{ background: '#FAFAFA', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          {remitos.map((r, i) => (
            <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: i < remitos.length - 1 ? `1px solid ${C.borderFaint}` : 'none', cursor: 'pointer', background: r.nro_factura ? C.purpleDim : 'transparent' }}>
              <input type="checkbox" checked={seleccionados.includes(r.id)} onChange={() => toggleRemito(r.id)} style={{ accentColor: C.purple, width: 15, height: 15 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: C.text }}>
                  {r.nro_remito || 'Sin nro.'} — {r.fecha}
                  {r.nro_factura && <span style={{ fontSize: 10, color: C.purple, marginLeft: 6, fontWeight: 600 }}>🔗 Fac. {r.nro_factura}</span>}
                </div>
                {r.monto_neto > 0 && <div style={{ fontSize: 11, color: C.textMuted }}>Neto: $ {fmt(r.monto_neto)}{esRI ? ` → c/IVA: $ ${fmt(r.monto_neto * (1 + IVA))}` : ''}</div>}
              </div>
            </label>
          ))}
        </div>
        {totalNeto > 0 && (
          <div style={{ marginTop: 8, padding: '8px 14px', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span style={{ color: C.textMuted }}>Total neto: $ {fmt(totalNeto)}</span>
            {esRI && <span style={{ color: C.orange, fontWeight: 600 }}>Total c/IVA 21%: $ {fmt(totalConIva)}</span>}
            {!esRI && <span style={{ color: C.text, fontWeight: 600 }}>Total: $ {fmt(totalNeto)}</span>}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Campo label="Fecha de pago"><input style={inputSt} type="date" value={form.fecha_pago} onChange={e => set('fecha_pago', e.target.value)} /></Campo>
        <Campo label="Medio de pago">
          <select style={inputSt} value={form.medio_pago} onChange={e => set('medio_pago', e.target.value)}>
            {MEDIOS_PAGO.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Campo>
        {necesitaBanco && <Campo label="Banco" style={{ gridColumn: '1/-1' }}><select style={inputSt} value={form.banco_id} onChange={e => set('banco_id', e.target.value)}><option value="">Seleccionar...</option>{bancos.map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}</select></Campo>}
        {form.medio_pago === 'tarjeta' && <Campo label="Titular" style={{ gridColumn: '1/-1' }}><input style={inputSt} value={form.titular_tarjeta} onChange={e => set('titular_tarjeta', e.target.value)} /></Campo>}
        {['transferencia','cheque'].includes(form.medio_pago) && <Campo label="Nro. operación (opcional)" style={{ gridColumn: '1/-1' }}><input style={inputSt} value={form.nro_operacion} onChange={e => set('nro_operacion', e.target.value)} placeholder="Opcional" /></Campo>}
        <Campo label="Observaciones" style={{ gridColumn: '1/-1' }}><textarea style={{ ...inputSt, minHeight: 48, resize: 'vertical' }} value={form.observaciones} onChange={e => set('observaciones', e.target.value)} /></Campo>
        <Campo label="Comprobante (opcional)" style={{ gridColumn: '1/-1' }}>
          {form.comprobante_url ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: C.greenDim, border: `1px solid #B8E6CF`, borderRadius: 8 }}>
              <span>📎</span><span style={{ fontSize: 12, color: C.green, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{archivoNombre}</span>
              <a href={form.comprobante_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>Ver</a>
              <button onClick={() => { set('comprobante_url', ''); setArchivoNombre('') }} style={{ background: 'transparent', border: 'none', color: '#D0021B', cursor: 'pointer', fontSize: 12 }}>✕</button>
            </div>
          ) : (
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#FAFAFA', border: `1.5px dashed ${C.border}`, borderRadius: 8, cursor: 'pointer' }}>
              <span>{subiendo ? '⏳' : '📎'}</span>
              <span style={{ fontSize: 12, color: C.textMuted }}>{subiendo ? 'Subiendo...' : 'Subir foto o PDF'}</span>
              <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => e.target.files[0] && subirComp(e.target.files[0])} disabled={subiendo} />
            </label>
          )}
        </Campo>
      </div>
    </Modal>
  )
}

// ── Distribución obras (componente reutilizable) ──────────────
function DistribucionObras({ obras, dist, setDist, montoTotal }) {
  const agregarObra = () => setDist(d => d.length === 0
    ? [{ obra_id: obras[0]?.id || '', monto: montoTotal > 0 ? String(montoTotal) : '', porcentaje: '100' }]  // primera obra: 100% por defecto
    : [...d, { obra_id: obras[0]?.id || '', monto: '', porcentaje: '' }])
  const setD = (idx, k, v) => setDist(d => d.map((it, i) => {
    if (i !== idx) return it
    const updated = { ...it, [k]: v }
    if (k === 'porcentaje' && montoTotal > 0) updated.monto = ((parseFloat(v) || 0) / 100 * montoTotal).toFixed(0)
    if (k === 'monto' && montoTotal > 0) updated.porcentaje = ((parseFloat(v) || 0) / montoTotal * 100).toFixed(1)
    return updated
  }))

  const distribuirProporcional = () => {
    if (dist.length === 0 || montoTotal === 0) return
    const por = (100 / dist.length).toFixed(1)
    const mon = (montoTotal / dist.length).toFixed(0)
    setDist(d => d.map(it => ({ ...it, porcentaje: por, monto: mon })))
  }

  const totalDist = dist.reduce((s, d) => s + (parseFloat(d.monto) || 0), 0)
  const diferencia = montoTotal - totalDist

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Distribución por obras</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {dist.length > 1 && montoTotal > 0 && <button onClick={distribuirProporcional} style={{ ...btnSt, fontSize: 11 }}>⚖ Proporcional</button>}
          <button onClick={agregarObra} style={{ ...btnSt, fontSize: 11 }}>+ Obra</button>
        </div>
      </div>
      {dist.map((d, idx) => (
        <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px 24px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <select style={{ ...inputSt, fontSize: 12 }} value={d.obra_id} onChange={e => setD(idx, 'obra_id', e.target.value)}>
            {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
          </select>
          <input style={{ ...inputSt, fontSize: 12 }} type="number" value={d.porcentaje} onChange={e => setD(idx, 'porcentaje', e.target.value)} placeholder="%" />
          <input style={{ ...inputSt, fontSize: 12 }} type="number" value={d.monto} onChange={e => setD(idx, 'monto', e.target.value)} placeholder="$ Monto" />
          <button onClick={() => setDist(d => d.filter((_, i) => i !== idx))} style={{ background: 'transparent', border: 'none', color: '#D0021B', cursor: 'pointer', fontSize: 14 }}>✕</button>
        </div>
      ))}
      {dist.length > 0 && montoTotal > 0 && (
        <div style={{ fontSize: 11, color: Math.abs(diferencia) < 1 ? C.green : C.orange, marginTop: 4, fontWeight: 500 }}>
          {Math.abs(diferencia) < 1 ? '✓ Distribución completa' : `Diferencia: $ ${fmt(Math.abs(diferencia))} ${diferencia > 0 ? 'sin asignar' : 'excedido'}`}
        </div>
      )}
    </div>
  )
}

// ── UI Genérico ───────────────────────────────────────────────
function Modal({ title, children, onClose, onGuardar, guardarLabel = 'Guardar', ancho = 480 }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 22, width: '100%', maxWidth: ancho, maxHeight: '92vh', overflowY: 'auto', boxSizing: 'border-box', boxShadow: '0 8px 40px rgba(0,0,0,0.12)' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 18 }}>{title}</h3>
        {children}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button style={{ padding: '8px 16px', background: 'transparent', color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }} onClick={onClose}>Cancelar</button>
          {onGuardar && <button style={{ padding: '8px 16px', background: C.purple, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontWeight: 600, fontFamily: "'Outfit', sans-serif" }} onClick={onGuardar}>{guardarLabel}</button>}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || C.text, fontFamily: "'Inter', sans-serif", fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function Campo({ label, children, style }) {
  return (
    <div style={{ ...style }}>
      <label style={labelSt}>{label}</label>
      {children}
    </div>
  )
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
const labelSt = { fontSize: 10, fontWeight: 600, color: C.textFaint, display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }
const btnSt = { padding: '5px 10px', background: '#F5F5F5', border: `1px solid ${C.border}`, borderRadius: 7, color: C.textMuted, cursor: 'pointer', fontSize: 12, fontFamily: "'Outfit', sans-serif" }
