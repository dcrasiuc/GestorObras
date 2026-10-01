import { useState } from 'react'
import { C } from './constants'

// ── Modal "Nueva/Editar obra" compartido entre GestorObras.jsx y Seguros.jsx (setiembre 2026) ──
// Antes cada panel tenía su propio modal de alta de obra con campos distintos: Seguros pedía
// "organismo" en texto libre y no pedía cliente vinculado; GestorObras pedía cliente pero no monto
// de contrato. Y la etapa inicial de la obra dependía de qué botón se apretaba para crearla, no de
// si la obra realmente necesitaba garantía de seguro — una obra creada desde el panel de Obras
// arrancaba directo en "ejecución" (sin pasar nunca por "oferta"), mientras que la misma obra
// creada desde Seguros arrancaba en "oferta". Eso generaba obras "en ejecución" sin ninguna
// garantía de oferta presentada. Se unificó en un solo componente + una sola regla de etapa
// (`etapaInicial`) para que no se puedan volver a desalinear.
//
// Este archivo NO importa nada de GestorObras.jsx ni de Seguros.jsx (y ninguno de esos dos importa
// de acá el uno al otro) — evita el mismo tipo de import circular que rompió toda la app en
// setiembre 2026 con exportSegurosExcel.js (ver CLAUDE.md, sección "Bugs resueltos").

const inputSt = { width: '100%', padding: '8px 12px', fontSize: 13, fontFamily: "'Outfit', sans-serif", border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface, color: C.text, boxSizing: 'border-box', outline: 'none', colorScheme: 'light' }

