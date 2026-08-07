import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Prompts de extracción por tipo de documento analizado
const PROMPTS = {
  comprobante: (hoy: string) =>
    `Extraés datos de comprobantes para una app de gestión de obras de construcción. Respondé SOLO con JSON válido sin texto extra ni backticks. Campos: fecha (YYYY-MM-DD, si no hay usá ${hoy}), proveedor (nombre del emisor), cuit (CUIT o CUIL del emisor tal como aparece en el documento — solo dígitos sin guiones, ej: "20123456789", null si no se ve), receptor (nombre o razón social del CLIENTE/comprador a quien se emite el comprobante, null si no se ve), cuit_receptor (CUIT del CLIENTE/comprador/receptor — solo dígitos sin guiones, null si no se ve), nro_comprobante (número tal como aparece en el documento, ej: "0001-00012345", null si no se ve), tipo_comprobante (mirá el encabezado del documento y respondé: "factura_a" si dice FACTURA A o Tipo A, "factura_b" si dice FACTURA B o Tipo B, "factura_c" si dice FACTURA C o Tipo C, "recibo" si dice RECIBO, "ticket" si dice TICKET o TIQUE, null si no podés determinarlo con certeza), concepto (uno de: materiales, mano-obra, equipos, subcontratos, varios — inferilo del contenido), monto (número total del comprobante sin símbolo de moneda), iva_monto (importe de IVA discriminado en el comprobante, solo el número sin símbolo, null si no está discriminado), descripcion (1 frase breve del contenido).`,

  poliza: (hoy: string) =>
    `Sos un EXPERTO EN SEGUROS DE CAUCIÓN Y GARANTÍAS DE OBRA PÚBLICA, analizando pólizas para una empresa constructora (SEATE S.R.L.). Leé la carátula del documento con criterio profesional — no solo copiés texto, INTERPRETÁ el tipo de garantía y sus condiciones. Respondé SOLO con JSON válido sin texto extra ni backticks. Campos:

aseguradora (nombre de la COMPAÑÍA ASEGURADORA que emite la póliza, ej: "Berkley Argentina Seguros", null si no se ve).
corredor (nombre del CORREDOR o PRODUCTOR de seguros/broker que intermedió — persona o empresa DISTINTA de la aseguradora, suele figurar como "Productor", "Corredor" u "Organizador", null si no figura).
nro_poliza (número de póliza tal como aparece, incluyendo el número de endoso si corresponde, ej: "356622" o "356622/3", null si no se ve).
tiene_endoso (true si el documento es o menciona explícitamente un endoso/modificación de una póliza existente, false si es la póliza original).
tipo_cobertura (analizá el OBJETO ESPECÍFICO del seguro —no te guíes solo por el nombre genérico— y respondé exactamente uno de: "mantenimiento_oferta" = garantía de mantenimiento de oferta en una licitación; "ejecucion_contrato" = garantía de CUMPLIMIENTO de contrato (garantiza que el contratista ejecute la obra conforme al contrato, típicamente ~5-10% del monto contractual, no se amortiza); "anticipo_financiero" = garantía que devuelve al organismo el ANTICIPO/adelanto financiero o contractual entregado al contratista — es una garantía DISTINTA de la de cumplimiento aunque ambas sean seguros de caución de la misma obra: el objeto es "garantizar la devolución del anticipo", el monto suele coincidir con el anticipo otorgado, y se va reduciendo/amortizando a medida que se descuenta de los certificados de obra (no espera a la recepción de obra como la de cumplimiento) — buscá en el texto palabras como "anticipo financiero", "anticipo contractual" o "anticipo de fondos"; "fondo_reparo" = garantía de fondo de reparo (posterior a la recepción); "responsabilidad_civil" = RC; "otro" si no es claro.
tipo_vigencia (como experto, determiná: "unica_vez" si la garantía es válida hasta que se cumpla un HITO de la obra —adjudicación, amortización del anticipo, recepción provisoria o definitiva— y no se renueva por el mero paso del tiempo (típico en mantenimiento_oferta, ejecucion_contrato, anticipo_financiero, fondo_reparo); "renovable" si el documento fija una vigencia por un PERÍODO FIJO —ej. 12 meses— que vence y debe renovarse periódicamente sin relación a un hito de obra (típico en responsabilidad_civil). Si no podés determinarlo, usá null).
requiere_final_obra (boolean — como experto: true si para cancelar/dar de baja esta garantía hace falta presentarle a la aseguradora el acta de recepción de obra (provisoria o definitiva) firmada por el organismo — esto aplica típicamente a ejecucion_contrato y fondo_reparo; false si la baja NO depende de un acta de recepción de obra — por ejemplo responsabilidad_civil que se da de baja por vencimiento de plazo, mantenimiento_oferta que se da de baja al adjudicarse el contrato, o anticipo_financiero que se reduce/cancela a medida que se amortiza contra los certificados de obra (un proceso administrativo aparte, no ligado a la recepción). Si no podés determinarlo, usá null).
clausula_repeticion (OJO: en un seguro de caución —mantenimiento_oferta, ejecucion_contrato, anticipo_financiero, fondo_reparo— la aseguradora SIEMPRE conserva el derecho de repetir contra el tomador/asegurado (SEATE): así funciona la caución, si la aseguradora le paga al organismo después le cobra a SEATE, respaldada por la contragarantía firmada. Eso NO es lo que hay que buscar. Lo relevante es si el documento menciona una RENUNCIA a repetir contra el ORGANISMO/COMITENTE o contra un tercero nombrado —típicamente en pólizas de responsabilidad_civil, frases como "sin derecho de repetición contra el comitente/organismo/terceros vinculados a la obra": "sin_repeticion" si encontrás esa renuncia explícita a favor del organismo/comitente/tercero, "con_repeticion" si el texto aclara explícitamente que no hay tal renuncia, "no_especifica" si el documento no lo menciona o no podés determinarlo).
clausulas_especiales (texto breve resumiendo cualquier cláusula especial relevante que veas en el documento — ajuste por inflación, franquicias, exclusiones, condiciones particulares — null si no notás ninguna cláusula especial destacable).
se_autorenueva (boolean — MUY IMPORTANTE, muchas cauciones "unica_vez" en realidad NO son indefinidas: la aseguradora las emite por PERÍODOS FIJOS CORTOS —ej. "reajustable trimestralmente", "vigencia trimestral", "válida por 90/180 días"— y si se cumple el período sin que se le presente la recepción de obra, la RENUEVA SOLA y cobra una prima nueva por el siguiente período; esto se corta recién cuando se presenta la recepción. Este mecanismo SOLO aplica a garantías atadas a un hito de obra —ejecucion_contrato, anticipo_financiero, fondo_reparo—: si tipo_cobertura es "mantenimiento_oferta" (a fecha fija ligada a la apertura de la licitación, no hay recepción que la corte) o "responsabilidad_civil" (renovable anual común, no un caución atado a un hito), respondé SIEMPRE false, sin importar lo que diga el texto. Para ejecucion_contrato/anticipo_financiero/fondo_reparo: poné true si el documento menciona reajuste/renovación periódica —trimestral, semestral, cuatrimestral, etc.— aunque la garantía sea nominalmente "hasta la recepción"; false si es un plazo fijo único sin renovación automática; null si no podés determinarlo).
duracion_periodo_dias (número entero — si se_autorenueva es true, la duración de cada período en días: "trimestral"/"trimestre" = 90, "cuatrimestral" = 120, "semestral" = 180, "anual" = 365, o el número exacto de días si el documento lo indica. null si se_autorenueva no es true o no se puede determinar).
descripcion_ia (una descripción de 1 a 2 oraciones en español, como la escribiría un experto en seguros, resumiendo: aseguradora, corredor (si tiene), tipo de garantía EXACTO (distinguí bien cumplimiento de contrato vs. anticipo financiero), a qué obra/organismo corresponde, vigencia, y la cláusula de repetición si la hay. Ej: "Garantía de Cumplimiento de Contrato emitida por Berkley International Seguros S.A. mediante el corredor Juan Pérez, vigente hasta la recepción definitiva de la obra." o, si es de RC con renuncia: "...sin derecho de repetición contra el comitente.").
tomador (nombre de la empresa tomadora/asegurada, ej: "SEATE S.R.L.", null si no se ve).
organismo (nombre del organismo público beneficiario/asegurado de la garantía, ej: "IPRODA", "Vialidad Provincial", "EBY", null si no se ve).
obra (nombre o descripción breve de la obra/licitación a la que corresponde la garantía, según figure en el documento, null si no se ve).
monto_asegurado (suma asegurada o monto garantizado, solo el número sin símbolo de moneda, null si no se ve).
prima (costo/prima de la póliza que cobra la aseguradora — IMPORTANTE, NUNCA inventes, estimes ni calcules este número: solo completalo si el documento tiene una etiqueta EXPLÍCITA como "PRIMA", "PREMIO" o "PREMIO TOTAL" seguida de un monto. Los seguros de caución muchas veces traen, en la línea del Productor/Corredor, un desglose de costos —"Gtos Explot.", "Gtos Adquis.", "Gtos Cobranza", "T.C.N."— que NO son necesariamente la prima cobrada al tomador; muchas aseguradoras facturan la prima aparte, en una factura o cuponera distinta de la carátula de la póliza. Si NO hay una etiqueta explícita de "PRIMA"/"PREMIO", dejá este campo en null aunque veas otros números de costos en el documento — es preferible null a un dato equivocado. Solo el número sin símbolo de moneda).
prima_fuente (string breve — de dónde sacaste el valor de "prima": copiá literalmente la etiqueta que viste en el documento junto al monto, ej. "PRIMA", "PREMIO TOTAL", "T.C.N." — así el usuario puede verificarlo. null si prima quedó en null).
fecha_emision (YYYY-MM-DD, fecha de emisión/aprobación de la póliza, si no hay usá ${hoy}).
fecha_inicio (YYYY-MM-DD, inicio de vigencia, null si no se ve).
fecha_vencimiento (YYYY-MM-DD, fin de vigencia/vencimiento — si tipo_vigencia es "unica_vez" y el documento no fija una fecha de vencimiento sino que depende de un hito de obra, dejalo null).`,
}

