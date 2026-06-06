/**
 * toast(mensaje, tipo)
 * Muestra una notificación flotante sin dependencias externas.
 * tipo: 'error' | 'ok' | 'info'  (default: 'error')
 *
 * Uso: import { toast } from './toast'
 *      toast('El nombre es obligatorio')
 *      toast('Guardado correctamente', 'ok')
 */
export function toast(mensaje, tipo = 'error') {
  const colores = {
    error: { bg: '#FFF0F0', border: '#FFDCDC', text: '#D0021B' },
    ok:    { bg: '#EDFAF3', border: '#B8EDD4', text: '#1A6B3C' },
    info:  { bg: '#F3F0FF', border: '#D0BFFF', text: '#5B2D8E' },
  }
  const { bg, border, text } = colores[tipo] ?? colores.error

  const el = document.createElement('div')
  el.textContent = mensaje
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '88px',        // por encima de la tab bar mobile
    left: '50%',
    transform: 'translateX(-50%) translateY(12px)',
    background: bg,
    border: `1px solid ${border}`,
    color: text,
    borderRadius: '12px',
    padding: '11px 18px',
    fontSize: '13px',
    fontFamily: "'Outfit', sans-serif",
    fontWeight: '500',
    boxShadow: '0 4px 20px rgba(0,0,0,0.10)',
    zIndex: '99999',
    whiteSpace: 'nowrap',
    maxWidth: 'calc(100vw - 40px)',
    textOverflow: 'ellipsis',
    overflow: 'hidden',
    opacity: '0',
    transition: 'opacity 0.2s, transform 0.2s',
    pointerEvents: 'none',
  })

  document.body.appendChild(el)

  // Animar entrada
  requestAnimationFrame(() => {
    el.style.opacity = '1'
    el.style.transform = 'translateX(-50%) translateY(0)'
  })

  // Animar salida y remover
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transform = 'translateX(-50%) translateY(8px)'
    setTimeout(() => el.remove(), 200)
  }, 3000)
}

// Exponer globalmente para uso en callbacks inline del JSX
window._toast = toast
