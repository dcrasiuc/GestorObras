import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { table, method, payload, filter, returning } = await req.json()

    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const authHeader = req.headers.get('Authorization') || `Bearer ${anonKey}`

    // Proxy server-side a Supabase REST (evita que el mobile hable directo con Supabase)
    let url = `${supabaseUrl}/rest/v1/${table}`
    if (filter) url += `?${filter}`

    const body = payload != null
      ? JSON.stringify(method === 'PATCH' ? payload : (Array.isArray(payload) ? payload : [payload]))
      : undefined

    const resp = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
        'Authorization': authHeader,
        'Prefer': returning ? 'return=representation' : 'return=minimal',
      },
      body,
    })

    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`
      try { const e = await resp.json(); msg = e.message || e.hint || e.details || msg } catch {}
      return new Response(JSON.stringify({ error: msg }), {
        status: resp.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (returning) {
      const rows = await resp.json()
      const row = Array.isArray(rows) ? rows[0] : rows
      return new Response(JSON.stringify({ data: row }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('db-write error:', error.message)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
