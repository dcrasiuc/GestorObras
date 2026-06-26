import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { supabase } from './supabaseClient'
import GestorObras from './GestorObras'
import Login from './Login'

async function cargarPerfil(userId) {
  // maybeSingle: data=null cuando NO hay fila (usuario sin aprobar).
  // Si hay error de red/consulta, devolvemos undefined para NO bloquear a un usuario ya aprobado.
  const { data, error } = await supabase.from('usuarios').select('*').eq('id', userId).maybeSingle()
  if (error) return undefined
  return data
}

function Pendiente({ email, onSalir }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F7F7', padding: 20 }}>
      <div style={{ maxWidth: 380, textAlign: 'center', background: '#fff', border: '1px solid #EBEBEB', borderRadius: 16, padding: '32px 28px', boxShadow: '0 8px 40px rgba(0,0,0,0.06)' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>⏳</div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1A1A1A', margin: '0 0 8px', fontFamily: "'Outfit', sans-serif" }}>Cuenta pendiente de aprobación</h2>
        <p style={{ fontSize: 13, color: '#888', lineHeight: 1.5, margin: '0 0 20px', fontFamily: "'Outfit', sans-serif" }}>
          Tu cuenta ({email}) ya está creada y espera que un administrador la apruebe. Cuando te habiliten vas a poder ingresar.
        </p>
        <button onClick={onSalir} style={{ padding: '10px 20px', background: '#7B4DB5', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>Cerrar sesión</button>
      </div>
    </div>
  )
}

function App() {
  const [usuario, setUsuario] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Failsafe: si el auth se cuelga (mobile/red lenta), liberar spinner después de 10s
    const failsafe = setTimeout(() => setLoading(false), 10000)

    const resolver = (session) => async () => {
      clearTimeout(failsafe)
      if (session?.user) {
        console.log('[AUTH] cargarPerfil para', session.user.id)
        const perfil = await cargarPerfil(session.user.id).catch((e) => { console.error('[AUTH] cargarPerfil error:', e); return undefined })
        console.log('[AUTH] perfil resultado:', perfil)
        setUsuario({ ...session.user, perfil })
      } else {
        console.log('[AUTH] sin usuario en sesión, mostrando Login')
      }
      setLoading(false)
    }

    // onAuthStateChange es la fuente de verdad. INITIAL_SESSION es el primer evento
    // que dispara Supabase v2 (incluso después de un redirect OAuth de Google).
    // No usar getSession() como fuente principal porque puede resolver antes de que
    // el intercambio de código PKCE (OAuth redirect) complete, mostrando Login prematuramente.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('[AUTH EVENT]', event, 'user:', session?.user?.id ?? 'null')
      if (event === 'INITIAL_SESSION') {
        await resolver(session)()
        return
      }
      if (event === 'SIGNED_IN' && session?.user) {
        // Limpiar params de URL después del redirect OAuth
        if (window.location.hash || window.location.search.includes('code=')) {
          window.history.replaceState({}, '', window.location.pathname)
        }
        const perfil = await cargarPerfil(session.user.id).catch(() => undefined)
        setUsuario({ ...session.user, perfil })
        setLoading(false)
      }
      if (event === 'SIGNED_OUT') {
        setUsuario(null)
        setLoading(false)
      }
      if (event === 'TOKEN_REFRESHED' && session?.user) {
        const perfil = await cargarPerfil(session.user.id).catch(() => undefined)
        setUsuario(u => ({ ...u, perfil }))
      }
    })

    return () => { subscription.unsubscribe(); clearTimeout(failsafe) }
  }, [])

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F7F7' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{ width: 48, height: 48, background: '#7B4DB5', borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 24px rgba(123,77,181,0.3)' }}>
          <svg width="28" height="28" viewBox="0 0 100 100" fill="none">
            <polygon points="50,4 93,27.5 93,72.5 50,96 7,72.5 7,27.5" fill="none" stroke="#fff" strokeWidth="10"/>
            <polygon points="50,24 74,37 74,63 50,76 26,63 26,37" fill="none" stroke="#fff" strokeWidth="7"/>
            <line x1="50" y1="24" x2="50" y2="76" stroke="#fff" strokeWidth="5" opacity=".4"/>
            <line x1="26" y1="37" x2="74" y2="37" stroke="#fff" strokeWidth="5" opacity=".4"/>
          </svg>
        </div>
        <div style={{ width: 24, height: 24, border: '2px solid #EBEBEB', borderTopColor: '#7B4DB5', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )

  if (!usuario) return <Login />
  // perfil === null → autenticado pero sin aprobar. (undefined = error de red, lo dejamos pasar)
  if (usuario.perfil === null) return <Pendiente email={usuario.email} onSalir={() => { localStorage.removeItem('seate-auth'); supabase.auth.signOut({ scope: 'local' }).catch(() => {}); setUsuario(null) }} />
  return <GestorObras usuario={usuario} />
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
)
