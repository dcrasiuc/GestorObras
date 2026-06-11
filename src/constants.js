// ── Paleta de colores ────────────────────────────────────────
export const C = {
  bg: '#F7F7F7', surface: '#FFFFFF', border: '#EBEBEB', borderFaint: '#F5F5F5',
  purple: '#7B4DB5', purpleLight: '#9B6DD5', purpleDark: '#5B2D8E', purpleDim: '#F3F0FF',
  text: '#1A1A1A', textMuted: '#888888', textFaint: '#CDCDCD',
  green: '#1A6B3C', greenDim: '#EDFAF3',
  orange: '#8A5200', orangeDim: '#FFF8ED',
}

// ── Medios de pago ───────────────────────────────────────────
export const MEDIOS_PAGO = [
  { value: 'transferencia', label: 'Transferencia bancaria' },
  { value: 'cheque',        label: 'Cheque' },
  { value: 'efectivo',      label: 'Efectivo' },
  { value: 'tarjeta',       label: 'Tarjeta' },
]

// ── Tipos de comprobante ─────────────────────────────────────
export const TIPOS_COMPROBANTE = [
  { value: 'factura_a',       label: 'Factura A',        iva: true  },
  { value: 'factura_b',       label: 'Factura B',        iva: false },
  { value: 'factura_c',       label: 'Factura C',        iva: false },
  { value: 'recibo',          label: 'Recibo',           iva: false },
  { value: 'ticket',          label: 'Ticket',           iva: false },
  { value: 'sin_comprobante', label: 'Sin comprobante',  iva: false },
  { value: 'otro',            label: 'Otro',             iva: false },
]

// ── Situaciones impositivas ──────────────────────────────────
export const SITUACIONES = [
  { value: 'responsable_inscripto', label: 'Responsable Inscripto', comprobante: 'factura_a', iva: true  },
  { value: 'monotributo',           label: 'Monotributo',           comprobante: 'factura_c', iva: false },
  { value: 'exento',                label: 'Exento',                comprobante: 'factura_b', iva: false },
  { value: 'consumidor_final',      label: 'Consumidor Final',      comprobante: 'ticket',    iva: false },
]

// ── Conceptos de gasto ───────────────────────────────────────
export const CONCEPTOS = ['materiales', 'mano-obra', 'equipos', 'subcontratos', 'varios']

export const CONCEPTO_LABELS = {
  materiales:    'Materiales',
  'mano-obra':   'Mano de obra',
  equipos:       'Equipos',
  subcontratos:  'Subcontratos',
  varios:        'Varios',
}

export const CONCEPTO_COLORS = {
  materiales:   ['#F3F0FF', '#6B3FA0'],
  'mano-obra':  ['#EDFAF3', '#1A6B3C'],
  equipos:      ['#FFF8ED', '#8A5200'],
  subcontratos: ['#EDF3FF', '#1A3F8A'],
  varios:       ['#F3F3F3', '#666666'],
}

export const CONCEPTO_ICONS = {
  materiales:   '🔧',
  'mano-obra':  '👷',
  equipos:      '🚜',
  subcontratos: '🏢',
  varios:       '📦',
}

// ── Rubros de proveedor ──────────────────────────────────────
export const RUBROS = [
  'Materiales de construcción',
  'Ferretería',
  'Electricidad',
  'Plomería / Sanitaria',
  'Pintura',
  'Carpintería / Aberturas',
  'Vidriería',
  'Equipos y maquinaria',
  'Transporte / Logística',
  'Mano de obra',
  'Profesionales / Estudios',
  'Hormigón / Premoldeados',
  'Hierro / Acero',
  'Cerámicos / Revestimientos',
  'Varios',
]

// ── IVA ──────────────────────────────────────────────────────
export const IVA = 0.21
