import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { supabase } from './supabaseClient'
import GestorObras from './GestorObras'
import Login from './Login'

async function cargarPerfil(userId) {
  const { data } = await supabase.from('usuarios').select('*').eq('id', userId).single()
  return data
}

function App() {
  const [usuario, setUsuario] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Carga inicial: obtener sesión existente sin timeout agresivo
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user) {
        const perfil = await cargarPerfil(session.user.id)
        setUsuario({ ...session.user, perfil })
      }
      setLoading(false)
    })

    // onAuthStateChange maneja todos los cambios de estado:
    // login, logout y renovación de token — es la fuente de verdad
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        const perfil = await cargarPerfil(session.user.id)
        setUsuario({ ...session.user, perfil })
        setLoading(false)
      }
      if (event === 'SIGNED_OUT') {
        setUsuario(null)
        setLoading(false)
      }
      if (event === 'TOKEN_REFRESHED' && session?.user) {
        const perfil = await cargarPerfil(session.user.id)
        setUsuario(u => ({ ...u, perfil }))
      }
    })

    return () => subscription.unsubscribe()
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
  return <GestorObras usuario={usuario} />
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
)
