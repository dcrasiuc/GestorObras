import { useState } from 'react'
import { supabase } from './supabaseClient'

const C = {
  bg: '#F7F7F7', surface: '#FFFFFF', border: '#EBEBEB',
  purple: '#7B4DB5', purpleDim: '#F3F0FF',
  text: '#1A1A1A', textMuted: '#888888', textFaint: '#CDCDCD',
}

export default function Login() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loginGoogle = async () => {
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
        queryParams: { access_type: 'offline', prompt: 'select_account' },
      },
    })
    if (error) { setError('No se pudo iniciar sesión con Google'); setLoading(false) }
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Outfit', sans-serif !important; background: #F7F7F7; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .google-btn { transition: all 0.15s; }
        .google-btn:hover { background: #f5f0ff !important; border-color: #C4A8E8 !important; }
        .google-btn:active { transform: scale(0.98); }
      `}</style>

      <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: "'Outfit', sans-serif" }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 20, padding: '40px 36px', width: '100%', maxWidth: 360, animation: 'fadeUp 0.3s ease', boxShadow: '0 8px 40px rgba(123,77,181,0.1)' }}>

          {/* Logo */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 32 }}>
            <div style={{ width: 56, height: 56, background: C.purple, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14, boxShadow: '0 8px 24px rgba(123,77,181,0.3)' }}>
              <svg width="32" height="32" viewBox="0 0 100 100" fill="none">
                <polygon points="50,4 93,27.5 93,72.5 50,96 7,72.5 7,27.5" fill="none" stroke="#fff" strokeWidth="10"/>
                <polygon points="50,24 74,37 74,63 50,76 26,63 26,37" fill="none" stroke="#fff" strokeWidth="7"/>
                <line x1="50" y1="24" x2="50" y2="76" stroke="#fff" strokeWidth="5" opacity=".4"/>
                <line x1="26" y1="37" x2="74" y2="37" stroke="#fff" strokeWidth="5" opacity=".4"/>
              </svg>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.text, letterSpacing: '0.04em' }}>SEATE</div>
            <div style={{ fontSize: 11, color: C.textFaint, letterSpacing: '0.12em', marginTop: 2 }}>CONSTRUCCIONES · OBRAS</div>
          </div>

          <h2 style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 6, textAlign: 'center' }}>Bienvenido</h2>
          <p style={{ fontSize: 13, color: C.textMuted, marginBottom: 28, textAlign: 'center', lineHeight: 1.5 }}>
            Ingresá con tu cuenta de Google para continuar
          </p>

          {error && (
            <div style={{ background: '#FFF0F0', border: '1px solid #FFDCDC', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#D0021B', marginBottom: 16, textAlign: 'center' }}>{error}</div>
          )}

          <button className="google-btn" onClick={loginGoogle} disabled={loading} style={{ width: '100%', padding: '13px 16px', background: C.surface, color: C.text, border: `1.5px solid ${C.border}`, borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: "'Outfit', sans-serif", display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, opacity: loading ? 0.7 : 1 }}>
            {loading ? (
              <div style={{ width: 20, height: 20, border: '2px solid #EBEBEB', borderTopColor: C.purple, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            ) : (
              <svg width="20" height="20" viewBox="0 0 48 48">
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              </svg>
            )}
            {loading ? 'Redirigiendo...' : 'Continuar con Google'}
          </button>

          <p style={{ fontSize: 11, color: C.textFaint, textAlign: 'center', marginTop: 20, lineHeight: 1.6 }}>
            Solo cuentas autorizadas por SEATE pueden acceder
          </p>
        </div>
      </div>
    </>
  )
}
