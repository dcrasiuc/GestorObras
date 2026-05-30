import { useState } from 'react'
import { supabase } from './supabaseClient'

const C = {
  bg: '#F7F7F7', surface: '#FFFFFF', border: '#EBEBEB',
  purple: '#7B4DB5', purpleDim: '#F3F0FF',
  text: '#1A1A1A', textMuted: '#888888', textFaint: '#CDCDCD',
}

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError('Email o contraseña incorrectos')
      setLoading(false)
      return
    }
    // Obtener perfil y rol
    const { data: perfil } = await supabase
      .from('usuarios')
      .select('*')
      .eq('id', data.user.id)
      .single()
    onLogin({ ...data.user, perfil })
    setLoading(false)
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Outfit', sans-serif !important; background: ${C.bg}; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
      `}</style>
      <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: "'Outfit', sans-serif" }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: '40px 36px', width: '100%', maxWidth: 380, animation: 'fadeUp 0.3s ease', boxShadow: '0 8px 40px rgba(0,0,0,0.08)' }}>

          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 32 }}>
            <div style={{ width: 36, height: 36, background: C.purple, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="20" height="20" viewBox="0 0 100 100" fill="none">
                <polygon points="50,4 93,27.5 93,72.5 50,96 7,72.5 7,27.5" fill="none" stroke="#fff" strokeWidth="11"/>
                <polygon points="50,24 74,37 74,63 50,76 26,63 26,37" fill="none" stroke="#fff" strokeWidth="8"/>
                <line x1="50" y1="24" x2="50" y2="76" stroke="#fff" strokeWidth="5" opacity=".4"/>
                <line x1="26" y1="37" x2="74" y2="37" stroke="#fff" strokeWidth="5" opacity=".4"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, letterSpacing: '0.06em' }}>SEATE</div>
              <div style={{ fontSize: 9, color: C.textFaint, letterSpacing: '0.1em' }}>CONSTRUCCIONES · OBRAS</div>
            </div>
          </div>

          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 6 }}>Iniciar sesión</h2>
          <p style={{ fontSize: 13, color: C.textMuted, marginBottom: 28 }}>Ingresá con tu cuenta de SEATE</p>

          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: 14 }}>
              <label style={labelSt}>Email</label>
              <input style={inputSt} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="tu@email.com" required />
            </div>
            <div style={{ marginBottom: 24 }}>
              <label style={labelSt}>Contraseña</label>
              <input style={inputSt} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
            </div>

            {error && (
              <div style={{ background: '#FFF0F0', border: '1px solid #FFDCDC', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#D0021B', marginBottom: 16 }}>
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} style={{ width: '100%', padding: '10px', background: loading ? C.textFaint : C.purple, color: '#fff', border: 'none', borderRadius: 9, fontSize: 14, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: "'Outfit', sans-serif", transition: 'background 0.15s' }}>
              {loading ? 'Ingresando...' : 'Ingresar'}
            </button>
          </form>
        </div>
      </div>
    </>
  )
}

const labelSt = { fontSize: 10, fontWeight: 600, color: '#CDCDCD', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }
const inputSt = { width: '100%', padding: '9px 12px', fontSize: 13, fontFamily: "'Outfit', sans-serif", border: '1px solid #EBEBEB', borderRadius: 8, background: '#FFFFFF', color: '#1A1A1A', boxSizing: 'border-box', outline: 'none', colorScheme: 'light' }
