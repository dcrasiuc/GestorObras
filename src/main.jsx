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

  const verificarSesion = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.user) {
      const perfil = await cargarPerfil(session.user.id)
      setUsuario({ ...session.user, perfil })
    } else {
      setUsuario(null)
    }
    setLoading(false)
  }

  useEffect(() => {
    // Verificar sesión al cargar
    verificarSesion()

    // Escuchar cambios de sesión (login / logout)
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
        setUsuario({ ...session.user, perfil })
      }
    })

    // Cuando la app vuelve al foco (mobile browser resume)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        verificarSesion()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      subscription.unsubscribe()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F7F7' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{ width: 32, height: 32, background: '#7B4DB5', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="18" height="18" viewBox="0 0 100 100" fill="none">
            <polygon points="50,4 93,27.5 93,72.5 50,96 7,72.5 7,27.5" fill="none" stroke="#fff" strokeWidth="11"/>
            <polygon points="50,24 74,37 74,63 50,76 26,63 26,37" fill="none" stroke="#fff" strokeWidth="8"/>
          </svg>
        </div>
        <div style={{ width: 24, height: 24, border: '2px solid #EBEBEB', borderTopColor: '#7B4DB5', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  )

  if (!usuario) return <Login onLogin={setUsuario} />

  return <GestorObras usuario={usuario} />
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
