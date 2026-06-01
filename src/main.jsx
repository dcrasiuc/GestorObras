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
  const [accesoDenegado, setAccesoDenegado] = useState(false)

  const verificarSesion = async () => {
    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      const sesion = supabase.auth.getSession().then(async ({ data: { session } }) => {
        if (session?.user) {
          const perfil = await cargarPerfil(session.user.id)
          // WHITELIST: si no tiene perfil en la tabla usuarios, denegar acceso
          if (!perfil) {
            await supabase.auth.signOut()
            setAccesoDenegado(true)
            setUsuario(null)
          } else {
            setAccesoDenegado(false)
            setUsuario({ ...session.user, perfil })
          }
        } else {
          setUsuario(null)
        }
      })
      await Promise.race([sesion, timeout])
    } catch {
      setUsuario(null)
    }
    setLoading(false)
  }

  useEffect(() => {
    verificarSesion()

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        const perfil = await cargarPerfil(session.user.id)
        if (!perfil) {
          await supabase.auth.signOut()
          setAccesoDenegado(true)
          setUsuario(null)
        } else {
          setAccesoDenegado(false)
          setUsuario({ ...session.user, perfil })
        }
        setLoading(false)
      }
      if (event === 'SIGNED_OUT') {
        setUsuario(null)
        setAccesoDenegado(false)
        setLoading(false)
      }
      if (event === 'TOKEN_REFRESHED' && session?.user) {
        const perfil = await cargarPerfil(session.user.id)
        if (perfil) setUsuario(u => ({ ...u, perfil }))
      }
    })

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') verificarSesion()
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      subscription.unsubscribe()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F7F7' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{ width: 48, height: 48, background: '#7B4DB5', borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 24px rgba(123,77,181,0.3)' }}>
          <svg width="28" height="28" viewBox="0 0 100 100" fill="none">
            <polygon points="50,4 93,27.5 93,72.5 50,96 7,72.5 7,27.5" fill="none" stroke="#fff" strokeWidth="10"/>
            <polygon points="50,24 74,37 74,63 50,76 26,63 26,37" fill="none" stroke="#fff" strokeWidth="7"/>
          </svg>
        </div>
        <div style={{ width: 24, height: 24, border: '2px solid #EBEBEB', borderTopColor: '#7B4DB5', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )

  // Acceso denegado — cuenta Google no autorizada
  if (accesoDenegado) return (
    <div style={{ minHeight: '100vh', background: '#F7F7F7', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: "'Outfit', sans-serif" }}>
      <div style={{ background: '#fff', border: '1px solid #EBEBEB', borderRadius: 20, padding: '40px 36px', maxWidth: 360, width: '100%', textAlign: 'center', boxShadow: '0 8px 40px rgba(0,0,0,0.08)' }}>
        <div style={{ width: 56, height: 56, background: '#FFF0F0', borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: 28 }}>🚫</div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1A1A1A', margin: '0 0 10px' }}>Acceso no autorizado</h2>
        <p style={{ fontSize: 13, color: '#888', lineHeight: 1.6, margin: '0 0 24px' }}>
          Tu cuenta de Google no tiene acceso a esta aplicación. Contactá al administrador de SEATE para solicitar acceso.
        </p>
        <button onClick={() => { setAccesoDenegado(false) }} style={{ padding: '10px 24px', background: '#7B4DB5', color: '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>
          Volver al inicio
        </button>
      </div>
    </div>
  )

  if (!usuario) return <Login />
  return <GestorObras usuario={usuario} />
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
)
