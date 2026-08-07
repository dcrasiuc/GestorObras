import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Prompts de extracción por tipo de documento analizado
const PROMPTS = {
  comprobante: (hoy: string) =>
    `Extraés datos de comprobantes de compra (facturas, recibos, tickets) para una app de gestión de obras de construcción en Argentina. Mirá la imagen con cuidado ANTES de responder — priorizá leer bien por sobre responder rápido — y prestá atención a estos errores comunes de lectura:

- FORMATO NUMÉRICO ARGENTINO: el punto "." separa miles y la coma "," separa decimales (ej: "15.450,00" es QUINCE MIL CUATROCIENTOS CINCUENTA, no "15,45"). Convertí siempre al valor numérico real, nunca copies el string tal cual está escrito.
- "monto" es SIEMPRE el TOTAL FINAL a pagar: si el comprobante muestra varios importes (Subtotal, IVA, Percepciones, Total), tomá el TOTAL final (normalmente el último renglón, el que dice "TOTAL" y suele ser el importe más grande) — nunca un subtotal parcial antes de impuestos.
- FECHA: los comprobantes argentinos casi siempre usan DD/MM/AAAA — no lo confundas con MM/DD/AAAA.
- Si la imagen está borrosa, cortada, girada, con reflejo, o algún dato puntual no se distingue con certeza, es preferible dejar ESE campo en null (o el valor parcial que sí se alcanza a leer) antes que inventar un número o una letra que no estás seguro de haber leído bien.

Respondé SOLO con JSON válido sin texto extra ni backticks. Campos: fecha (YYYY-MM-DD, si no hay usá ${hoy}), proveedor (nombre del emisor), cuit (CUIT o CUIL del emisor tal como aparece en el documento — solo dígitos sin guiones, ej: "20123456789", null si no se ve), receptor (nombre o razón social del CLIENTE/comprador a quien se emite el comprobante, null si no se ve), cuit_receptor (CUIT del CLIENTE/comprador/receptor — solo dígitos sin guiones, null si no se ve), nro_comprobante (número tal como aparece en el documento, ej: "0001-00012345", null si no se ve), tipo_comprobante (mirá el encabezado del documento y respondé: "factura_a" si dice FACTURA A o Tipo A, "factura_b" si dice FACTURA B o Tipo B, "factura_c" si dice FACTURA C o Tipo C, "recibo" si dice RECIBO, "ticket" si dice TICKET o TIQUE, null si no podés determinarlo con certeza), concepto (uno de: materiales, mano-obra, equipos, subcontratos, varios — inferilo del contenido), monto (número TOTAL final del comprobante, sin símbolo de moneda, ya convertido de formato argentino a un número normal), iva_monto (importe de IVA discriminado en el comprobante, solo el número sin símbolo, null si no está discriminado), descripcion (1 frase breve del contenido), confianza ("alta"|"media"|"baja" — qué tan segura estás de la lectura completa del comprobante: "baja" si la imagen está borrosa, cortada, con reflejo, o si algún dato clave —monto, fecha o CUIT— no se pudo leer con certeza y tuviste que estimarlo).`,

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
3. Para cada trabajo, elegir el ítem MÁS PARECIDO del catálogo de precios "Revista Cifras" de abajo (formato codigo|rubro|descripcion|unidad) y ESTIMAR la cantidad en la unidad de ESE ítem — esto es una PROPUESTA que el técnico va a revisar y corregir antes de guardarla, así que priorizá ser transparente sobre tu razonamiento antes que "acertar":
   - Si el relato dicta una medida explícita (ej. "son 35 metros cuadrados", "un paño de 4 por 2.5"), usá ESA medida tal cual — no la reinterpretes ni la redondees a otra cosa.
   - Si NO hay medida explícita en el relato, estimá a partir de una referencia de escala visible en la foto (una puerta ≈0.90-2.10m, un ladrillo común ≈0.25m, una baldosa ≈0.30-0.40m, el ancho de una persona, etc.) y CONTÁ en "justificacion" qué referencia usaste y el cálculo aproximado — ej. "Estimé ~10m² tomando como referencia el marco de la puerta (≈2.10m de alto) para calcular que el paño de pared mide aprox. 4m x 2.5m".
   - Si no hay ninguna referencia de escala confiable en la foto ni en el relato, decilo explícitamente en la justificación (ej. "Sin referencia de escala clara en la foto, cantidad estimada muy aproximada") y marcá "confianza_medicion":"baja".
4. Clasificar el riesgo de cada ítem: "urgente" (riesgo para alumnos/usuarios — vidrio roto, cableado expuesto, pérdida de agua activa, etc.), "funcional" (no urgente pero afecta el uso normal) o "mantenimiento" (estético/preventivo).
5. Marcar es_restauracion=true si el relato indica que se puede reparar/recuperar lo existente en vez de proveer algo nuevo (ej. "se puede volver a amurar", "se puede reparar", "está dañado pero no hace falta cambiarlo").
   - Cuando es_restauracion=true Y elegiste un codigo_item real del catálogo (el catálogo tiene precios de PROVISIÓN E INSTALACIÓN NUEVA, no de reparación): estimá también "coeficiente_reparacion", un número de 0 a 1 que representa qué porcentaje del precio de ese ítem NUEVO es razonable cobrar por la reparación — el precio final de la reparación se calcula como precio_del_nuevo × coeficiente_reparacion. Guía orientativa (ajustá según lo que describa el relato/la foto, no uses siempre el mismo número):
     - Reparación menor (reamurar, resellar, ajustar, fijar algo que solo se soltó) ≈ 0.15 a 0.30.
     - Reparación moderada (se reemplaza una parte — ej. una junta, un tramo corto, un accesorio — pero se conserva la pieza principal) ≈ 0.30 a 0.60.
     - Reparación mayor (se repone casi todo el material y se reutiliza solo la base/estructura existente) ≈ 0.60 a 0.85.
     - Explicá en "justificacion" por qué elegiste ese porcentaje.
   - Si es_restauracion=true pero NO hay codigo_item (no matcheó contra el catálogo), dejá coeficiente_reparacion en null — no hay precio de referencia contra el cual calcular un porcentaje.
   - Si es_restauracion=false, coeficiente_reparacion siempre null (se cobra el 100% del ítem nuevo).
6. Control de omisiones: si de las fotos notás que faltaría verificar algo típico de este tipo de sector y no fue mencionado en el relato (luces, llaves de paso, tomas, cielorraso, etc.), decilo en alertas_omision; si no notás nada para alertar, dejalo en null.

MUY IMPORTANTE sobre el catálogo — NUNCA INVENTES UN CÓDIGO: el campo codigo_item de cada ítem que devuelvas TIENE QUE SER un código que existe LITERALMENTE en la lista de abajo. Si no hay ningún ítem del catálogo que corresponda razonablemente a lo que ves, poné codigo_item en null y completá rubro/descripcion_item con tu propio texto libre describiendo el trabajo — es preferible null a un código inventado o adivinado.

Respondé SOLO con JSON válido sin texto extra ni backticks, con esta forma exacta:
{"especialista": "🚰 Especialista Sanitarista" (el título con emoji que corresponda), "mensaje_auditoria": "1-2 oraciones en español, tono técnico profesional, explicando qué identificaste y qué ítems aplicaste", "alertas_omision": "texto breve o null", "items": [{"codigo_item": "184" o null, "rubro": "...", "descripcion_item": "...", "unidad": "unid", "cantidad": 1, "confianza_medicion": "alta"|"media"|"baja" (alta = medida explícita en el relato o referencia de escala muy clara; media = referencia de escala razonable pero aproximada; baja = sin ninguna referencia confiable, pura estimación visual), "riesgo": "urgente", "es_restauracion": false, "coeficiente_reparacion": 0.25 o null (SOLO un número si es_restauracion=true y hay codigo_item; null en cualquier otro caso), "justificacion": "explicá SIEMPRE de dónde sale la cantidad, y si es restauración también de dónde sale el porcentaje de reparación"}]}

Relato del técnico sobre "${sector}": ${relato?.trim() || '(sin relato escrito — basate solo en las fotos)'}

CATÁLOGO DE PRECIOS (Revista Cifras) — formato codigo|rubro|descripcion|unidad, uno por línea:
${catalogoTexto}`
}

// Prompt para el modo "consulta_relevamiento": el técnico ya tiene un cómputo generado (propuesto
// o ya confirmado) para un sector y pregunta algo puntual sobre un ítem — de dónde sale una
// cantidad, por qué se eligió tal precio, etc. NUNCA inventa números nuevos: solo puede explicar
// en base a los ítems reales que el cliente le manda (ya validados contra el catálogo antes).
function promptConsultaRelevamiento(sector: string, itemsTexto: string, historialTexto: string) {
  return `Sos el mismo equipo de especialistas técnicos en construcción que ya generó un cómputo de materiales/mano de obra para el sector "${sector}" de un relevamiento de campo de SEATE S.R.L. (constructora de Posadas, Misiones). El técnico de campo ya tiene ese cómputo delante y te está preguntando algo puntual sobre él — de dónde sale una cantidad, por qué se aplicó tal precio o porcentaje de reparación, etc.

REGLA MÁS IMPORTANTE: respondé ÚNICAMENTE en base a los ítems reales de abajo (ya fueron calculados y validados contra el catálogo de precios antes de llegar a vos) — nunca inventes ni recalcules un número distinto al que ya está ahí. Si la pregunta es sobre un ítem que no encontrás en la lista, o pide un dato que no está entre los campos de abajo, decilo explícitamente en vez de inventar una respuesta.

Ítems del cómputo de este sector — formato codigo|rubro|descripcion|unidad|cantidad|precio unitario|% aplicado (100% = precio de ítem nuevo, menos si es reparación)|justificación original de la IA:
${itemsTexto || '(todavía no hay ítems calculados en este sector)'}

Historial reciente de la conversación con el técnico:
${historialTexto || '(sin mensajes previos)'}

Respondé la última pregunta del técnico de forma breve, técnica y concreta (2-4 oraciones), citando el número real del ítem correspondiente (cantidad, precio unitario, % de reparación si aplica) y retomando la justificación original si ayuda a explicar de dónde sale. No repitas todo el cómputo del sector, andá directo a lo que pregunta. Si el técnico no está de acuerdo con un número, no lo cambies vos — decile que puede corregir la cantidad o el % directamente en la pantalla de revisión del ítem. Respondé SOLO con el texto de tu respuesta en español, sin JSON ni backticks ni encabezados.`
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

    // ── Modo "subir_archivo": solo sube un archivo a Storage server-to-server, sin IA ──
    // Antes, el comprobante de pago (ModalPago en GestorObras.jsx) se subía DIRECTO desde el
    // cliente con supabase.storage.upload() — el mismo patrón que ya había fallado en mobile para
    // fotos de relevamiento y documentos de pólizas, y que se había migrado a subir server-side vía
    // esta función por esa razón. El comprobante de pago había quedado afuera de esa migración y
    // seguía fallando ("da error" reportado en PC y mobile). Bucket restringido a una lista fija
    // para no abrir esta función a subir a cualquier bucket arbitrario.
    if (body.tipoAnalisis === 'subir_archivo') {
      const { base64: b64Archivo, mimeType: mimeArchivo, bucket, carpeta } = body
      const bucketsPermitidos = ['comprobantes-pagos']
      if (!bucketsPermitidos.includes(bucket)) {
        return new Response(JSON.stringify({ error: 'Bucket no permitido.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        })
      }
      if (!b64Archivo) {
        return new Response(JSON.stringify({ error: 'Falta el archivo.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        })
      }
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!
        const storageKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')!
        const ext = (mimeArchivo || '').includes('pdf') ? 'pdf' : ((mimeArchivo || 'image/jpeg').split('/')[1] || 'jpg')
        const key = `${carpeta || 'archivos'}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
        const bytes = Uint8Array.from(atob(b64Archivo), c => c.charCodeAt(0))
        const up = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${key}`, {
          method: 'POST',
          headers: {
            'apikey': storageKey,
            'Authorization': `Bearer ${storageKey}`,
            'Content-Type': mimeArchivo || 'application/octet-stream',
            'x-upsert': 'true',
          },
          body: bytes,
        })
        if (!up.ok) {
          const errTxt = await up.text()
          console.error('subir_archivo upload error:', up.status, errTxt)
          return new Response(JSON.stringify({ error: 'No se pudo subir el archivo al storage.' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 502,
          })
        }
        const url = `${supabaseUrl}/storage/v1/object/public/${bucket}/${key}`
        return new Response(JSON.stringify({ url }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      } catch (e) {
        console.error('subir_archivo exception:', e.message)
        return new Response(JSON.stringify({ error: e.message }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500,
        })
      }
    }

    // ── Modo IA: análisis de comprobante, póliza o relevamiento ──
    const { base64, mimeType, hoy, tipoAnalisis } = body
    const modo = tipoAnalisis === 'poliza' ? 'poliza' : tipoAnalisis === 'relevamiento' ? 'relevamiento' : tipoAnalisis === 'consulta_relevamiento' ? 'consulta_relevamiento' : 'comprobante'
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
        const esRestauracion = !!it.es_restauracion
        // coeficiente_reparacion: solo tiene sentido cuando es restauración Y hay un ítem nuevo del
        // catálogo contra el cual calcular el porcentaje — nunca confiar en un valor fuera de (0,1].
        const coefNum = parseFloat(it.coeficiente_reparacion)
        const coeficienteAjuste = (esRestauracion && catEntry && Number.isFinite(coefNum) && coefNum > 0 && coefNum <= 1)
          ? coefNum
          : 1
        const precioNuevo = catEntry?.precio_unitario_total ?? null
        return {
          codigo_item: catEntry ? catEntry.codigo_item : null,
          rubro: catEntry ? catEntry.rubro : (it.rubro || 'VARIOS'),
          descripcion_item: catEntry ? catEntry.descripcion : (it.descripcion_item || 'Ítem relevado'),
          unidad: catEntry ? catEntry.unidad : (it.unidad || 'unid'),
          cantidad: parseFloat(it.cantidad) || 1,
          confianza_medicion: ['alta', 'media', 'baja'].includes(it.confianza_medicion) ? it.confianza_medicion : 'media',
          riesgo: ['urgente', 'funcional', 'mantenimiento'].includes(it.riesgo) ? it.riesgo : 'funcional',
          es_restauracion: esRestauracion,
          justificacion: it.justificacion || null,
          precio_material: catEntry?.precio_material ?? null,
          precio_mano_obra: catEntry?.precio_mano_obra ?? null,
          // precio_unitario_total sigue siendo el precio de referencia del ítem NUEVO (para mostrarlo
          // al técnico como comparación); coeficiente_ajuste y precio_unitario_ajustado son el
          // porcentaje aplicado y el precio final a cobrar cuando es una reparación.
          precio_unitario_total: precioNuevo,
          coeficiente_ajuste: coeficienteAjuste,
          precio_unitario_ajustado: precioNuevo != null ? +(precioNuevo * coeficienteAjuste).toFixed(2) : null,
        }
      })

      return new Response(JSON.stringify({
        especialista: parsed?.especialista || null,
        mensaje_auditoria: parsed?.mensaje_auditoria || null,
        alertas_omision: parsed?.alertas_omision || null,
        items,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ── Modo "consulta_relevamiento": chat real sobre un cómputo ya generado (reemplaza la
    // simulación por palabras clave que solo reaccionaba a "amurar"/"reparar"/"fijar" y nunca
    // contestaba una pregunta de verdad) — el cliente manda los ítems reales del sector (ya
    // pasaron por el catálogo antes) y la IA solo puede explicar en base a esos números.
    if (modo === 'consulta_relevamiento') {
      const { sector, pregunta, itemsContexto, historial } = body
      if (!pregunta?.trim()) {
        return new Response(JSON.stringify({ error: 'Falta la pregunta.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        })
      }
      const itemsTexto = (Array.isArray(itemsContexto) ? itemsContexto : [])
        .map((it: any) => {
          const pct = it.coeficiente_ajuste != null ? Math.round(it.coeficiente_ajuste * 100) : 100
          return `${it.codigo_item ?? 's/código'}|${it.rubro ?? ''}|${it.descripcion_item ?? ''}|${it.unidad ?? ''}|${it.cantidad ?? ''}|${it.precio_unitario != null ? '$' + it.precio_unitario : 's/precio'}|${pct}%|${it.justificacion ?? it.notas_campo ?? ''}`
        })
        .join('\n')
      const historialTexto = (Array.isArray(historial) ? historial : [])
        .slice(-8)
        .map((m: any) => `${m.emisor === 'tecnico' ? 'Técnico' : 'Especialista'}: ${m.mensaje}`)
        .join('\n')

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          system: promptConsultaRelevamiento(sector || '', itemsTexto, historialTexto),
          messages: [{ role: 'user', content: [{ type: 'text', text: pregunta.trim() }] }],
        }),
      })
      const data = await resp.json()
      console.log('Anthropic status (consulta_relevamiento):', resp.status, 'items en contexto:', Array.isArray(itemsContexto) ? itemsContexto.length : 0)

      if (!resp.ok || data?.type === 'error') {
        console.error('Anthropic error (consulta_relevamiento):', JSON.stringify(data?.error))
        return new Response(JSON.stringify({ error: data?.error?.message || 'Error Anthropic' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 502,
        })
      }

      const respuesta = data?.content?.map((b: any) => b.text || '').join('').trim() || 'No pude generar una respuesta — probá reformular la pregunta.'
      return new Response(JSON.stringify({ respuesta }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
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
