import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { supabase } from './supabaseClient'
import GestorObras from './GestorObras'
import Login from './Login'

async function cargarPerfil(userId) {
  const { data } = await supabase
    .from('usuarios')
    .select('*')
    .eq('id', userId)
    .single()
  return data
}

function App() {
  const [usuario, setUsuario] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Verificar sesión activa al cargar
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user) {
        const perfil = await cargarPerfil(session.user.id)
        setUsuario({ ...session.user, perfil })
      }
      setLoading(false)
    })

    // Escuchar cambios de sesión (login / logout)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        const perfil = await cargarPerfil(session.user.id)
        setUsuario({ ...session.user, perfil })
      }
      if (event === 'SIGNED_OUT') {
        setUsuario(null)
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F7F7' }}>
      <div style={{ width: 28, height: 28, border: '2px solid #EBEBEB', borderTopColor: '#7B4DB5', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
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