function Campo({ label, children, style }) {
  return (
    <div style={{ ...style }}>
      <label style={{ fontSize: 10, fontWeight: 600, color: C.textFaint, display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</label>
      {children}
    </div>
  )
}

function ModalInterno({ title, children, onClose, onGuardar, guardarLabel = 'Guardar' }) {
  const [saving, setSaving] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  const handleGuardar = async () => {
    if (!onGuardar || saving) return
    setSaving(true); setErrMsg('')
    try { await onGuardar() } catch (e) { setErrMsg(e?.message || 'Error al guardar') } finally { setSaving(false) }
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={e => e.target === e.currentTarget && onClose()}>
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

// Regla única de etapa inicial (setiembre 2026, revisada — ver "dos tildes" más abajo): una obra
// sólo arranca en "oferta" cuando efectivamente tiene que esperar una garantía de OFERTA antes de
// poder arrancar (licitación en curso, todavía no adjudicada) — no aparece en el resto de la app
// (gastos, finanzas, dropdowns) hasta que se le cargue esa garantía y se la marque "adjudicada"
// desde Seguros. Cualquier otro caso arranca directo en "ejecución": ni una obra sin garantías
// (cliente privado, obra menor) ni una obra que sí requiere pólizas pero por adjudicación directa
// (sin licitación previa) tienen que esperar nada para empezar — a esa segunda sí se le van a poder
// cargar más adelante pólizas puntuales (Responsabilidad Civil, seguro de obra, etc.) igual que a
// cualquier otra, simplemente no bloquean el arranque porque no hay licitación de la que depender.
export function etapaInicial(requierePoliza, requiereGarantiaOferta) {
  return (requierePoliza !== false && requiereGarantiaOferta !== false) ? 'oferta' : 'ejecucion'
}

export function ModalObra({ itemEdit, clientes, onClose, onGuardar }) {
  const esEdicion = !!itemEdit
  const [form, setForm] = useState(itemEdit || { nombre: '', detalle: '', cliente_id: '', estado: 'activa', presupuesto: '', monto_contrato: '', requiere_poliza: true, requiere_garantia_oferta: true, excluir_gastos_generales: false })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const requierePoliza = form.requiere_poliza !== false
  const requiereGarantiaOferta = requierePoliza && form.requiere_garantia_oferta !== false
  return (
    <ModalInterno title={esEdicion ? 'Editar Obra' : 'Nueva Obra'} onClose={onClose} onGuardar={() => onGuardar(form)}>
      <Campo label="Nombre de la obra"><input style={inputSt} value={form.nombre} onChange={e => set('nombre', e.target.value)} placeholder="Ej: Edificio Tucumán 1420 / Repavimentación Ruta 12" /></Campo>
      {/* Nombre corto para listados (ej. "CLP 8572 Garupá") separado de un detalle más explícito
          (el objeto completo de la licitación/contrato) — pedido del usuario octubre 2026 al cargar
          una obra desde un pliego: el nombre corto alcanza para identificarla de un vistazo, pero
          conviene guardar también la descripción oficial completa en algún lado. Opcional. */}
      <div style={{ marginTop: 10 }}><Campo label="Detalle (opcional)"><textarea style={{ ...inputSt, minHeight: 60, resize: 'vertical' }} value={form.detalle || ''} onChange={e => set('detalle', e.target.value)} placeholder="Ej: objeto completo del pliego/contrato, aclaraciones, tramo, ubicación exacta..." /></Campo></div>
      <div style={{ marginTop: 10 }}><Campo label="Cliente"><select style={inputSt} value={form.cliente_id || ''} onChange={e => set('cliente_id', e.target.value)}><option value="">Sin cliente</option>{clientes?.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></Campo></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
        <Campo label="Presupuesto (gastos)"><input style={inputSt} type="number" value={form.presupuesto} onChange={e => set('presupuesto', e.target.value)} placeholder="0" /></Campo>
        <Campo label="Monto de contrato"><input style={inputSt} type="number" value={form.monto_contrato} onChange={e => set('monto_contrato', e.target.value)} placeholder="Opcional" /></Campo>
      </div>
      <div style={{ marginTop: 10 }}><Campo label="Estado"><select style={inputSt} value={form.estado || 'activa'} onChange={e => set('estado', e.target.value)}>{['activa', 'pausada', 'finalizada'].map(v => <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>)}</select></Campo></div>
      <div style={{ marginTop: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.textMuted, cursor: 'pointer' }}>
          <input type="checkbox" checked={requierePoliza} onChange={e => set('requiere_poliza', e.target.checked)} style={{ accentColor: C.purple }} />
          Requiere garantías / pólizas de seguro (desmarcar en obras menores o de clientes privados que no las piden)
        </label>
      </div>
      {requierePoliza && (
        <div style={{ marginTop: 8, marginLeft: 24 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.textMuted, cursor: 'pointer' }}>
            <input type="checkbox" checked={requiereGarantiaOferta} onChange={e => set('requiere_garantia_oferta', e.target.checked)} style={{ accentColor: C.purple }} />
            Requiere garantía de OFERTA para licitar (desmarcar si es adjudicación directa, sin licitación previa)
          </label>
        </div>
      )}
      {!esEdicion && (
        <div style={{ marginTop: 10, fontSize: 11, color: '#8A5200', background: '#FFF8ED', padding: '6px 9px', borderRadius: 8 }}>
          {requiereGarantiaOferta
            ? '📋 Como requiere garantía de oferta, la obra arranca en etapa "oferta" — no va a aparecer en gastos, finanzas ni en el resto de la app hasta que se le cargue esa garantía y se la marque "adjudicada" desde Seguros.'
            : requierePoliza
              ? '🏗️ No requiere garantía de oferta (adjudicación directa), así que arranca directo en ejecución y ya aparece en gastos y finanzas. Igual vas a poder cargarle otras pólizas (Responsabilidad Civil, seguro de obra, etc.) desde Seguros cuando corresponda.'
              : '🏗️ Como no requiere garantías, la obra arranca directo en ejecución y ya aparece en gastos y finanzas.'}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.textMuted, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!form.excluir_gastos_generales} onChange={e => set('excluir_gastos_generales', e.target.checked)} style={{ accentColor: C.purple }} />
          No participa de los gastos generales de la empresa (queda afuera del prorrateo de combustible/servicios/legal/oficina — ni aporta peso ni recibe parte)
        </label>
      </div>
    </ModalInterno>
  )
}
