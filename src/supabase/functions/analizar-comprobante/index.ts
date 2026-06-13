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
    const body = await req.json()

    // ── Modo DB Write: proxy de escrituras para mobile ────────
    // El mobile no puede hacer POST directo a Supabase REST, pero sí a esta función
    if (body.table) {
      const { table, method, payload, filter, returning } = body
      const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!
      const authHeader = req.headers.get('Authorization') || `Bearer ${anonKey}`

      let url = `${supabaseUrl}/rest/v1/${table}`
      if (filter) url += `?${filter}`

      const dbBody = payload != null
        ? JSON.stringify(method === 'PATCH' ? payload : (Array.isArray(payload) ? payload : [payload]))
        : undefined

      const dbResp = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'apikey': anonKey,
          'Authorization': authHeader,
          'Prefer': returning ? 'return=representation' : 'return=minimal',
        },
        body: dbBody,
      })

      if (!dbResp.ok) {
        let msg = `HTTP ${dbResp.status}`
        try { const e = await dbResp.json(); msg = e.message || e.hint || e.details || msg } catch {}
        return new Response(JSON.stringify({ error: msg }), {
          status: dbResp.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      if (returning) {
        const rows = await dbResp.json()
        const row = Array.isArray(rows) ? rows[0] : rows
        return new Response(JSON.stringify({ data: row }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Modo IA: análisis de comprobante ──────────────────────
    const { base64, mimeType, hoy } = body
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')

    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY no configurada')
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY no configurada' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      })
    }

    console.log('Llamando Anthropic, mimeType:', mimeType, 'base64 length:', base64?.length)

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: `Extraés datos de comprobantes para una app de gestión de obras de construcción. Respondé SOLO con JSON válido sin texto extra ni backticks. Campos: fecha (YYYY-MM-DD, si no hay usá ${hoy}), proveedor (nombre del emisor), cuit (CUIT o CUIL del emisor tal como aparece en el documento — solo dígitos sin guiones, ej: "20123456789", null si no se ve), nro_comprobante (número tal como aparece en el documento, ej: "0001-00012345", null si no se ve), tipo_comprobante (mirá el encabezado del documento y respondé: "factura_a" si dice FACTURA A o Tipo A, "factura_b" si dice FACTURA B o Tipo B, "factura_c" si dice FACTURA C o Tipo C, "recibo" si dice RECIBO, "ticket" si dice TICKET o TIQUE, null si no podés determinarlo con certeza), concepto (uno de: materiales, mano-obra, equipos, subcontratos, varios — inferilo del contenido), monto (número total del comprobante sin símbolo de moneda), descripcion (1 frase breve del contenido).`,
        messages: [{
          role: 'user',
          content: [
            mimeType === 'application/pdf'
              ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
              : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: 'Extraé los datos del comprobante.' }
          ]
        }]
      })
    })

    const data = await resp.json()
    console.log('Anthropic status:', resp.status, 'response type:', data?.type)

    if (!resp.ok || data?.type === 'error') {
      console.error('Anthropic error:', JSON.stringify(data?.error))
      return new Response(JSON.stringify({ error: data?.error?.message || 'Error Anthropic', detail: data }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 502,
      })
    }

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Exception:', error.message)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