// Prompt para el modo "relevamiento" (equipo de especialistas técnicos que releva fotos + relato
// de un sector/ambiente y matchea contra el catálogo real de precios "Revista Cifras").
function promptRelevamiento(sector: string, relato: string, catalogoTexto: string) {
  return `Sos un EQUIPO DE ESPECIALISTAS TÉCNICOS EN CONSTRUCCIÓN (🚰 Especialista Sanitarista, 🏗️ Especialista en Cubiertas y Zinguería, 🪟 Especialista en Aberturas y Vidriería, ⚡ Especialista Electromecánico, 🧱 Especialista en Mampostería y Revoques, 🚜 Especialista en Obras Civiles y Cauces EBY) que releva escuelas y edificios públicos para SEATE S.R.L., una constructora de Posadas, Misiones.

Te paso fotos y/o un relato dictado por el técnico de UN sector/ambiente puntual ("${sector}"). Tenés que:
1. Elegir cuál de esas especialidades corresponde mejor a lo relevado (usá el título con emoji tal cual está arriba).
2. Identificar qué trabajos hacen falta a partir de las fotos y el relato.
3. Para cada trabajo, elegir el ítem MÁS PARECIDO del catálogo de precios "Revista Cifras" de abajo (formato codigo|rubro|descripcion|unidad) y estimar la cantidad en la unidad de ESE ítem.
4. Clasificar el riesgo de cada ítem: "urgente" (riesgo para alumnos/usuarios — vidrio roto, cableado expuesto, pérdida de agua activa, etc.), "funcional" (no urgente pero afecta el uso normal) o "mantenimiento" (estético/preventivo).
5. Marcar es_restauracion=true si el relato indica que se puede reparar/recuperar lo existente en vez de proveer algo nuevo (ej. "se puede volver a amurar", "se puede reparar").
6. Control de omisiones: si de las fotos notás que faltaría verificar algo típico de este tipo de sector y no fue mencionado en el relato (luces, llaves de paso, tomas, cielorraso, etc.), decilo en alertas_omision; si no notás nada para alertar, dejalo en null.

MUY IMPORTANTE sobre el catálogo — NUNCA INVENTES UN CÓDIGO: el campo codigo_item de cada ítem que devuelvas TIENE QUE SER un código que existe LITERALMENTE en la lista de abajo. Si no hay ningún ítem del catálogo que corresponda razonablemente a lo que ves, poné codigo_item en null y completá rubro/descripcion_item con tu propio texto libre describiendo el trabajo — es preferible null a un código inventado o adivinado.

Respondé SOLO con JSON válido sin texto extra ni backticks, con esta forma exacta:
{"especialista": "🚰 Especialista Sanitarista" (el título con emoji que corresponda), "mensaje_auditoria": "1-2 oraciones en español, tono técnico profesional, explicando qué identificaste y qué ítems aplicaste", "alertas_omision": "texto breve o null", "items": [{"codigo_item": "184" o null, "rubro": "...", "descripcion_item": "...", "unidad": "unid", "cantidad": 1, "riesgo": "urgente", "es_restauracion": false, "justificacion": "1 frase breve de por qué este ítem"}]}

Relato del técnico sobre "${sector}": ${relato?.trim() || '(sin relato escrito — basate solo en las fotos)'}

CATÁLOGO DE PRECIOS (Revista Cifras) — formato codigo|rubro|descripcion|unidad, uno por línea:
${catalogoTexto}`
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

    // ── Modo IA: análisis de comprobante, póliza o relevamiento ──
    const { base64, mimeType, hoy, tipoAnalisis } = body
    const modo = tipoAnalisis === 'poliza' ? 'poliza' : tipoAnalisis === 'relevamiento' ? 'relevamiento' : 'comprobante'
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')

    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY no configurada')
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY no configurada' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      })
    }

    // ── Modo "relevamiento": lee fotos ya subidas a Storage + relato, matchea contra
    // catalogo_cifras (traído server-side, nunca confiando en lo que "recuerde" el cliente) ──
    if (modo === 'relevamiento') {
      const { fotoUrls, relato, sector } = body
      const urls: string[] = Array.isArray(fotoUrls) ? fotoUrls.filter(Boolean) : []

      if (!relato?.trim() && urls.length === 0) {
        return new Response(JSON.stringify({ error: 'Se necesita al menos una foto o un relato.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        })
      }

      const supabaseUrl = Deno.env.get('SUPABASE_URL')!
      const restKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')!

      // Catálogo completo (234 ítems) — la IA solo puede elegir códigos de acá, nunca inventar uno.
      let catalogo: any[] = []
      try {
        const catResp = await fetch(`${supabaseUrl}/rest/v1/catalogo_cifras?select=codigo_item,rubro,descripcion,unidad,precio_material,precio_mano_obra,precio_unitario_total&order=codigo_item`, {
          headers: { 'apikey': restKey, 'Authorization': `Bearer ${restKey}` },
        })
        if (catResp.ok) catalogo = await catResp.json()
        else console.error('Error trayendo catalogo_cifras:', catResp.status, await catResp.text())
      } catch (e) {
        console.error('Excepción trayendo catalogo_cifras:', e.message)
      }
      const catalogoTexto = catalogo.map((c) => `${c.codigo_item}|${c.rubro}|${c.descripcion}|${c.unidad}`).join('\n')

      // Descargar cada foto (ya subida a Storage por el frontend) y pasarla a base64 para Claude Vision.
      const imagenesContent: any[] = []
      for (const url of urls.slice(0, 6)) {
        try {
          const imgResp = await fetch(url)
          if (!imgResp.ok) { console.error('No se pudo descargar foto:', url, imgResp.status); continue }
          const buf = new Uint8Array(await imgResp.arrayBuffer())
          let binary = ''
          for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i])
          const b64 = btoa(binary)
          const ct = (imgResp.headers.get('content-type') || 'image/jpeg').split(';')[0]
          imagenesContent.push({ type: 'image', source: { type: 'base64', media_type: ct, data: b64 } })
        } catch (e) {
          console.error('Excepción descargando foto:', url, e.message)
        }
      }

      const userContent: any[] = [
        ...imagenesContent,
        { type: 'text', text: `Analizá el sector "${sector}" con las fotos de arriba (si hay) y el relato del sistema.` },
      ]

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          system: promptRelevamiento(sector || '', relato || '', catalogoTexto),
          messages: [{ role: 'user', content: userContent }],
        }),
      })
      const data = await resp.json()
      console.log('Anthropic status (relevamiento):', resp.status, 'fotos:', imagenesContent.length, 'catalogo items:', catalogo.length)

      if (!resp.ok || data?.type === 'error') {
        console.error('Anthropic error (relevamiento):', JSON.stringify(data?.error))
        return new Response(JSON.stringify({ error: data?.error?.message || 'Error Anthropic' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 502,
        })
      }

      let parsed: any = null
      try {
        const textoRta = data?.content?.map((b: any) => b.text || '').join('') || ''
        parsed = JSON.parse(textoRta.replace(/```json|```/g, '').trim())
      } catch (e) {
        console.error('No se pudo parsear JSON de Claude (relevamiento):', e.message)
        return new Response(JSON.stringify({ error: 'La IA no devolvió un JSON válido — probá de nuevo.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 502,
        })
      }

      // Completa el precio real del catálogo — nunca confiar en un precio que "recuerde" el modelo.
      const catalogoPorCodigo = new Map(catalogo.map((c) => [String(c.codigo_item), c]))
      const items = (Array.isArray(parsed?.items) ? parsed.items : []).map((it: any) => {
        const catEntry = it.codigo_item != null ? catalogoPorCodigo.get(String(it.codigo_item)) : null
        return {
          codigo_item: catEntry ? catEntry.codigo_item : null,
          rubro: catEntry ? catEntry.rubro : (it.rubro || 'VARIOS'),
          descripcion_item: catEntry ? catEntry.descripcion : (it.descripcion_item || 'Ítem relevado'),
          unidad: catEntry ? catEntry.unidad : (it.unidad || 'unid'),
          cantidad: parseFloat(it.cantidad) || 1,
          riesgo: ['urgente', 'funcional', 'mantenimiento'].includes(it.riesgo) ? it.riesgo : 'funcional',
          es_restauracion: !!it.es_restauracion,
          justificacion: it.justificacion || null,
          precio_material: catEntry?.precio_material ?? null,
          precio_mano_obra: catEntry?.precio_mano_obra ?? null,
          precio_unitario_total: catEntry?.precio_unitario_total ?? null,
        }
      })

      return new Response(JSON.stringify({
        especialista: parsed?.especialista || null,
        mensaje_auditoria: parsed?.mensaje_auditoria || null,
        alertas_omision: parsed?.alertas_omision || null,
        items,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ── Subida del archivo al storage (server-to-server, confiable desde mobile) ──
    // Corre en paralelo a la IA y devolvemos la URL pública en la respuesta.
    // Comprobantes de gasto → bucket "comprobantes". Pólizas → bucket "polizas-documentos".
    const bucket = modo === 'poliza' ? 'polizas-documentos' : 'comprobantes'
    const carpeta = modo === 'poliza' ? 'polizas' : 'comprobantes'
    const subirArchivo = async (): Promise<string> => {
      try {
        if (!base64) return ''
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!
        const storageKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')!
        const ext = (mimeType || '').includes('pdf') ? 'pdf' : ((mimeType || 'image/jpeg').split('/')[1] || 'jpg')
        const key = `${carpeta}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
        const up = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${key}`, {
          method: 'POST',
          headers: {
            'apikey': storageKey,
            'Authorization': `Bearer ${storageKey}`,
            'Content-Type': mimeType || 'application/octet-stream',
            'x-upsert': 'true',
          },
          body: bytes,
        })
        if (!up.ok) { console.error('Storage upload error:', up.status, await up.text()); return '' }
        return `${supabaseUrl}/storage/v1/object/public/${bucket}/${key}`
      } catch (e) {
        console.error('subirArchivo exception:', e.message)
        return ''
      }
    }
    const archivoPromise = subirArchivo()

    console.log('Llamando Anthropic, modo:', modo, 'mimeType:', mimeType, 'base64 length:', base64?.length)

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: modo === 'poliza' ? 1200 : 700,
        system: PROMPTS[modo](hoy),
        messages: [{
          role: 'user',
          content: [
            mimeType === 'application/pdf'
              ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
              : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: modo === 'poliza' ? 'Extraé los datos de la póliza.' : 'Extraé los datos del comprobante.' }
          ]
        }]
      })
    })

    const data = await resp.json()
    console.log('Anthropic status:', resp.status, 'response type:', data?.type)

    const imagen_url = await archivoPromise

    if (!resp.ok || data?.type === 'error') {
      console.error('Anthropic error:', JSON.stringify(data?.error))
      return new Response(JSON.stringify({ error: data?.error?.message || 'Error Anthropic', detail: data, imagen_url }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 502,
      })
    }

    return new Response(JSON.stringify({ ...data, imagen_url }), {
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
