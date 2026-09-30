# GESTOR DE OBRAS — Contexto para Claude
*Última actualización: 7 de agosto de 2026*

---

## ¿Qué es este proyecto?

App de gestión de obras de construcción para **Daniel (SEATE S.R.L., Posadas, Misiones, Argentina)**. Permite registrar obras, gastos por obra, pagos, proveedores, clientes y pólizas/garantías de seguro por obra. Incluye análisis de comprobantes y de pólizas con IA (Claude).

**Dueño:** Daniel  
**Empresa:** SEATE S.R.L. (Posadas, Misiones, Argentina) — CUIT: 30715138022  
**Crédito fiscal IVA:** solo computa con Factura A a nombre de SEATE (CUIT 30715138022). Cualquier otra factura no genera crédito fiscal.  
**Remitos vs Facturas:** el remito es un costo provisorio por obra; cuando llega la factura, la reemplaza (sin duplicar el costo).

---

## Stack técnico

| Componente | Tecnología | URL / Info |
|---|---|---|
| Frontend | React + Vite (multi-archivo) | `src/` |
| Deploy | Cloudflare **Pages** | Automático al hacer push a `main` via GitHub |
| Base de datos | Supabase | Proyecto: `oyqmowolwwjjuarxttuh` |
| IA (análisis comprobantes) | Anthropic Claude (via Edge Function) | Supabase Edge Function |
| Auth | Supabase Auth | `storageKey: 'seate-auth'` en localStorage |
| Storage | Supabase Storage | Bucket `comprobantes-pagos` (PUBLIC) — comprobantes de pago |

**Tablas Supabase:** `obras`, `gastos`, `pagos`, `clientes`, `proveedores`, `bancos`, `usuarios`, `polizas`, `poliza_documentos`

---

## Arquitectura del código

```
src/
├── main.jsx            # Entry point
├── App.jsx             # Router raíz (Login vs GestorObras)
├── GestorObras.jsx     # App principal (~3500+ líneas)
├── CuentaCorriente.jsx # Vista cuenta corriente por cliente/proveedor
├── Seguros.jsx         # Control de pólizas/garantías por obra (módulo standalone)
├── exportSegurosExcel.js # Export a Excel de la cuenta corriente de Seguros (NO importa de Seguros.jsx — ver "Bugs resueltos")
├── ModalObraCompartido.jsx # Modal "Nueva/Editar obra" — el mismo, usado por GestorObras.jsx Y Seguros.jsx (setiembre 2026)
├── Login.jsx           # Pantalla de login
├── utils.js            # dbWrite() — proxy de escrituras via Edge Function
├── supabaseClient.js   # Cliente Supabase (auth + reads)
├── constants.js        # Colores, conceptos, medios de pago, situaciones impositivas
├── toast.js            # Sistema de notificaciones
└── supabase/
    └── functions/
        └── analizar-comprobante/
            └── index.ts   # Edge Function dual-mode (IA + DB write proxy)
```

---

## Patrón crítico: Mobile Write Proxy

### El problema
El carrier de Paraguay bloquea/descarta los POST directos a la API REST de Supabase desde mobile. Los GET funcionan. Esto causaba que los datos se guardaban pero no se veían hasta reiniciar la app.

### La solución
**Todas las escrituras** van a través de la Supabase Edge Function `analizar-comprobante`, que hace server-to-server hacia Supabase REST (confiable).

```
Mobile/PC → Edge Function → Supabase REST
```

### `dbWrite` en `src/utils.js`

```js
const DB_WRITE_URL = 'https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante'

export async function dbWrite(method, table, payload, filter = null, returning = false) {
  const token = getTokenSync()  // Lee JWT de localStorage sin network
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('Sin respuesta del servidor. Verificá tu conexión.')), 20000)
  )
  const respRaw = await Promise.race([
    fetch(DB_WRITE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY, 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ table, method, payload, filter, returning }),
    }),
    timeout,
  ])
  const result = await respRaw.json()
  if (!respRaw.ok || result?.error) throw new Error(result?.error || `HTTP ${respRaw.status}`)
  return returning ? result.data : null
}
```

**Regla:** SIEMPRE usar `dbWrite` para INSERT/UPDATE/DELETE. NUNCA llamar a `supabase.from(...).insert/update/delete` directamente.

---

## Patrón: Optimistic Updates

Después de un write exitoso, actualizar el estado React **inmediatamente** sin esperar a releer de Supabase. Luego hacer una recarga silenciosa en background.

```js
// INSERT nuevo gasto:
const saved = await dbWrite('POST', 'gastos', payload, null, true)  // returning=true
if (saved?.id) {
  setGastos(prev => [{ ...payload, id: saved.id, obras: {...}, proveedores: {...}, pagos: [] }, ...prev])
}
recargarTodo(true)  // silent=true → sin spinner

// UPDATE gasto existente:
await dbWrite('PATCH', 'gastos', payload, `id=eq.${id}`)
setGastos(prev => prev.map(g => g.id === id ? { ...g, ...payload } : g))
recargarTodo(true)

// DELETE:
await dbWrite('DELETE', 'gastos', null, `id=eq.${id}`)
setGastos(prev => prev.filter(g => g.id !== id))
recargarTodo(true)
```

---

## Patrón: Failsafe Timeouts + Silent Reload

Los hooks `useObras` y `useGastos` tienen:
1. **Failsafe de 12 segundos**: si la lectura de Supabase cuelga, el spinner se cancela automáticamente
2. **Parámetro `showLoading`**: permite recargar en background sin mostrar spinner

```js
const cargar = useCallback(async (showLoading = true) => {
  if (showLoading) setLoading(true)
  const failsafe = showLoading ? setTimeout(() => setLoading(false), 12000) : null
  try {
    // ... queries Supabase ...
  } catch (e) { console.error(e) }
  if (failsafe) clearTimeout(failsafe)
  if (showLoading) setLoading(false)
}, [deps])
```

---

## Patrón: Multi-Device Sync (Realtime)

Supabase Realtime detecta cambios en otras sesiones y recarga en background.

```js
useEffect(() => {
  let timerG, timerO, timerL
  const ch = supabase.channel('sync-multi-device')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'gastos' },
      () => { clearTimeout(timerG); timerG = setTimeout(recargarGastos, 800) })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'obras' },
      () => { clearTimeout(timerO); timerO = setTimeout(recargarObras, 800) })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'clientes' },
      () => { clearTimeout(timerL); timerL = setTimeout(recargarListas, 800) })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'proveedores' },
      () => { clearTimeout(timerL); timerL = setTimeout(recargarListas, 800) })
    .subscribe()
  return () => { supabase.removeChannel(ch); clearTimeout(timerG); clearTimeout(timerO); clearTimeout(timerL) }
}, [recargarGastos, recargarObras, recargarListas])
```

**Requisito:** Realtime debe estar habilitado en el dashboard de Supabase + ejecutar en SQL Editor:
```sql
ALTER TABLE gastos     REPLICA IDENTITY FULL;
ALTER TABLE obras      REPLICA IDENTITY FULL;
ALTER TABLE clientes   REPLICA IDENTITY FULL;
ALTER TABLE proveedores REPLICA IDENTITY FULL;
```

---

## Feature: Gastos Generales de Empresa

Los gastos generales son gastos que no pertenecen a una obra específica (combustible, servicios, legal, oficina) y se prorratean entre todas las obras activas.

### Columnas en `gastos`
- `es_gasto_general: boolean` — true = gasto de empresa, no de obra
- `obra_id: null` — siempre null para gastos generales (columna NO NOT NULL)
- `concepto`: uno de `CONCEPTOS_GENERALES = ['combustible', 'servicios', 'legal', 'oficina', 'varios_gral']`

### SQL migrations aplicadas
```sql
-- Permitir obra_id null
ALTER TABLE gastos ALTER COLUMN obra_id DROP NOT NULL;

-- Ampliar CHECK de concepto para incluir generales
ALTER TABLE gastos DROP CONSTRAINT gastos_concepto_check;
ALTER TABLE gastos ADD CONSTRAINT gastos_concepto_check
  CHECK (concepto IN (
    'materiales', 'mano-obra', 'equipos', 'subcontratos', 'varios',
    'combustible', 'servicios', 'legal', 'oficina', 'varios_gral'
  ));
```

### Prorrateo
Los gastos generales se distribuyen proporcionalmente entre obras según el gasto directo de cada obra en el período. El cálculo es mes a mes en `ModalDetalleObra` y en el dashboard de obras.

### Excluir una operación puntual del prorrateo (`gastos.excluir_prorrateo`, agosto 2026)

Pedido del usuario: poder marcar un gasto puntual de una obra (ej. una compra grande y excepcional) para que NO infle el "peso" de esa obra a la hora de repartirle gastos generales — sin dejar de sumar normalmente al total gastado de la obra.

- Columna nueva: `gastos.excluir_prorrateo boolean NOT NULL DEFAULT false`.
- Checkbox "No participa del prorrateo de gastos generales" en `FormGasto` (compartido por `ModalGasto` — alta/edición manual — y por el paso de revisión de `ModalFoto` — alta con IA), visible solo cuando el gasto NO es "Gasto general de empresa" (ese toggle no aplica ahí).
- El cálculo del "peso" usado para prorratear (`pesoProrrateoPorObra` en el componente principal, y `totalObrasMes` dentro de `ModalDetalleObra`) excluye los gastos con `excluir_prorrateo = true`. El total gastado de la obra (`totalPorObra`, lo que se muestra como "Total gastado" en cada card) **no** se toca — el gasto sigue contando ahí normalmente. Solo se excluye del cálculo de la proporción con la que se reparte combustible/servicios/legal/oficina entre obras.
- Indicador visual "🚫 sin prorrateo" / "🚫 No prorratea" en la fila del gasto (mobile y desktop) cuando está marcado.

### Excluir una obra ENTERA del prorrateo (`obras.excluir_gastos_generales`, agosto 2026)

El pedido anterior (`excluir_prorrateo` a nivel gasto) no era lo que el usuario necesitaba en realidad — lo que pidió después fue poder dejar una **obra completa** afuera de los gastos generales: que esa obra ni aporte peso al cálculo ni reciba ninguna parte de combustible/servicios/legal/oficina. Quedan ambas funcionalidades (son compatibles, cubren casos distintos: una operación puntual vs. una obra entera).

- Columna nueva: `obras.excluir_gastos_generales boolean NOT NULL DEFAULT false`.
- **Importante**: la vista `obras_resumen` (la que usa `useObras()` para traer las obras al panel principal, tanto para admin como para operador) tiene columnas explícitas, no `select *` — se tuvo que agregar `o.excluir_gastos_generales` a mano en el `CREATE OR REPLACE VIEW` para que el frontend la reciba. Si en el futuro se agrega otra columna a `obras` que el frontend necesite leer desde el panel principal, hay que acordarse de sumarla también acá.
- Checkbox "No participa de los gastos generales de la empresa" en `ModalObra` (alta/edición de obra).
- En el cálculo del peso (`pesoProrrateoPorObra` en el componente principal y `totalObrasMes` en `ModalDetalleObra`) se arma un `Set` con los IDs de las obras marcadas (`obrasExcluidasGG`) y se filtran sus imputaciones antes de sumar — la obra directamente no entra al cálculo, ni como numerador ni como parte del denominador. El resto de las obras se reparte el 100% de `totalGeneralesAll` entre ellas.
- El "Total gastado" de la obra excluida (`totalPorObra`) no se toca — sigue sumando sus gastos directos normalmente; solo deja de aparecer el badge "🏛️ +$X empresa" (`prorrateoGeneral` da `0` automáticamente porque la obra nunca entra al mapa `gastosGeneralesPorObra`).
- Badge "🚫 Sin gastos generales" en la card de la obra en el dashboard cuando está marcada.

### Dónde aparecen los gastos generales
- **Dashboard obras**: badge azul "🏛️ +$X empresa → $Y total" en cada card
- **Mobile header total**: suma gastos generales al total del mes
- **Saldo pendiente**: incluye gastos generales impagos
- **CuentaCorriente proveedor**: tab "Gastos" muestra gastos generales del proveedor
- **Modal cierre de obra (📊)**: historial mes a mes con prorrateo acumulado

---

## Feature: Upload de Comprobantes de Pago

### Bucket de Storage
- **Nombre:** `comprobantes-pagos` (bucket PUBLIC en Supabase Storage)
- **Path:** `pagos/{timestamp}_{random}.{ext}`
- Si el bucket no existe → crearlo en Supabase → Storage → New bucket → marcar como Public

### Función compartida `subirArchivoStorage(file)`
Definida a nivel módulo en `GestorObras.jsx`, usada por los tres modales de pago:
- Comprime imágenes a **600px / 0.72 calidad** (suficiente para comprobantes, ~60-80KB resultado)
- **Timeout de 60 segundos** por intento (no 20s)
- **Retry automático** una vez si falla, con 1.5s de pausa
- Si la compresión falla Y el original es >5MB → muestra toast de error en vez de intentar subir
- **Migrada a Edge Function (dejó de subir directo desde el cliente)**: los usuarios (Longarzo, entre otros) reportaban que adjuntar el comprobante de pago daba error seguido, tanto en PC como en mobile. La causa era que esta función todavía usaba `supabase.storage.from('comprobantes-pagos').upload()` directo desde el navegador — el mismo patrón de subida directa que ya había fallado en mobile para fotos de relevamiento y documentos de pólizas, y que en esos otros módulos ya se había migrado a subir server-side vía la Edge Function `analizar-comprobante` por esa razón. El comprobante de pago había quedado afuera de esa migración. Ahora `subirArchivoStorage` arma el base64 (con `leerBase64`, ya existente) y llama a la Edge Function con `{ tipoAnalisis: 'subir_archivo', base64, mimeType, bucket: 'comprobantes-pagos', carpeta: 'pagos' }` — modo nuevo agregado a la Edge Function (Edge Function versión 41) que solo sube el archivo con la service role key y devuelve `{ url }`, sin llamar a Claude (más rápido que los otros modos, que si hacen IA). El bucket está restringido a una lista fija (`comprobantes-pagos`) dentro de la Edge Function, para no abrir la subida a cualquier bucket arbitrario.

### Compresión de imágenes: `_canvasComprimido`
**IMPORTANTE:** usa `URL.createObjectURL` en vez de `FileReader.readAsDataURL`.

**Por qué:** fotos del Pixel 8 Pro pueden ser 50MP (15-20MB). Con readAsDataURL el navegador convierte a base64 (+33% de RAM) y luego decodifica a píxeles (~300MB RAM total) → crash en mobile. Con createObjectURL el browser maneja el decode de forma más eficiente.

```js
async function _canvasComprimido(file, maxLado = 1600) {
  const objUrl = URL.createObjectURL(file)
  const img = await Promise.race([
    new Promise((res, rej) => { const i = new Image(); i.onerror = () => { URL.revokeObjectURL(objUrl); rej(...) }; i.onload = () => res(i); i.src = objUrl }),
    new Promise((_, rej) => setTimeout(() => { URL.revokeObjectURL(objUrl); rej(...) }, 20000))
  ])
  URL.revokeObjectURL(objUrl)
  // ... canvas resize + toBlob
}
```

### Ver la factura adjunta desde el modal de pago (`ModalPago`, agosto 2026)

Pedido del usuario: al registrar un pago, poder consultar la factura adjunta del gasto (`gasto.imagen_url`) sin salir del modal, para cruzar los datos (proveedor, monto, nº de comprobante) antes de confirmar. Antes el link "Ver comprobante original" existía pero estaba escondido detrás del toggle "ver más ▼" y abría en pestaña nueva — poco práctico para comparar mientras se completa el formulario.

- Botón "🧾 Ver factura" ahora siempre visible en la fila superior del modal (junto al ícono de WhatsApp), no hace falta desplegar "ver más".
- Si `gasto.imagen_url` termina en `.pdf` (se detecta por la extensión del path, que sí queda en la URL de Storage) → abre en pestaña nueva con `window.open` (los PDF no siempre renderizan bien en un `<img>`).
- Si es imagen → abre `VisorImagenFactura`, un visor superpuesto (`zIndex: 400`, arriba del modal de pago que usa 200) con la imagen a tamaño grande, sin cerrar el modal de pago de fondo — el usuario puede cerrar el visor (✕ o click afuera) y volver a ver el formulario. Incluye fallback a "Abrir en pestaña nueva" si la imagen no carga (`onError` en el `<img>`).
- `ModalPago` ahora retorna un fragment (`<>...</>`) para poder renderizar `VisorImagenFactura` como hermano del `<Modal>`, no como hijo — así el `position:fixed` del visor apila correctamente por `zIndex` en vez de quedar recortado por el `overflowY:auto` del contenido del modal.
- Solo se implementó en `ModalPago` (pago individual) — `ModalPagoMultiple` (pago de varios gastos a la vez) todavía no tiene este botón.

---

## Nota de layout: tabla de gastos con scroll horizontal (agosto 2026)

La tabla desktop de gastos (`PanelGastos`) usa columnas de ancho fijo (`tableLayout:'fixed'`, colgroup suma ~1026px) dentro de un `main-content` con `maxWidth:1060`. La página tiene `overflowX:'hidden'` global (`document.body` y el div raíz), así que si la ventana del navegador es más angosta que lo que la tabla necesita, las últimas columnas (Estado, botones de acción) quedaban directamente invisibles y sin forma de scrollear para verlas — reportado por el usuario ("no se ven los botones margen derecho"). Se agregó un `<div style={{ overflowX: 'auto' }}>` envolviendo el `<table>` (mismo patrón que ya usaba el gráfico de "Evolución diaria por rubro" en `PanelFinanciero`), y `minWidth: 1026` en el `<table>` para que no se comprima por debajo de sus columnas. Si la ventana es angosta, ahora se puede scrollear horizontalmente dentro de la tabla en vez de perder las columnas.

---

## Feature: comprobantes pendientes de obras pausadas/finalizadas no deben ocultarse (agosto 2026)

Pedido del usuario: si una obra queda **pausada** o **finalizada** con comprobantes de gasto todavía impagos, esos comprobantes tienen que seguir apareciendo en las listas de pendientes — no deben "desaparecer" solo porque la obra dejó de estar activa. Los gastos **ya pagados** de una obra inactiva sí se siguen ocultando, como antes (la obra pausada/finalizada no debe volver a inundar la vista con historial viejo, solo con la deuda real).

Antes esto no se cumplía de forma consistente: cada panel arma su propio filtro de "obras activas" por separado (ver la nota de "Prorrateo…" más abajo, mismo patrón de cálculo duplicado), y varios de esos filtros escondían directamente cualquier gasto de una obra no-activa, esté pagado o no.

- **`PanelGastos`** (lista principal de comprobantes): antes filtraba `gastos = gastosRaw.filter(g => g.es_gasto_general || idsActivas.has(g.obra_id))` — obra no-activa = gasto invisible, pagado o no. Ahora se calcula `obraIdsConPendientes` (obras, sin importar su estado, que tengan al menos un gasto impago) y se arma `idsVisibles = idsActivas ∪ obraIdsConPendientes`; el filtro pasa a ser `gastos = gastosRaw.filter(g => g.es_gasto_general || idsVisibles.has(g.obra_id))`. Con esto, una obra pausada/finalizada aparece en la lista mientras tenga algo impago, y deja de aparecer sola cuando se termina de pagar todo.
- El selector de obra del filtro (`GastosFiltros`) recibe `obrasParaFiltro` (activas + inactivas-con-pendientes) en vez de solo `obrasActivas`, para poder filtrar puntualmente por esas obras inactivas que ahora son visibles. Las opciones del `<select>` muestran el estado entre paréntesis cuando no es "activa" (ej. "Casa Pérez (pausada)").
- El `useEffect` que resetea `filtroObraId` cuando la obra filtrada deja de estar disponible ahora también respeta esta regla (no resetea si la obra sigue teniendo pendientes, aunque esté pausada/finalizada).
- La card mobile y la celda "Obra" de la tabla desktop muestran el estado de la obra cuando no es activa: sufijo `(pausada)`/`(finalizada)` en mobile, e ícono ⏸/🏁 junto al nombre en desktop (con `title` para accesibilidad).
- `useGastos` amplía el `select` de Supabase para traer también `obras(nombre, estado)` (antes solo `obras(nombre)`) — hace falta el estado para poder mostrar el sufijo/ícono y para el filtro. **No** se tocaron los tres lugares donde el hook actualiza `obras` de forma optimista tras guardar/editar (siguen mandando solo `{ nombre: obraObj.nombre }` sin `estado`) — es una inconsistencia menor y de bajo riesgo: en el peor caso, un gasto recién creado/editado no muestra el sufijo de estado hasta el próximo refetch, nunca se oculta de más.
- **`PanelInicio`** (dashboard de inicio) tenía el mismo problema en otro lugar: las tarjetas "Pendiente", "Pend. contado" y "Pend. cta. cte." partían de `gastosActivas` (ya filtrado a obras activas), a pesar de que el comentario del código decía "Pendiente incluye TODAS las impagas (también de obras cerradas)" — el comentario no se cumplía en la práctica. Se separó el cálculo: `impagas` ahora se arma desde `gastos` sin filtrar por obra activa (`gastos.filter(g => !g.pagado && !g.es_gasto_general && enPeriodo(g.fecha))`), y las tarjetas "Pend. contado"/"Pend. cta. cte." usan esa misma lista en vez de `gastosActivas`. El resto de las métricas del período (Total gastos, Pagado, crédito fiscal, provisorios) se dejaron como estaban, acotadas a obras activas — representan el movimiento del período en obras en curso, no la deuda pendiente.
- No se tocó el bloque "Gastos generales — impacto por obra" (`gastoPorObra`, corregido en un pedido anterior de este mismo mes) ni "Últimos gastos" (`ultimosGastos`, lista de actividad reciente) — quedan fuera del alcance de este pedido.
- `NotifPendientes` ya usaba `todosGastos` sin filtrar por obra activa desde antes — no necesitó cambios, y sirvió de referencia para el criterio a aplicar en los demás lugares.
- No hizo falta migración de base de datos — es un cambio de lógica de filtrado en el frontend, `obras.estado` y `gastos.pagado` ya existían.

---

## Feature: fecha ambigua al leer comprobantes con IA — día/mes cruzados (septiembre 2026)

Pedido del usuario: la fecha que la IA lee de la foto de un comprobante (`ModalFoto`, Edge Function `analizar-comprobante`) a veces queda con el día y el mes cruzados. La causa NO es de visualización — en toda la app la fecha se guarda como `YYYY-MM-DD` y se muestra siempre igual (o bien tal cual, o bien reordenada explícitamente a `DD/MM` con `fmtDia`/`toLocaleDateString('es-AR')`, nunca depende del locale del navegador). El problema está más atrás, en la EXTRACCIÓN: cuando el comprobante imprime la fecha solo en números separados por "/" o "-" y AMBOS componentes (día y mes) son ≤12 (ej. "05/08/2026"), es imposible saber con certeza cuál es cuál mirando solo esos dos números — y distintas imprentas fiscales/software de facturación usan distinto orden (DD/MM la mayoría en Argentina, pero no todas). El prompt anterior solo decía "los comprobantes argentinos casi siempre usan DD/MM, no te confundas con MM/DD", sin ninguna forma de detectar cuándo ese default realmente aplicaba o no.

- El prompt de `analizar-comprobante/index.ts` (tipo `comprobante`) ahora le pide a la IA que, ante una fecha numérica ambigua, busque pistas en el resto del documento antes de asumir DD/MM a ciegas (otra fecha del mismo comprobante con un componente >12, un mes escrito en palabras, etc.), y que recuerde que si CUALQUIERA de los dos números es >12 ese es inequívocamente el día sin importar en qué posición aparece (no existe mes 13).
- Dos campos nuevos en la respuesta JSON de la IA (solo para este tipo de análisis): `fecha_texto_original` (la fecha transcripta LITERAL, con el mismo orden que está impreso — nunca normalizada, sirve para comparar a ojo) y `fecha_ambigua` (boolean: true solo cuando la IA tuvo que aplicar el default DD/MM sin ninguna pista que lo confirmara).
- **Estos dos campos son efímeros, viven solo en el estado del formulario de `ModalFoto` durante la revisión — no son columnas de la tabla `gastos` y no se mandan a `dbWrite`.** Antes de llamar a `onGuardar` se desestructuran y se descartan (`const { fecha_texto_original, fecha_ambigua, ...formParaGuardar } = form`). No hizo falta ninguna migración.
- En el campo "Fecha" de `FormGasto` (el formulario de revisión, compartido con `ModalGasto` pero estos campos solo existen viniendo de `ModalFoto`), debajo del `<input type="date">` aparece "En el comprobante dice: **{fecha_texto_original}**" cuando la IA detectó alguna fecha — así el usuario puede comparar a ojo la fecha interpretada contra el texto real del papel antes de guardar. Si `fecha_ambigua` es true, esa línea se pinta en naranja con un ⚠️ y el texto "día/mes ambiguo, verificá".
- Además, si `fecha_ambigua` es true se dispara un toast puntual (`⚠️ Fecha ambigua en este comprobante...`) distinto del cartel genérico de "confianza baja" — es una alerta más específica para este error exacto, en vez de depender del cartel general que solo salta con confianza "baja" (no "media").
- **Límite conocido, no resuelto porque es inherente al problema**: si el comprobante no tiene NINGUNA pista adicional (ni otra fecha, ni mes escrito en palabras) y ambos números son ≤12, sigue sin haber manera de saber el orden con 100% de certeza solo mirando la imagen — lo que se agregó es que ahora la IA avisa cuando está en esa situación (en vez de adivinar en silencio), para que el humano lo confirme mirando `fecha_texto_original`. Esto es intencional, en línea con el principio del proyecto de "nunca dejar que la IA invente un número sin que el humano lo pueda verificar".
- Mismo tipo de ambigüedad podría existir en las fechas de pólizas (`fecha_emision`/`fecha_inicio`/`fecha_vencimiento` en el prompt tipo `poliza`) — no se tocó esa sección esta vez porque el usuario reportó el problema puntualmente en comprobantes/facturas; si se repite en pólizas, aplicar el mismo patrón ahí.

**Corrección del usuario (mismo día)**: después de este cambio, el usuario aclaró que el dato en sí SÍ estaba bien tomado — al abrir el comprobante y mirar el `<input type="date">` (el almanaque), la fecha correcta aparecía seleccionada. Lo que pasaba era otra cosa: **la lista mostraba el string ISO (`YYYY-MM-DD`) tal cual**, sin reformatear, y en ISO el mes va en el medio, ANTES del día — así que a simple vista se lee "mes antes que día", que es exactamente lo que el usuario reportó como "invertido". No era un error de lectura de la IA (ese caso puntual de ambigüedad día/mes sigue siendo válido y vale la pena tenerlo, pero es un problema distinto y más raro) — era que casi TODA la app mostraba la fecha cruda de la base en vez de formatearla como DD/MM/AAAA. Ver la sección siguiente, que es la que realmente resuelve lo que el usuario venía reportando desde el principio.

---

## Feature: mostrar SIEMPRE las fechas como día/mes/año en toda la app (septiembre 2026)

Causa real del reporte del usuario ("la fecha aparece a veces con el mes antes que el día"): las fechas se guardan en la base como `YYYY-MM-DD` (ISO — lo que necesita el `<input type="date">` nativo y lo que evita bugs de huso horario al comparar/ordenar fechas como texto). El problema es que en casi toda la app esa fecha se mostraba TAL CUAL en las listas, sin reformatear — y en `YYYY-MM-DD` el mes literalmente aparece en el medio, antes del día. El dato guardado siempre fue correcto (por eso el almanaque del formulario mostraba bien la fecha al editar); lo que estaba mal era nada más la presentación como texto en listas, tarjetas, mensajes de WhatsApp, confirmaciones de duplicado, etc.

- Nuevo helper en `utils.js`: `fmtFechaAR(iso)` — reordena el string `YYYY-MM-DD` a `DD/MM/AAAA` con un simple `split('-')` y armado de template string. **A propósito NO usa `new Date(...)`**: parsear con `Date` y volver a formatear puede corromper el día por huso horario (un clásico: `new Date('2026-08-05')` se interpreta en UTC medianoche, y en UTC-3 `.getDate()` puede devolver el día anterior). Al ser solo reordenamiento de texto, no hay conversión de zona horaria de por medio.
- Se aplicó `fmtFechaAR(...)` en TODOS los lugares donde una fecha se muestra como texto en `GestorObras.jsx`, `CuentaCorriente.jsx` y `Seguros.jsx`: lista de gastos (mobile y desktop), remitos, historial de pagos (incluye cheques y su fecha de cobro), modal de pago (fecha del gasto, vencimiento), mensaje de WhatsApp para compartir un gasto, los tres textos de aviso de "gasto duplicado" (comparan fechas), las tarjetas "próx. vencimiento" de Inicio, `VencimientoBadge` y "Vigencia desde" de pólizas, historial de renovaciones de pólizas, cuenta corriente de proveedores.
- **Lo que NO se tocó a propósito**: el `value` de cualquier `<input type="date">` (sigue necesitando el string ISO, lo maneja el navegador) y toda la lógica interna que compara/ordena/agrupa por fecha (`enPeriodo`, `calcVencimiento`, `.localeCompare`, agrupamientos por mes, filtros de rango) — ahí se sigue trabajando con el string ISO original, `fmtFechaAR` se aplica solo en el punto final donde el valor se convierte a texto visible.
- No hizo falta ninguna migración ni cambio de columnas — es puramente presentación.

---

## Feature: montos en pagos se mostraban redondeados a pesos enteros — faltaban los centavos (septiembre 2026)

Pedido del usuario: cuando se aplica un pago (de una factura individual o de varias facturas juntas, con el pago múltiple), la app redondea el número y no muestra los decimales exactos de la factura o de la sumatoria — varios proveedores necesitan el importe EXACTO (con centavos) para poder conciliar su cuenta corriente.

Causa real (mismo patrón que el bug de fechas, ver sección anterior): el monto guardado en la base SIEMPRE tuvo los centavos completos — nada en el código de guardado (`parseFloat`, el payload que manda `dbWrite`) redondea ni trunca decimales. El problema es puramente de PRESENTACIÓN: el helper `fmt(n)` usado en toda la app (`Intl.NumberFormat` con `maximumFractionDigits: 0`) redondea a peso entero para mostrar, y se estaba usando también en las pantallas de pago — justo donde el usuario necesita ver el importe exacto antes de confirmar, no una versión redondeada.

- Nuevo helper en `utils.js`: `fmtDec(n)` — mismo formato es-AR (punto de miles, coma decimal) pero siempre con 2 decimales (`minimumFractionDigits: 2, maximumFractionDigits: 2`). `fmt` (sin decimales) se deja intacto y sigue usándose para totales grandes de dashboard (tarjetas resumen de Inicio, informes, breakdown por concepto) donde los centavos son ruido visual. Regla documentada en los comentarios de `utils.js`: `fmt` = totales grandes redondeados, `fmtDec` = cualquier pantalla donde el usuario tiene que verificar o coordinar un importe exacto con un proveedor.
- Se aplicó `fmtDec(...)` en: `ModalPago` (título, saldo, historial de pagos anteriores, input de monto), `ModalPagoMultiple` (total a confirmar y desglose por factura), `ModalAdjuntarComprobante`, `ModalSubidaMasiva`, `PanelGastos` (monto de cada gasto en la lista mobile/desktop, el "Saldo" de pagos parciales, el total de la selección para pago múltiple), `PanelFinanciero` (total a pagar, vencidos, subtotal por fecha, monto por factura), el validador "Repartido: $X / $Y ✓/⚠" al distribuir un gasto entre varias obras, el monto de los remitos provisorios, y el mensaje de WhatsApp que se comparte con el proveedor (`waGastoLink`) — este último es clave porque es literalmente el número que el proveedor recibe para coordinar el pago.
- Nuevo helper `parseMonto(v)` en `utils.js` — normaliza un monto tecleado por el usuario aceptando tanto "," como "." como separador decimal (por si algún valor llega como texto con coma decimal), antes de convertirlo a number con `parseFloat`. Se usa en todos los puntos donde se guarda un monto tecleado a mano: el modal de gasto manual, la distribución por obra, `ModalFoto` (donde antes el monto pasaba sin normalizar explícitamente — podía llegar como number si vino de la IA sin tocar, o como string si el usuario lo editó a mano en el input — ahora siempre se normaliza a number antes de guardar), y el detector de duplicados.
- También se agregó `step="0.01"` a los `<input type="number">` de monto que no lo tenían (por defecto el navegador usa `step="1"`, lo que hacía que las flechitas del input saltaran de a $1 en vez de a $0,01) — en el monto de `ModalPago`, el campo "Monto" de `FormGasto`, y los inputs de distribución por obra.
- **Lo que NO se tocó a propósito** (quedan con `fmt`, redondeado): los totales agregados de dashboard — tarjetas de `PanelInicio` ("Total gastos", "Pagado", "Gastos empresa", "Últimos gastos", etc.), los totales grandes de `ModalDetalleObra` e Informe, el breakdown por concepto, y el widget `NotifPendientes` (es un aviso general de "tenés pagos pendientes", no la pantalla donde se ejecuta el pago) — ahí mostrar centavos es ruido visual y no afecta ninguna conciliación.
- **Límite conocido, no resuelto**: no se pudo verificar desde Cowork si la columna `gastos.monto` / `pagos.monto` en Supabase es `numeric` (seguro) o `integer` (truncaría en el servidor sin importar este fix de frontend) — el MCP de Supabase conectado a esta sesión de Cowork apunta a una cuenta distinta a la que hostea la app real, y el acceso directo a la API REST del proyecto está bloqueado por la política de red de la organización. Si después de este fix algún monto SIGUE apareciendo redondeado, lo próximo a revisar es el tipo de esa columna desde el Table Editor del dashboard de Supabase (Database → Tables → `gastos`/`pagos` → columna `monto` → debería decir `numeric`, no `integer` ni `bigint`).

---

## Feature: Detección de comprobantes duplicados

Los usuarios reportaron que el sistema no avisaba si un comprobante ya estaba cargado, y de hecho pasaba: se duplicaba el mismo gasto dos veces. `buscarGastoDuplicado(gastos, form, excludeId)` (helper a nivel módulo en `GestorObras.jsx`, justo antes de `ModalGasto`) compara el `form` que se está por guardar contra los `gastos` ya cargados:

- **Match "fuerte"**: mismo `proveedor_id` + mismo `nro_comprobante` (comparación insensible a mayúsculas/espacios, ignorando string vacío). Esto prácticamente siempre es el mismo comprobante cargado dos veces, así que además de mostrarse en un banner, `ModalGasto` y `ModalFoto` piden confirmación explícita (`window.confirm`) antes de dejar guardar.
- **Match "débil"**: mismo `proveedor_id` + misma `fecha` + mismo `monto`, pero sin poder comparar por `nro_comprobante` (vacío o no coincide). Más heurístico — podría ser una coincidencia real (dos compras distintas el mismo día por el mismo monto) — así que solo se muestra un aviso, sin bloquear.

`excludeId` es el id del propio gasto cuando se está editando, para no compararse contra sí mismo.

El banner se renderiza dentro de `FormGasto` (prop `duplicado`), compartido por `ModalGasto` (carga manual) y el paso de revisión de `ModalFoto` (carga con IA) — un solo punto de implementación cubre ambos flujos de carga. Ambos modales reciben `gastos` como prop nueva (antes no lo tenían) para poder calcular el duplicado.

---

## Feature: Exportar ZIP de comprobantes para el contador (`src/exportZip.js`)

Pedido de los usuarios: poder juntar en un `.zip` las facturas y comprobantes de pago de un rango de fechas para pasárselo al contador de una sola vez, en vez de mandarlos uno por uno.

- Botón "📦 Exportar ZIP" en el header de Gastos, visible si `puedeExportarContador` (= `esAdmin` O el usuario de Marcelo — `esMarcelo = usuario?.email === 'marques.juan.marcelo@gmail.com'`, ambos calculados en `GestorObras` y pasados como prop a `PanelGastos`; Marcelo es rol `operador`, no admin, pero se lo agregó puntualmente porque es quien arma el listado para el contador). Abre `ModalExportarZip` (dos campos de fecha desde/hasta, default últimos 30 días) y llama a `exportarZipComprobantes(gastos, fechaDesde, fechaHasta, onProgress)`.
- Arma el zip 100% client-side con `jszip` (nueva dependencia, pinneada en `3.10.1` sin caret — igual que se hizo con `docx`, ni el sandbox ni el bridge del dispositivo pudieron instalarla para probarla en este entorno, así que se prefirió una versión exacta conocida antes que arriesgar una API distinta en una futura versión mayor resuelta por un caret; sí se verificó la sintaxis del archivo con `esbuild`). **Antes del próximo `npm run build` hay que correr `npm install`** para que se baje.
- Filtra `gastos` (se le pasa `todosGastos`, sin el filtro de obra activa que aplica `PanelGastos`, para no dejar afuera gastos de obras pausadas/finalizadas) por `fecha` dentro del rango, y por cada uno descarga (vía `fetch`) la factura (`imagen_url`), infiriendo la extensión real del `Content-Type` de la respuesta (las URLs de Storage no siempre la traen en el nombre). Los agrega a una carpeta `Facturas/` dentro del zip, con nombre `{fecha}_{proveedor}_{nro_comprobante}.{ext}`. **Nota**: a pedido de los usuarios este export NO incluye comprobantes de pago ni datos de obra/estado de pago — solo las facturas y sus datos (así quedó ya antes de esta sesión; el comentario del código lo deja explícito).
- Genera además `Listado para el contador.xlsx` (mismo patrón que `exportExcel.js`, usando `xlsx`) con una fila por gasto: fecha, proveedor, concepto, tipo de comprobante, nro., monto y qué archivo del zip le corresponde — así el contador tiene el detalle contable junto con los archivos.
- Un comprobante sin `imagen_url`, o que falla al descargarse, se cuenta como "faltante" y NO frena el resto del proceso — al final se avisa por toast cuántos archivos se incluyeron y cuántos quedaron afuera, en vez de fallar todo el zip por un solo archivo roto.
- La descarga se dispara client-side con un link temporal (`URL.createObjectURL` + click programático), mismo patrón que usa `XLSX.writeFile` en `exportExcel.js` para los otros exports.
- **Limitación conocida**: para rangos con muchos comprobantes esto puede tardar (descarga secuencial, un archivo a la vez, para no saturar la conexión en campo) y consume memoria del navegador porque arma el zip completo en RAM antes de descargarlo — no se probó con volúmenes grandes (cientos de comprobantes) desde este entorno.

### Excel formato ARCA "Mis Comprobantes" dentro del ZIP (agosto 2026)

Pedido del usuario: además del `Listado para el contador.xlsx` genérico, generar un Excel que replique EXACTAMENTE la planilla modelo que el contador ya usa para subir compras a ARCA (archivo de referencia que mandó el usuario: `PRE005 8.xls`, dos hojas "Ventas"/"Compras", formato `.xls` binario viejo leído con `xlrd` para sacar los encabezados — no es un `.xlsx`).

- Se agrega dentro de `exportarZipComprobantes()` un archivo más al zip: `Compras para ARCA (Mis Comprobantes).xlsx`, con dos hojas armadas con `XLSX.utils.aoa_to_sheet` (no `json_to_sheet`, porque la planilla modelo tiene columnas con encabezado vacío/repetido y `json_to_sheet` no soporta claves duplicadas):
  - **"Ventas"**: solo encabezados (34 columnas, copiados tal cual de la planilla modelo) — SEATE no factura ventas por este circuito, decisión confirmada con el usuario.
  - **"Compras"**: encabezados (36 columnas) + una fila por cada gasto del rango exportado.
- **Principio rector: nunca inventar un dato.** Se completan solo las columnas para las que gestor-obras tiene información real; el resto queda en blanco a propósito para que el contador lo complete a mano. Mapeo columna → dato:
  - Fecha de Emisión ← `gasto.fecha` (convertida a `DD/MM/YYYY`).
  - Tipo de Comprobante ← código numérico oficial de ARCA "Mis Comprobantes" (investigado en esta sesión, ver más abajo) según `gasto.tipo_comprobante`.
  - Punto de Venta / Número / Número Hasta ← se intenta separar `gasto.nro_comprobante` con el patrón `NNNN-NNNNNNNN`; si no matchea ese formato (frecuente porque `nro_comprobante` viene de una extracción por IA desde una foto, texto libre) se dejan las tres columnas en blanco en vez de adivinar.
  - CUIT del Proveedor / Razón social ← `proveedores.cuit` (solo dígitos, sin guiones) / `proveedores.nombre`.
  - Cotización ← siempre `1` (todo en pesos). Moneda ← siempre `"$"`.
  - Si `discrimina_iva`: `IVA 21%` ← `iva_monto`, `Neto Grav. IVA 21%` ← `monto - iva_monto`, `Importe Neto` ← lo mismo. Si no discrimina: `Importe Neto` ← `monto`, columnas de IVA en blanco. El resto de las alícuotas (0%/2,5%/5%/10,5%/27%) siempre en blanco — gestor-obras no las distingue.
  - Importe Total del Comprobante ← `gasto.monto`.
  - Número de CAI, Impuestos Internos/No Gravado, Importe Exento, IVA Inscripto, Importe Reg Esp 1-4, Código de Concepto/Artículo, Provincia IIBB ← siempre en blanco (no son datos que gestor-obras recolecte).
- **Códigos de "Tipo de Comprobante" usados** (investigados por Claude vía búsqueda web en esta sesión, cruzando la tabla oficial `CbteTipo` de AFIP/WSFEv1 con la guía de importación de "Mis Comprobantes" de sos-contador.com.ar, que coinciden): son números simples, **sin ceros a la izquierda** (ej. Factura A = `1`, no `"001"` — ese otro formato con ceros es de un sistema distinto de AFIP, el de comprobantes preimpresos, y no aplica acá).
  - `factura_a` → `1`, `factura_b` → `6`, `factura_c` → `11`.
  - `recibo` → gestor-obras no guarda la letra (A/B/C) de un recibo, así que se infiere según `proveedores.situacion_impositiva` (mismo criterio que ya usa la app para sugerir tipo de comprobante al cargar un proveedor): `responsable_inscripto`→`4` (Recibo A), `exento`→`9` (Recibo B), `monotributo`/`consumidor_final`→`15` (Recibo C). Sin proveedor o sin situación cargada → columna en blanco.
  - `ticket` → siempre `83` (código "Tique" genérico; los códigos 81/82 son para tique-factura A/B por controlador fiscal, distinción que la app no registra).
  - `sin_comprobante` / `otro` → columna en blanco (no son comprobantes válidos para el libro de IVA).
  - **Ojo**: esto es investigación de fuentes públicas (no se pudo confirmar contra un archivo de ejemplo real ya completado, porque `PRE005 8.xls` vino vacío, solo con encabezados) — si el contador nota algún código distinto al que él usa, avisar para ajustar el mapeo.

---

## Feature: Tarjeta de Crédito/Débito

### Medios de pago en `constants.js`
```js
export const MEDIOS_PAGO = [
  { value: 'transferencia',   label: 'Transferencia bancaria' },
  { value: 'cheque',          label: 'Cheque' },
  { value: 'efectivo',        label: 'Efectivo' },
  { value: 'tarjeta_credito', label: 'Tarjeta de crédito' },
  { value: 'tarjeta_debito',  label: 'Tarjeta de débito' },
  { value: 'tarjeta',         label: 'Tarjeta (sin especificar)' }, // compat. registros anteriores
]
```

### Columnas nuevas en `pagos`
```sql
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS nota_tarjeta TEXT;   -- label: "VISA terminada 1234"
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS cuotas INTEGER;       -- solo crédito
```

### CHECK constraint de medio_pago actualizado
```sql
ALTER TABLE pagos DROP CONSTRAINT pagos_medio_pago_check;
ALTER TABLE pagos ADD CONSTRAINT pagos_medio_pago_check
  CHECK (medio_pago IN ('transferencia', 'cheque', 'efectivo', 'tarjeta', 'tarjeta_credito', 'tarjeta_debito'));
```

### UI en modales de pago
- Cuando medio = `tarjeta_credito` o `tarjeta_debito`: muestra banco + campo `nota_tarjeta`
- Cuando medio = `tarjeta_credito`: además muestra campo `cuotas`
- El payload solo incluye `nota_tarjeta`/`cuotas` si tienen valor (evita 400 si no existe la columna)

---

## Feature: Seguros — Control de Pólizas por Obra

Módulo standalone en `src/Seguros.jsx` (mismo patrón que `CuentaCorriente.jsx`: hooks propios, sin depender del estado de `GestorObras.jsx`). Se accede vía botón "🛡️ Seguros" en la topbar desktop o desde "Más" en mobile (`panel === 'seguros'`).

**Origen:** integración de un proyecto viejo (`seate-polizas`, standalone, Supabase separado `pkjibantkftjcqxldzim`) que hacía lo mismo pero sin ligar a las obras reales de gestor-obras. Se unificó todo a la base de gestor-obras (`oyqmowolwwjjuarxttuh`).

### Por qué existe
SEATE presenta garantías de seguro de caución ante organismos públicos (IPRODA, EBY, UCEF, Muni. Posadas, Vialidad Provincial) en distintas etapas de una obra: Mantenimiento de Oferta (mientras se licita), Ejecución de Contrato (al ganar y firmar), Fondo de Reparo (garantía posterior a la recepción). El objetivo es no seguir pagando una póliza que ya no corresponde, y llevar la cuenta corriente con cada aseguradora/corredor.

### Columnas en `obras` (agregadas para Seguros)
- `organismo TEXT` — IPRODA / EBY / UCEF / MUNI_POSADAS / VIALIDAD / Privado / Otro. **Legacy** desde setiembre 2026 (ver sección de abajo) — sigue existiendo la columna y se sigue completando en el alta rápida por IA, pero el alta manual ya no la pide.
- `monto_contrato NUMERIC` — monto del contrato/licitación (distinto de `presupuesto`, que es para seguimiento de gastos)
- `etapa TEXT DEFAULT 'ejecucion'` CHECK IN ('oferta', 'ejecucion') — separa obras que todavía están en licitación de las adjudicadas/en curso. **Importante (actualizado, ver sección "Obras 'en oferta' visibles..." más abajo):** una obra "en oferta" SÍ se ve en el panel de Obras (con un cartel de aviso) pero no puede recibir gastos ni aparece en dropdowns de gastos/finanzas ni en `CuentaCorriente.jsx` hasta que se marca "adjudicada" (pasa a `etapa='ejecucion'`) desde Seguros. El valor `DEFAULT 'ejecucion'` de la columna quedó como estaba (por compatibilidad con filas viejas sin valor explícito), pero **ninguno de los dos paneles depende de ese default** — los dos mandan `etapa` explícito en el INSERT, calculado con `etapaInicial()` (ver sección "Modal de obra unificado" más abajo).
- `estado_licitacion TEXT DEFAULT 'en_curso'` CHECK IN ('en_curso', 'recepcion_provisoria', 'recepcion_definitiva') — dispara las alertas de baja de póliza. Una obra es "vigente" (vista default de Seguros) mientras no llegue a `recepcion_definitiva`.
- `recepcion_provisoria_url TEXT`, `recepcion_definitiva_url TEXT` — foto/PDF del acta de recepción de obra firmada con el organismo, cargada vía `ModalRecepcionObra` al marcar cada etapa. Es el documento que después se le presenta a la aseguradora para pedir la baja.

### Modal de obra unificado — `ModalObraCompartido.jsx` (setiembre 2026)
Antes había dos modales de alta de obra completamente separados y con campos distintos: `ModalObra` en `GestorObras.jsx` (pedía cliente vinculado, no pedía monto de contrato) y `ModalNuevaObraLicitacion` en `Seguros.jsx` (pedía `organismo` en texto libre, no pedía cliente). Cada uno decidía la etapa inicial a su manera — GestorObras ni la mandaba (quedaba en el `DEFAULT 'ejecucion'` de la columna), Seguros la mandaba fija en `'oferta'` — lo que llevó a que una obra pudiera terminar "en ejecución" sin haber pasado nunca por "oferta" ni por la carga de la garantía de oferta (ver alerta `obrasSinGarantiaAdjudicada` más abajo). Se unificó todo en un solo archivo nuevo, `src/ModalObraCompartido.jsx`, que exporta:
- `ModalObra({ itemEdit, clientes, onClose, onGuardar })` — un solo formulario (nombre, cliente, presupuesto, monto de contrato, estado, "requiere garantías de seguro", "requiere garantía de OFERTA para licitar" — este segundo solo se ve si el primero está tildado, ver más abajo —, "excluir de gastos generales") usado tanto por el botón "Nueva obra" del panel Obras como por "+ Obra en oferta" de Seguros. Ambos paneles le pasan su propia lista de `clientes` (Seguros la carga con el nuevo hook liviano `useClientesSeguros()`, ya que antes no tenía ninguna lista de clientes propia).
- `etapaInicial(requierePoliza, requiereGarantiaOferta)` — la única función que decide la etapa de una obra nueva: `'oferta'` solo si requiere pólizas EN GENERAL **y además** requiere garantía de oferta específicamente; `'ejecucion'` en cualquier otro caso. La llaman los dos `onGuardar` (el de `GestorObras.jsx` y el `crearObra` de `Seguros.jsx`) en el momento de crear, nunca al editar.

Este archivo no importa nada de `GestorObras.jsx` ni de `Seguros.jsx` (y viceversa) — solo de `constants.js` — a propósito, para no repetir el import circular que rompió la app con `exportSegurosExcel.js` (ver "Bugs resueltos"). Por eso también tiene sus propias copias chicas de `Modal`/`Campo`/`inputSt` en vez de importarlas de cualquiera de los dos paneles.

**Efecto visible:** si ahora creás una obra desde el panel de Obras dejando tildadas "Requiere garantías de seguro" Y "Requiere garantía de oferta para licitar" (ambas por default), la obra arranca en etapa "oferta". Si destildás cualquiera de las dos, arranca directo en ejecución. Esto es intencional (pedido explícito del usuario, setiembre 2026) para que la etapa refleje si la obra realmente depende de ganar una licitación con garantía de oferta — no desde qué panel se creó la obra, y tampoco simplemente si va a necesitar alguna póliza en algún momento (ver sección siguiente sobre `requiere_garantia_oferta`).

### Obras "en oferta" visibles en el panel de Obras, pero sin poder recibir gastos (setiembre 2026)
Primera versión de este cambio: una obra en "oferta" era invisible en TODO el resto de la app (`useObras()` filtraba `.neq('etapa','oferta')` a nivel de query). El usuario pidió un punto medio — quería verla en el panel de Obras (para no olvidarse de gestionar la garantía) pero sin que se le pudieran cargar gastos todavía (no tiene sentido imputar plata a un contrato que no se ganó). Quedó así:
- `useObras()` ya NO filtra por etapa — carga todas las obras (oferta y ejecución) en el estado `obras` de `GestorObras()`.
- `obrasOperativas = obras.filter(o => o.etapa !== 'oferta')` (calculado una vez en `GestorObras()`) es la lista que se le pasa a todo lo que es operativo de gastos/finanzas: `PanelGastos`, `PanelFinanciero`, `PanelInforme`, `PanelInicio`, `MobileHeaderStats`, y los modales `ModalGasto`/`ModalFoto` (incluye sus desplegables de obra y el de distribución multi-obra, que reciben `obras` como prop desde ahí). Una obra en oferta nunca puede terminar en un `gastos.obra_id`, así que tampoco entra al prorrateo de gastos generales (ese cálculo solo mira `obra_id`s que ya tienen gastos reales).
- `PanelObras` (el único que sigue recibiendo la lista completa `obras`, sin filtrar) le agrega a la card de una obra en oferta (`o.etapa === 'oferta'`) un cartel ámbar "📋 En oferta — falta cargar la garantía y/o adjudicarla desde Seguros. Todavía no se le pueden cargar gastos." en vez del monto/gastos habituales, y el click de la card (que normalmente lleva al filtro de Gastos de esa obra) queda deshabilitado para estas — no tendría nada que mostrar.
- La lógica es la contraparte, del lado de Obras/Gastos, de la alerta `obrasSinGarantiaAdjudicada` que ya existía del lado de Seguros (ver esa sección) — dos vistas distintas de la misma idea: que una obra sin garantía cargada no quede nunca "perdida" para el usuario.

### `organismo` vs. cliente vinculado (`obras.cliente_id`) — de dónde sacar "quién es" la obra
`organismo` es un campo legacy de Seguros que en la práctica **casi nadie completaba a mano** (se confirmó por SQL: en las 30 obras más recientes, `organismo` estaba `null` en todas). Desde setiembre 2026 el alta manual de obra (los dos paneles, vía `ModalObraCompartido.jsx`) ya no lo pide — pide directamente el cliente vinculado (`obras.cliente_id`, FK a `clientes`, el mismo campo "Cliente" del panel de Obras). Para obra pública ese cliente ES el organismo (ej. "ENTIDAD BINACIONAL YACYRETA", "IPRODHA", "USCEPP"), y para obra privada es el cliente real. `organismo` sigue existiendo en la tabla y todavía se completa (como texto libre leído por la IA) en el alta rápida desde `ModalPoliza` → "+ Crear obra" (cuando la IA detecta una obra que no existe todavía al leer una póliza) — ahí no hay forma de mapear con certeza el texto que lee la IA contra un `cliente_id` exacto, así que se guarda tal cual. Por eso Seguros usa `nombreOrganismoObra(obra)` (en `Seguros.jsx`) como fuente de "quién es la obra": prioriza `obra.clientes.nombre` (requiere que la query de `useObrasSeguros()` haga `select('*, clientes(nombre)')`) y sólo cae a `organismo` como fallback legacy si no hay cliente vinculado. `FilaObra` y el `<select>` de obra en `ModalPoliza` muestran este valor en vez de `obra.organismo` directamente. `candidatasObra()` (detección de obra duplicada) también compara el `organismo` que lee la IA contra este mismo nombre (fuzzy match), no sólo contra el enum `organismo`.

### Tabla `polizas`
`obra_id` (FK), `tipo_cobertura` (mantenimiento_oferta / ejecucion_contrato / anticipo_financiero / fondo_reparo / responsabilidad_civil / otro), `aseguradora` (compañía), `corredor` (broker/productor — **distinto** de la aseguradora), `nro_poliza`, `monto_asegurado`, `prima` (costo que cobra la aseguradora), `fecha_emision`, `fecha_inicio`, `fecha_vencimiento`, `estado_admin` (activa / baja_presentada / dada_de_baja / vencida — ver más abajo), `notas`.

Campos "experto en seguros" (agregados en la 2ª ronda): `tipo_vigencia` (unica_vez = vigente hasta un hito de obra, no se renueva por plazo — típico en las 3 garantías de obra; renovable = vigencia por período fijo, ej. 12 meses, típico en responsabilidad_civil), `requiere_final_obra` (boolean — si para dar de baja hace falta presentarle a la aseguradora el acta de recepción de obra), `clausula_repeticion` (sin_repeticion / con_repeticion / no_especifica — si la aseguradora renuncia a repetir contra el tomador), `clausulas_especiales` (texto libre), `descripcion_ia` (resumen de 1-2 oraciones generado por la IA al leer el documento, editable a mano). Los valores por defecto de `tipo_vigencia`/`requiere_final_obra` según `tipo_cobertura` están en `inferirVigenciaYFinalObra()` en `Seguros.jsx` — la IA puede sugerir otra cosa si el texto de la póliza lo indica explícitamente.

Campos de auto-renovación por período (3ª ronda): `se_autorenueva` (boolean/null) y `duracion_periodo_dias` (integer) — ver sección dedicada más abajo.

`ModalPoliza` sirve tanto para alta como edición (prop `polizaExistente`; el handler `guardarPoliza` en `Seguros.jsx` hace PATCH si `form.id` viene seteado, POST si no). Eliminar una póliza (`eliminarPoliza`) borra sus `poliza_documentos` y desvincula sus `pagos_poliza` — los `gastos`/`pagos` ya generados por esos pagos NO se borran (la plata ya se gastó, queda en la contabilidad de la obra).

### Estados administrativos (`estado_admin`) y el flujo de baja
`activa` → `baja_presentada` (ya se le mandó a la aseguradora la recepción de obra pidiendo la baja, vía `ModalRecepcionObra`/botón "Marcar baja presentada") → `dada_de_baja` (la aseguradora YA confirmó la baja — se registra con `ModalConfirmarBaja`, opcionalmente adjuntando su nota firmada como documento tipo `baja_aseguradora`). `vencida` es un cierre aparte para plazo vencido sin gestión. Esto distingue explícitamente "se lo pedimos" de "ya lo confirmaron".

### Tabla `poliza_documentos`
`poliza_id` (FK, ON DELETE tratado a mano al eliminar la póliza), `tipo` (poliza / cuponera / factura / comprobante_pago / endoso / certificacion / legalizacion / baja_aseguradora / otro), `archivo_url`, `nombre_archivo`. `ListaDocumentos` en `Seguros.jsx` los lista con link "⬇️ Descargar" (atributo `download` en el `<a>`).

**`comprobante_pago` NO es seleccionable en el modal genérico "+ Documento"** (`TIPOS_DOCUMENTO_POLIZA_SELECCIONABLES` filtra ese valor) — ese tipo de documento se adjunta exclusivamente desde "+ Registrar pago" (`ModalPagoPoliza`), donde queda en `pagos_poliza.comprobante_url` en vez de en esta tabla. Antes el modal genérico abría con ese tipo preseleccionado por defecto, lo que invitaba a cargar el comprobante en el lugar equivocado — se corrigió.

**Descargar todo (.zip):** `descargarDocumentosZip(poliza, pagos)` en `Seguros.jsx` junta todos los `poliza_documentos` de la póliza MÁS los `comprobante_url` de sus `pagos_poliza`, los empaqueta con JSZip (cargado dinámicamente desde `https://esm.sh/jszip` — no es una dependencia del proyecto) y descarga un único `.zip` nombrado `{obra}_poliza_{nro}.zip`, con cada archivo dentro nombrado `{obra}_{nroPoliza}_{tipo}_N.ext` para poder identificarlos sin abrirlos. Botón "⬇️ Descargar todo (.zip)" junto a `ListaDocumentos` en `FilaPoliza` (solo aparece si hay algo para descargar).

### Tabla `pagos_poliza` — cuenta corriente con aseguradoras/corredores
`poliza_id`, `fecha_pago`, `monto`, `medio_pago`, `banco_id`, `nro_operacion`, `comprobante_url`, `observaciones`, `gasto_id` (FK a `gastos` — ver abajo). La vista "💳 Cuenta corriente" de `Seguros.jsx` (`CuentaCorrienteAseguradoras`) agrupa pólizas + pagos por `aseguradora` o por `corredor` (toggle), mostrando prima total, pagado y saldo teórico por grupo y por póliza (`agruparPolizas()`). Arriba del toggle, `ResumenSubtotales` muestra siempre — sin importar qué toggle esté activo — dos mini-tablas lado a lado con el saldo teórico subtotal por aseguradora Y por corredor a la vez, para no tener que ir cambiando la vista para comparar ambos.

La prima "vigente" que entra en estos totales no es solo `polizas.prima` — es `primaConRenovaciones(poliza, renovaciones)` = prima original + toda renovación de período no anulada (ver sección siguiente).

### Pago de póliza = gasto de la obra
`ModalPagoPoliza` → `guardarPagoPoliza()` en `Seguros.jsx`: al registrar un pago de prima, se crea automáticamente (1) un `gastos` con `concepto: 'seguros'` y `pagado: true` en la obra correspondiente (SALVO que ya exista una factura pendiente para esa póliza, ver abajo), (2) un `pagos` linkeado a ese gasto, y (3) el `pagos_poliza` (linkeado al `gasto_id`). Así el pago aparece tanto en la contabilidad normal de la obra como en la cuenta corriente con la aseguradora. Requiere el concepto `'seguros'` en el CHECK de `gastos.concepto` y en `constants.js` (`CONCEPTOS`, `CONCEPTO_LABELS`, `CONCEPTO_COLORS`, `CONCEPTO_ICONS`).

El campo "Comprobante de pago o cuponera" de `ModalPagoPoliza` acepta tanto un comprobante de transferencia como la cuponera de pago de la aseguradora — en ambos casos se lee con la misma IA que analiza comprobantes de gasto (`tipoAnalisis: 'comprobante'`) para autocompletar fecha/monto, y si el monto leído difiere >2% de `primaConRenovaciones()` de la póliza se muestra una advertencia (puede ser normal — pago parcial, reajuste — pero conviene revisarlo). Esto cubre el caso de pagar directo con el cupón sin que exista una factura separada.

### Factura de póliza → gasto pendiente, reconciliado al pagar
Botón dedicado "+ Factura" en `FilaPoliza` (separado de "+ Documento" y "+ Registrar pago" — antes todo entraba por un solo modal genérico y se prestaba a confusión/duplicación). `ModalFacturaPoliza` sube el archivo, lo analiza con la misma IA de comprobantes (`tipoAnalisis: 'comprobante'`, autocompleta fecha/monto/nro/tipo) y al guardar (`guardarFactura()`):
1. Crea un `gastos` con `concepto: 'seguros'` y **`pagado: false`** (deuda pendiente, no un pago ya hecho).
2. Crea el `poliza_documentos` (`tipo: 'factura'`) con `gasto_id` apuntando a ese gasto pendiente.

Cuando después se registra el pago real (`guardarPagoPoliza()`), primero busca si hay algún `poliza_documentos` tipo `factura` de esa póliza con un `gasto_id` cuyo gasto siga `pagado: false` — si lo hay, **liquida ESE gasto** (PATCH `pagado: true` + monto/fecha del pago real) en vez de crear uno nuevo, para no duplicar el gasto de la obra. Si no hay factura pendiente, crea un gasto nuevo como antes.

Por qué existe: la prima que la IA lee de la carátula de la póliza no siempre es información confiable (ver `prima_fuente` abajo) — la factura/cuponera real de la aseguradora es la fuente de verdad del monto a pagar, y puede no coincidir con lo que dice la póliza.

### `prima_fuente` — trazabilidad del monto de prima (evita que la IA invente un número)
Bug real detectado: en una póliza de Anticipo Financiero sin una prima explícitamente rotulada, la IA tomó el valor "T.C.N." (Total Costo Neto, un dato de desglose de gastos del corredor — Gtos Explot./Gtos Adquis./Gtos Cobranza/T.C.N. — que no es necesariamente la prima cobrada al tomador) y lo cargó como si fuera la prima, sin dejar rastro de por qué. El usuario no podía verificar de dónde había salido ese número.

Fix: se agregó `prima_fuente TEXT` a `polizas` — la IA debe copiar ahí literalmente la etiqueta del documento de la que sacó el valor de `prima` (ej. "PRIMA", "PREMIO TOTAL", "T.C.N."), y el prompt ahora exige que `prima` quede en `null` si no hay una etiqueta EXPLÍCITA de "PRIMA"/"PREMIO" — preferible `null` a un dato inventado. En el formulario (`ModalPoliza`) y en `detectarAdvertencias()`, si `prima_fuente` no matchea `/PRIMA|PREMIO/i` se muestra una advertencia ámbar pidiendo verificar el monto contra la factura o cuponera real.

### Auto-renovación por períodos (`se_autorenueva` / `duracion_periodo_dias`) y tabla `renovaciones_poliza`
Muchas cauciones nominalmente "hasta la recepción" (`ejecucion_contrato`, `anticipo_financiero`, `fondo_reparo` — NO `mantenimiento_oferta` ni `responsabilidad_civil`, ver `APLICA_AUTORENOVACION_PERIODOS` en `Seguros.jsx`) en realidad las emite la aseguradora por períodos fijos cortos (90/180 días, "reajustable trimestralmente"). Si el período se cumple sin presentar la recepción de obra, la aseguradora renueva sola y cobra una prima NUEVA por el siguiente período — y así sucesivamente hasta que se presenta la recepción. Si la recepción tiene fecha anterior al corte de un período ya vencido, en muchos casos la aseguradora anula esa renovación retroactivamente y no la cobra.

Modelado: `polizas.se_autorenueva` (boolean/null) y `polizas.duracion_periodo_dias` (integer) — cargados a mano o por IA (prompt del Edge Function instruye a la IA a responder SIEMPRE `false` para mantenimiento_oferta/responsabilidad_civil sin importar el texto). Tabla nueva `renovaciones_poliza` (el lado del CARGO/deuda, separado de `pagos_poliza` que es el lado del pago): `poliza_id`, `periodo_desde`, `periodo_hasta`, `monto` (propio, NO se asume igual a `polizas.prima` — puede diferir por reajuste), `anulada` (boolean, true = anulación retroactiva confirmada), `motivo_anulacion`, `gasto_id` (sin uso por ahora), `observaciones`.

`primaConRenovaciones(poliza, renovaciones)` = `polizas.prima` + suma de renovaciones no anuladas — es la prima "vigente" real, usada en `FilaPoliza`, `agruparPolizas()`/cuenta corriente y en la comparación de `ModalPagoPoliza`. `calcularAlertas()` usa el corte de la ÚLTIMA renovación vigente (si hay alguna) en vez de `fecha_vencimiento` a secas, y da acción `'registrar_renovacion'` cuando el corte ya pasó — botón "Registrar cargo de renovación" → `ModalRenovacionPoliza` → `guardarRenovacion()`. Desde `FilaPoliza` (expandida) se puede anular una renovación (`onAnularRenovacion` → `window.prompt` con el motivo → PATCH `anulada: true`).

### Motor de alertas administrativas (`calcularAlertas` en `Seguros.jsx`)
Una póliza `activa` entra en alerta roja ("presentar_baja") cuando: `mantenimiento_oferta` y la obra ya pasó a `etapa='ejecucion'`; `ejecucion_contrato` (Cumplimiento de Contrato) y la obra está en `recepcion_provisoria`/`recepcion_definitiva`; `anticipo_financiero` y la obra está en `recepcion_definitiva` (con aviso distinto: verificar amortización, no es automático como cumplimiento); `fondo_reparo` y la obra está en `recepcion_definitiva`; la obra tiene `estado='finalizada'` en el panel principal de Obras (chequeo independiente de `estado_licitacion`, para pescar casos donde el equipo ya dio la obra por terminada en el día a día sin tramitar la baja en Seguros); o el vencimiento ya pasó o está a ≤30 días. Una póliza `baja_presentada` siempre alerta con acción "confirmar_baja".

### Alerta: obra adjudicada sin ninguna póliza cargada (setiembre 2026)
Contrapunto detectado por el usuario: una obra no debería llegar a `etapa='ejecucion'` sin haber presentado antes la garantía de oferta, pero el sistema no tenía ningún control — las obras creadas desde el panel principal (`GestorObras.jsx`) arrancan directo en `ejecucion` (nunca pasan por `oferta`), y "Marcar adjudicada" en Seguros tampoco chequeaba si ya había alguna póliza cargada. Se decidió (a pedido del usuario) NO bloquear nada — solo hacerlo imposible de no ver: `obrasSinGarantiaAdjudicada` (en el componente `Seguros`) junta las obras con `etapa==='ejecucion'`, `requiere_poliza !== false` y cero pólizas cargadas, y ese conteo se suma al cartel rojo de arriba ("⚠️ N situación(es) necesitan atención"); además cada obra afectada se marca con borde rojo y un aviso propio en `FilaObra` ("⚠️ Esta obra está adjudicada (en ejecución) pero todavía no tiene ninguna póliza cargada..."). Las obras "Sin póliza requerida" quedan afuera de este chequeo a propósito.

### Cumplimiento de Contrato vs. Anticipo Financiero (`tipo_cobertura`)
Son dos garantías DISTINTAS aunque ambas sean seguros de caución de la misma obra — error común detectado en la v1 (la IA metía "anticipo financiero" dentro de `ejecucion_contrato`). Cumplimiento (`ejecucion_contrato`, label "Cumplimiento de Contrato") garantiza que se ejecute el contrato, no se amortiza, se cancela recién en recepción. Anticipo Financiero (`anticipo_financiero`, valor nuevo) garantiza la devolución del anticipo entregado por el organismo, y se va reduciendo a medida que se descuenta de los certificados de obra — no espera a la recepción. `inferirVigenciaYFinalObra()` les da defaults distintos (`requiere_final_obra: true` para cumplimiento, `false` para anticipo).

### Cláusula de repetición — importante para no confundir
En un seguro de caución la aseguradora SIEMPRE conserva el derecho de repetir contra el tomador (SEATE) — así funciona la caución, respaldada por la contragarantía. Lo que `clausula_repeticion` busca NO es eso: es si el documento renuncia a repetir contra el ORGANISMO/COMITENTE (típico en pólizas de Responsabilidad Civil, ej. "sin derecho de repetición contra el comitente"). El prompt de la Edge Function y el label del campo en `Seguros.jsx` dejan esto explícito para no generar falsos "con_repeticion" en pólizas de caución donde no aplica.

### Matching de obra al leer una póliza con IA (evita duplicados)
`matchFuerteObra()` hace un match exacto/substring y auto-selecciona. Si no hay match fuerte, `candidatasObra()` busca obras con alguna palabra significativa en común o mismo organismo y se le muestran al usuario como pregunta ("¿Es alguna de estas la misma obra?") antes de ofrecer "+ Crear obra" — se agregó después de que la IA creara una obra duplicada ("Mojones EBY" vs. "8360 Mojones") por leer un nombre distinto para la misma obra real.

### `obras.requiere_poliza` (boolean, default true)
Para obras menores o de clientes privados que no piden garantías de seguro. Se edita con el checkbox "Requiere garantías / pólizas de seguro" en `ModalObra` — desde setiembre 2026 ese modal está en `src/ModalObraCompartido.jsx` y lo usan los dos paneles (ver esa sección más arriba). El badge "Sin póliza requerida" sigue definido en `FilaObra` pero en la práctica ya no se ve: desde setiembre 2026 estas obras se excluyen directamente de la pestaña "Obras y pólizas" (`obrasFiltradas` filtra `o.requiere_poliza !== false` antes de cualquier otro filtro) — no tienen nada para hacer ahí, así que ocultarlas fue pedido explícito del usuario en vez de mostrarlas con el badge mezcladas con las demás.

### `obras.requiere_garantia_oferta` (boolean, default true) — separado de `requiere_poliza` (setiembre 2026)
Caso real planteado por el usuario: una obra puede requerir pólizas (Responsabilidad Civil, seguro de obra, etc. una vez en marcha) sin depender de ganar una licitación con garantía de oferta primero — por ejemplo una adjudicación directa, sin proceso licitatorio. Con un solo flag (`requiere_poliza`) esa obra quedaba mal representada: o se la marcaba "no requiere póliza" (falso — sí va a necesitar RC/seguro de obra más adelante) o quedaba trabada en etapa "oferta" esperando una garantía de licitación que nunca va a existir.

Se agregó una segunda columna, independiente (migración `agregar_garantia_oferta_obras_2026-09.sql`, **pendiente de correr en el SQL Editor**):
- `requiere_poliza` sigue siendo el interruptor general: ¿esta obra se rastrea en Seguros? (si es `false`, la obra queda totalmente afuera de la pestaña "Obras y pólizas" — ver sección anterior).
- `requiere_garantia_oferta` — solo se muestra/tiene efecto en `ModalObra` cuando `requiere_poliza` está tildado. Decide únicamente si la obra tiene que ESPERAR en etapa "oferta" a que se le cargue esa garantía y se la marque adjudicada. Si está destildado (adjudicación directa u otro caso sin licitación), la obra arranca directo en "ejecución" — ya aparece en gastos/finanzas desde el momento en que se crea — pero sigue apareciendo en "Obras y pólizas" de Seguros (porque `requiere_poliza` sigue en `true`) para poder cargarle ahí, cuando corresponda, cualquier póliza puntual (RC, seguro de obra, etc.), igual que a cualquier otra obra.
- `etapaInicial(requierePoliza, requiereGarantiaOferta)` (en `ModalObraCompartido.jsx`) es la única función que combina ambos flags para decidir la etapa — ver esa sección más arriba.
- Nota: una obra así (`requiere_poliza=true`, `requiere_garantia_oferta=false`) arranca en "ejecución" sin ninguna póliza cargada todavía, así que va a aparecer inmediatamente en la alerta `obrasSinGarantiaAdjudicada` (ver esa sección) hasta que se le cargue la primera póliza que corresponda — es el comportamiento esperado, no un bug: el nombre de esa alerta quedó de cuando solo existía la garantía de oferta, pero el chequeo (`requiere_poliza !== false` + cero pólizas) sigue siendo válido para cualquier tipo de póliza pendiente.

### Cuenta corriente — desglose por movimiento y estado de pago (setiembre 2026)
La pestaña "💳 Cuenta corriente" (agrupa por aseguradora o por corredor) no muestra un solo saldo por póliza: `movimientosPoliza(poliza, renovaciones, pagos)` arma la lista de movimientos de esa póliza (la prima original + cada renovación por período no anulada, ordenados por fecha) y les asigna un estado individual (`pagado` / `parcial` / `pendiente` / `anulada`) haciendo una asignación FIFO del total pagado de la póliza (`pagos_poliza` no distingue contra qué movimiento se pagó cada pago, así que se van "llenando" los movimientos en orden cronológico con la suma total pagada hasta que se acaba). Cada movimiento en USD se convierte a pesos con `enPesos()` usando SU PROPIO tipo de cambio (ver más abajo). La vista tiene filtros (Todas / Vencidas / Por vencer / Con saldo pendiente), badges de moneda y estado por movimiento, y un botón "⬇️ Exportar a Excel" (`exportarCuentaCorrienteSeguros` en `src/exportSegurosExcel.js`) que exporta exactamente lo que se ve en pantalla — hoja "Movimientos" (uno por fila, con moneda/monto original/TC/monto en pesos/estado/pagado/saldo) y hoja "Resumen" por grupo.

### Umbral de "por vencer" editable (`configuracion_app`, setiembre 2026)
Antes el umbral de "vencimiento próximo" era una constante fija en el código (`DIAS_AVISO_VENCIMIENTO = 30`); ahora se puede cambiar desde la propia UI de "💳 Cuenta corriente" (bloque con botón "✏️ Cambiar" → "Guardar"/"Cancelar"). Se guarda en la tabla `configuracion_app` (clave `dias_aviso_vencimiento_seguros`, creada por `crear_configuracion_app_2026-09.sql` — tabla genérica clave/valor pensada para reutilizar con otros parámetros configurables a futuro). `useConfiguracionSeguros()` lee el valor al cargar Seguros y `diasAviso` se pasa como prop hacia abajo (`FilaObra` → `FilaPoliza` → `VencimientoBadge`, y también a `agruparPolizas`/`calcularAlertas`) en vez de usar la constante fija directamente.

### Pólizas en USD — moneda y tipo de cambio (setiembre 2026)
Algunas pólizas (ej. RC de obras EBY) vienen en dólares, no en pesos. `polizas.monto_asegurado`/`polizas.prima` y `renovaciones_poliza.monto` se siguen cargando SIEMPRE en la moneda original del documento — nunca se convierten al guardar. Lo que se agregó (`agregar_moneda_polizas_2026-09.sql`) es de qué moneda se trata y el tipo de cambio usado para mostrar el equivalente en pesos:
- `polizas.moneda` (`'ARS'` default o `'USD'`), `polizas.tipo_cambio` + `polizas.fecha_tipo_cambio` (para la prima original, cargados en la emisión).
- `renovaciones_poliza.tipo_cambio` + `renovaciones_poliza.fecha_tipo_cambio` — cada renovación por período tiene el suyo propio, porque puede pasar tiempo entre una renovación y otra y el dólar puede haber cambiado (decisión explícita del usuario: "el tipo de cambio del día de cada movimiento", no uno fijo por póliza).
- `pagos_poliza` NO lleva moneda/tipo de cambio propios — son pesos reales que ya salieron del banco, no hace falta convertir nada ahí.
- `enPesos(monto, moneda, tipoCambio)` es el helper que hace la conversión para mostrar (nunca se persiste el valor convertido).
- **Tipo de cambio "automático + editable"**: `buscarTipoCambioOficial()` llama a `https://dolarapi.com/v1/dolares/oficial` (replica el oficial de Banco Nación) desde el navegador del usuario y precarga el valor `venta`, pero SIEMPRE queda en un input editable antes de guardar — mismo principio anti-alucinación que `prima_fuente`: nunca un número sin que el usuario lo pueda verificar/corregir. Botón "🔄 Oficial hoy" en `ModalPoliza` (emisión) y en `ModalRenovacionPoliza` (cada renovación).
- **La IA (Edge Function `analizar-comprobante`) solo identifica la moneda, nunca calcula ni inventa el tipo de cambio.** El prompt le pide mirar el símbolo/texto junto a cada monto ("USD"/"U$S"/"US$"/"U$s"/"Dólares" = USD; "$"/"Pesos"/sin símbolo = ARS default) y devolver `moneda`, dejando `monto_asegurado`/`prima` "en la moneda que indicó" — el tipo de cambio se busca aparte, en el frontend, nunca desde la IA.
- `detectarAdvertencias()` marca en amarillo si `moneda === 'USD'` y no hay `tipo_cambio` cargado.
- **Operativo: la Edge Function se despliega APARTE del build normal.** `build-y-subir.bat` (push a GitHub → Cloudflare Pages redeploya el frontend solo) no toca la función de IA — para que la IA detecte moneda hace falta además `npx supabase functions deploy analizar-comprobante --project-ref oyqmowolwwjjuarttuh` desde la carpeta `src/` (o doble click en `deploy-function.bat`, que hace `cd /d %~dp0src` así que no importa desde dónde se lo abra). Si el CLI tira 403 "account does not have the necessary privileges" con el token ya autenticado (no es error de login), correr `npx supabase login` de nuevo desde esa misma carpeta para refrescar el token y reintentar.

### Filtro "Sin póliza cargada" / "Con póliza" (setiembre 2026)
Antes todas las obras (con o sin pólizas ya cargadas) aparecían mezcladas en la misma lista de "Obras y pólizas", lo que hacía difícil encontrar cuáles todavía necesitaban que se les pida una póliza. Se agregó un segundo grupo de botones (al lado del filtro de etapa existente) con tres opciones: "Con o sin póliza" (todas, default), "⚠️ Sin póliza cargada" (`polizas.some(p => p.obra_id === o.id)` es false) y "✅ Con póliza" (ese `some` da true). Es un filtro más, no un tab aparte — se combina con el de etapa y con "Mostrar obras finalizadas" tal como ya se combinaban esos dos entre sí. Estado en `filtroPoliza` (`'todas' | 'sin' | 'con'`).

### Revisión "experto" (`detectarAdvertencias` en `Seguros.jsx`)
Aparte de las alertas administrativas (rojas), hay un chequeo de calidad de datos (ámbar, "🔎 Revisión de datos") client-side: falta aseguradora/nro_poliza/monto, corredor = aseguradora (posible error de carga), vencimiento anterior al inicio de vigencia, póliza renovable sin fecha de vencimiento, monto asegurado muy bajo respecto al monto de contrato de la obra. No depende de la IA — corre siempre sobre los datos ya guardados.

### Carga de pólizas con IA "experta" (foto/PDF)
`ModalPoliza` reutiliza el patrón de `ModalFoto` (compresión de imagen, PDF en base64, límite 25MB). Llama a la Edge Function `analizar-comprobante` con `tipoAnalisis: 'poliza'`, que usa un prompt de "experto en seguros de caución" (no solo transcribe, interpreta el tipo de garantía) para extraer: aseguradora, corredor, nro_poliza, tiene_endoso, tipo_cobertura, tipo_vigencia, requiere_final_obra, clausula_repeticion, clausulas_especiales, descripcion_ia, tomador, organismo, obra, monto_asegurado, prima, fecha_emision, fecha_inicio, fecha_vencimiento. Si la IA detecta una obra que no existe en la base, se ofrece crearla al vuelo (etapa `oferta`).

### Vista `obras_resumen` (compartida con el panel principal)
Se extendió (`create or replace view`, columnas nuevas al final para no romper el orden existente) para exponer `etapa`, `organismo`, `estado_licitacion`, `monto_contrato` — necesario para poder filtrar `etapa != 'oferta'` desde `GestorObras.jsx` sin tocar la tabla base.

### UI: obras y pólizas colapsadas por defecto
`FilaObra` y `FilaPoliza` arrancan con `expandido = false` (antes las pólizas dentro de una obra expandida se mostraban siempre completas, haciendo la vista muy larga con varias pólizas). Colapsada, una póliza solo muestra nro/aseguradora/corredor, badge de estado, tipo de cobertura y vencimiento — más las alertas rojas si las hay (esas se muestran siempre, plegado o no). El resto (descripción IA, badges secundarios, montos, cláusulas, documentos, botones de acción) aparece al hacer click en la fila o en "▸ Ver más detalle".

### Limitaciones conocidas
- Sin suscripción Realtime propia (a diferencia del canal `sync-multi-device` de `GestorObras.jsx`): los cambios se reflejan al instante en la pestaña donde se hicieron, pero otro dispositivo necesita recargar la sección para verlos.
- `PanelObras` (panel "Obras" normal) todavía no muestra visualmente `etapa`/`organismo`/`monto_contrato` en las cards, aunque la vista ya expone esas columnas — solo falta agregarlas a la UI si se quiere ese detalle ahí también (hoy sólo se ve en Seguros).
- Los datos del proyecto viejo `seate-polizas` (Supabase `pkjibantkftjcqxldzim`, pausado por límite de plan free) no se migraron: no se pudo restaurar sin pausar otro proyecto activo (`parmetal-crm`). Si tenía cargas reales, migrarlas a mano o liberar un proyecto activo y reintentar.
- Se detectó y corrigió manualmente un caso de obra duplicada por el flujo de auto-creación de obra de la IA ("8360 Mojones" / "Mojones EBY" — mismo organismo, mismo proyecto real cargado dos veces). Si la IA sugiere crear una obra nueva, conviene revisar primero si no es una obra ya cargada con otro nombre antes de aceptar "+ Crear obra".

---

## Feature: Relevamientos y Cómputos — Etapa Inicial (`src/Relevamientos.jsx`)

Módulo separado (armado inicialmente con Gemini, integrado a `GestorObras.jsx` como panel `relevamientos`) para la etapa de relevamiento de campo y cómputo/presupuesto previa a una obra — pensado para informes técnicos y presupuestos a organismos públicos (IPRODHA, USSECP/UCEF, EBY, Vialidad, Muni. Posadas), en base a los modelos reales de SEATE (INFOREM en Word, PRESUP en Excel) y al catálogo de precios "Revista Cifras".

**Tablas** (aditivas, con RLS `solo_autenticados`): `relevamientos` (datos generales: título, organismo, escuela/lugar, GPS, `estado`), `relevamiento_items` (ítems de cómputo por sector: `sector`, `codigo_item`/`rubro`/`descripcion_item` de Cifras, `unidad`, `cantidad`, `computo_total`, `riesgo` — semáforo urgente/funcional/mantenimiento, agregado en esta etapa —, `es_restauracion`, `foto_url`, `notas_campo`), `relevamiento_mensajes` (historial de auditoría del chat con el "especialista", con columna `sector` agregada en esta etapa para poder scopearlo — antes no existía), `catalogo_cifras` (234 ítems con precio material/mano de obra cargados desde la Revista Cifras Agosto 2026). Bucket de Storage `relevamientos-fotos` (público, mismo patrón que `comprobantes`/`polizas-documentos`).

**Flujo**: por cada "sector/ambiente" creado dinámicamente (sin sectores predefinidos), el técnico carga fotos (paneo general + detalle, sube de verdad a Storage) y dicta o escribe un relato (Web Speech API); "Procesar IA" genera ítems de cómputo y un mensaje de auditoría, y el chat permite corregir en lenguaje natural (ej. "se puede volver a amurar" reemplaza la provisión nueva por reparación). Todo eso (sectores derivados de sus ítems, fotos, ítems, mensajes) se persiste de verdad contra las tablas de arriba — al principio (versión de Gemini) todo vivía solo en `useState` de React y se perdía al recargar la página; se corrigió en esta etapa.

**IA real conectada** (etapa siguiente a la simulación inicial de Gemini): `handleProcesarIA` ya no es un `if/else` por palabras clave — llama a `analizar-comprobante` con `tipoAnalisis: 'relevamiento'` (nuevo modo, junto a `comprobante`/`poliza`), que: (1) trae el catálogo completo de `catalogo_cifras` (234 ítems) server-side, (2) descarga las fotos del sector (ya subidas a `relevamientos-fotos` por el frontend) y las manda a Claude Vision junto con el relato, (3) le pide a un "equipo de especialistas" (mismo criterio que la simulación original: sanitarista, cubiertas/zinguería, aberturas/vidriería, electromecánico, mampostería, obras civiles/cauces EBY) que identifique trabajos y los matchee contra el catálogo, (4) el ítem que devuelve la IA solo puede citar un `codigo_item` que existe LITERALMENTE en el catálogo pasado — si no hay buen match, tiene que dejarlo en `null` en vez de inventar uno (mismo principio anti-alucinación que `prima_fuente` en Seguros). El precio (`precio_unitario`/`subtotal`) se completa server-side desde el catálogo real, nunca desde lo que "recuerde" el modelo — con esto la tarea de cómputo con precios reales quedó resuelta para los ítems que vienen de la IA. La carga manual ("+ Agregar Ítem Manual") también puede traer precio real, en 2 pasos: primero se elige un RUBRO REAL del catálogo (los 20 rubros que existen de verdad en `catalogo_cifras` — no la lista vieja de 13 hardcodeada a mano, que no coincidía exactamente, ej. el catálogo separa "INSTALACION SANITARIA / INCENDIO", "CIELORRASOS", "CONTRAPISOS", "ZOCALOS" como rubros propios); recién ahí aparece un segundo `<select>` con TODOS los ítems de ese rubro (no un buscador de texto libre) para poder revisarlos uno por uno y estar seguro de si el ítem que se necesita está o no en Revista Cifras antes de cargarlo como texto libre. Elegir un ítem real autocompleta rubro/unidad/precio; "Ninguno de estos" o el rubro "— No sé el rubro / no está en Cifras —" pasan a un ítem de texto libre, que se guarda sin precio. El "control de olvidos" (alertas_omision) también está conectado: si la IA nota algo típico sin verificar, se guarda como un segundo mensaje de auditoría con ⚠️. Pendiente: no se pudo probar en vivo desde este entorno (el sandbox y el bridge del dispositivo no tienen salida de red hacia el dominio de Supabase Functions) — probarlo desde la app real y revisar los logs de la función si falla algo.

**Ítems propuestos por la IA — confirmación antes de guardar** (`itemsPropuestos` en `DetalleRelevamiento`): antes, `handleProcesarIA` persistía los ítems de la IA directo en `relevamiento_items`, así que una medición mal estimada (ej. la IA calculó 45m² donde en realidad eran 35m²) quedaba guardada sin que nadie la revisara. Ahora "Procesar IA" arma la propuesta en memoria (`itemsPropuestos`, NO se guarda todavía) y se muestra debajo del botón con: la cantidad estimada en un input editable, un badge de confianza de la medición (🟢 alta / 🟡 media / 🔴 baja — vienen del campo `confianza_medicion` que ahora devuelve la Edge Function), y la `justificacion` de la IA explicando de dónde sacó el número (medida del relato, o qué referencia de escala usó en la foto — puerta ≈0.90-2.10m, ladrillo ≈0.25m, etc.). El técnico corrige la cantidad si hace falta, saca con "✕" los ítems que no correspondan, y recién con "Confirmar y guardar" se llama a `_persistirItem` — antes de eso no hay ninguna escritura en la base. Cambiar de sector o cerrar el sector con propuestas sin confirmar pide confirmación antes de descartarlas (`window.confirm`). El prompt de `promptRelevamiento` en la Edge Function (`analizar-comprobante`, ahora versión 38) se reescribió para pedirle a la IA que priorice explicar su razonamiento de medición en vez de "acertar": usa la medida del relato tal cual si existe, si no estima con una referencia de escala visible y lo explica, y si no hay ninguna referencia confiable lo dice explícitamente y marca `confianza_medicion: "baja"`.

**Reparación como % del ítem nuevo (`coeficiente_ajuste`)**: cuando `es_restauracion=true` (el técnico indica que algo dañado se puede reparar/recuperar en vez de reemplazarlo por completo) Y la IA matcheó un `codigo_item` real del catálogo, el catálogo solo tiene precios de PROVISIÓN E INSTALACIÓN NUEVA — cobrar ese precio completo por una reparación menor no tenía sentido. Ahora la IA (prompt de `promptRelevamiento`, Edge Function versión 39) también estima `coeficiente_reparacion` (0 a 1: reparación menor ≈0.15-0.30, moderada ≈0.30-0.60, mayor ≈0.60-0.85, con la guía orientativa en el prompt) y explica en `justificacion` por qué eligió ese %. El backend valida el número (tiene que ser >0 y ≤1, y solo se aplica si hay `codigo_item` real — si no hay match de catálogo, `coeficiente_ajuste` queda en `1` porque no hay precio de referencia contra el cual calcular un porcentaje) y devuelve tanto `precio_unitario_total` (precio del ítem nuevo, sin tocar — se usa como referencia visual) como `precio_unitario_ajustado` (= `precio_unitario_total × coeficiente_ajuste`, el precio efectivo de la reparación). En el frontend, la propuesta (`itemsPropuestos`) usa `precio_unitario_ajustado` como `precioUnitario` real y guarda `precioReferenciaNuevo`/`coeficienteAjuste` aparte; cuando el ítem es restauración y hay precio de referencia, la revisión muestra "Ítem nuevo equivalente: $X × [% editable] = $Y" — el técnico puede corregir el % antes de confirmar (`handleCambiarCoeficientePropuesta`), igual que ya podía corregir la cantidad. `coeficiente_ajuste` se persiste en la columna homónima de `relevamiento_items` (existía en el schema desde antes, sin usar) vía `_persistirItem`, y se lee de vuelta en `_filaDbAItem`; el listado de ítems ya guardados muestra un badge "RESTAURACIÓN/RECUPERO (~X% de un ítem nuevo)" cuando el % es menor a 100.

**Chat real de consulta sobre el cómputo (`consulta_relevamiento`)**: el chat con el "especialista" (debajo del cómputo de cada sector) era una simulación heredada de la etapa Gemini — contestaba un texto fijo y solo reaccionaba a las palabras "amurar"/"reparar"/"fijar" (modificando a mano un ítem hardcodeado de lavatorio), nunca respondía nada de verdad, y no había forma de preguntarle por qué llegó a un número. Ahora `handleEnviarConsultaChat` llama a un nuevo modo de la Edge Function, `consulta_relevamiento` (Edge Function versión 40, helper `consultarSectorConIA`): el frontend le manda los ítems REALES del sector (los propuestos sin confirmar en `itemsPropuestos` + los ya guardados en `rubrosAcumulados`, con código/rubro/cantidad/precio/% de reparación/justificación) más el historial reciente de mensajes, y la IA responde la pregunta puntual del técnico ("¿por qué 12 metros de cable?", "¿de dónde sale que la instalación de 12 spots vale $1.100.000?") citando esos números reales — tiene prohibido en el prompt inventar o recalcular un número distinto al que ya está en el cómputo. Importante: este chat es solo explicativo, no modifica ítems — si el técnico no está de acuerdo con un número, la respuesta de la IA lo remite a corregirlo directamente en el input de cantidad/% de la revisión o del ítem guardado (mismo principio que ya regía para las propuestas: los cambios de datos pasan por una acción explícita del técnico, nunca por texto libre interpretado y aplicado solo).

**Relato/fotos que se repetían entre tandas de "Procesar IA" del mismo sector**: `relato` (el texto dictado/escrito) y `fotosSector` no se limpiaban después de un "Procesar IA" exitoso, así que si el técnico agregaba más dictado o fotos y volvía a apretar el botón, se reenviaba TODO lo anterior de nuevo junto con lo nuevo — la IA volvía a proponer los mismos ítems ya propuestos, duplicando el cómputo. Ahora, al terminar de armar la propuesta (`itemsPropuestos`) con éxito, `handleProcesarIA` limpia `relato` y `fotosSector` — lo ya procesado queda representado en `itemsPropuestos`/los mensajes de auditoría, y la próxima vez que el técnico dicte/cargue algo para el mismo sector arranca de cero, sin arrastrar contenido viejo.

**Cómputo compacto cuando el sector está cerrado**: la lista completa de "Ítems de Cómputo" (una card grande por ítem) hacía la pantalla mobile muy larga una vez que un sector ya estaba cerrado y no hacía falta seguir editándolo. Ahora, con el sector cerrado, arranca colapsada mostrando solo "N ítems — $total" con un botón "Ver detalle ▾"; mientras el sector sigue abierto (en edición) se ve siempre completo, sin colapsar. Se vuelve a colapsar automáticamente al cambiar de sector (`useEffect` sobre `sectorActivo`). El botón "+ Agregar Ítem Manual" también se oculta con el sector cerrado (no tiene sentido seguir cargando ítems ahí).

**Failsafe en la carga del catálogo del modal manual**: el `<select>` de "1. Rubro" del modal "Agregar Ítem Manual" se quedaba trabado en "Cargando catálogo..." para siempre si la consulta a `catalogo_cifras` colgaba o tiraba una excepción no capturada (mismo bug de fondo que el spinner infinito de Seguros — sin failsafe ni try/catch, típico con conexión celular inestable en campo). Se agregó el mismo patrón de failsafe 12s + try/catch, más un estado `catalogoError` que cambia el placeholder a "No se pudo cargar el catálogo" y muestra un botón "Reintentar" (`cargarCatalogoCifras`, ahora una función reutilizable en vez de un efecto inline).

**Otras notas**: `obras.requiere_poliza` (boolean, default `true`) se agregó junto con este módulo para poder marcar obras que no requieren garantías de seguro — está en el form de `ModalObra` (`GestorObras.jsx`) y ya está wireado en `Seguros.jsx`: `FilaObra` muestra el badge "Sin póliza requerida" y, si la obra no tiene pólizas cargadas, el mensaje cambia de "todavía no tiene pólizas cargadas" (que lee como pendiente) a una aclaración de que no hace falta cargarle — no hay ningún alerta que "exija" pólizas hoy (las alertas de `calcularAlertas` son solo sobre pólizas YA cargadas que vencen/necesitan renovarse, nunca sobre la ausencia de pólizas), así que no había una alarma que silenciar más allá de ese mensaje. Los paneos/fotos de un sector se guardan como URLs separadas por coma en `foto_url` de cada ítem generado en esa tanda (la tabla no tiene una relación 1-a-muchos separada para fotos). Un sector recién creado sin ningún ítem cargado todavía no persiste en la base (los sectores se derivan de `relevamiento_items.sector`) — recién queda guardado al cargarle el primer ítem.

**Visibilidad en beta (`GestorObras.jsx`)**: para poder deployar y probar en el celular sin exponer Seguros/Relevamientos a todos los usuarios todavía, se agregó un flag `enBeta = usuario?.email === 'dcrasiuc@gmail.com'` (definido dos veces: una vez arriba de todo en el componente `GestorObras`, y otra vez adentro de `PanelMas` porque ahí no se recibe el flag como prop sino que se recalcula del mismo `usuario`). Con `enBeta` en `false` desaparecen los dos botones "🛡️ Seguros"/"📋 Relevamientos" de la topbar desktop y las dos entradas correspondientes en "Más opciones" (mobile) — para cualquier otro usuario logueado, ambos módulos quedan invisibles en la navegación (aunque el panel en sí sigue existiendo si se fuerza el estado `panel` desde afuera; esto es solo un gate de UI para pruebas, no un control de seguridad — la protección real de datos sigue siendo RLS). Cuando se quiera liberar los módulos a todos, hay que buscar `enBeta` en `GestorObras.jsx` (2 apariciones de la definición + 4 usos) y sacar la condición.

**Compresión de fotos más agresiva**: las subidas a `relevamientos-fotos` ya corrían en paralelo (`handleCargarFotos` dispara la subida de cada foto sin esperar a la anterior, no era el cuello de botella), pero la compresión por defecto era 1600px de lado más largo a calidad JPEG 0.72 — pesado para conexión celular en campo. Se bajó a 1280px / calidad 0.65 en `_canvasComprimidoRelevamiento`/`_comprimirImagenBlobRelevamiento` (no se bajó tanto como los 600px de comprobantes en `Seguros.jsx`, porque acá las fotos son evidencia técnica que después se mira en detalle en el Informe — hay que poder ver fisuras/corrosión, no solo confirmar que un papel es una factura).

**Exportación de Informe Técnico (Word) y Presupuesto (Excel)** (`src/exportRelevamiento.js`, nuevo): los dos botones finales de `DetalleRelevamiento` ya tienen acción real. Se armó mirando los archivos reales de SEATE en Drive (`153 INFOREM CEP 4 TANQUE.docx` y `153 PRESUP_CEP 4.xlsx`) para replicar la estructura, no una genérica:
- **Informe Técnico** (`generarInformeTecnicoRelevamiento`, usa el paquete `docx` — nueva dependencia, ver abajo): genera un `.docx` con el mismo esquema que el INFOREM real — membrete SEATE + contacto, título "Memoria Descriptiva", ficha institucional (Establecimiento/Ubicación/Organismos intervinientes/Objeto/Técnico responsable/Fecha del informe, con la fecha en el mismo formato "Agosto -2026"), "1. Antecedentes" (párrafo armado con los datos reales del relevamiento + lista de rubros relevados), "2. Condiciones particulares para la ejecución de la obra" (se completa con las alertas de "control de omisiones" que dejó la IA al procesar cada sector — si no hay ninguna, dice explícitamente que no se registraron), "3. Relevamiento fotográfico y estado actual" (una subsección `3.N` por sector, con las fotos reales descargadas de `relevamientos-fotos` e incrustadas en el documento, epígrafe "Foto N – …" con numeración corrida en todo el documento igual que el modelo real), "4. Observaciones técnicas — patologías detectadas" (ítems con `riesgo = 'urgente'`). No incluye el logo real de SEATE como imagen (no se pudo extraer del docx real desde este entorno — la descarga del archivo original falló) ni un bloque de firma; si hace falta agregarlos, hay que sumar el logo como imagen embebida donde dice `SEATE`/`CONSTRUCCIONES` en texto.
- **Presupuesto** (`exportarPresupuestoRelevamiento`, usa `xlsx`, mismo patrón que `exportExcel.js`): `.xlsx` con **UNA HOJA POR SECTOR/AMBIENTE** (rediseño a pedido del usuario — antes era una única hoja "PRESUPUESTO" con todo junto + un "Anexo por Sector" solo informativo, ahora reemplazado por este esquema) más una hoja **"RESUMEN GENERAL"** primera en el libro. Cada hoja de sector (`_construirHojaSector`) agrupa sus ítems por rubro/concepto de Revista Cifras, con la MISMA estructura de fórmulas que antes: `PRECIO PARCIAL = CANT × PRECIO UNITARIO` por ítem, `PRECIO TOTAL` por rubro = suma de sus ítems, `% INC` = participación del rubro sobre el costo de ESE sector, y una fila `COSTO TOTAL — <sector>` con la suma de sus rubros. La hoja "RESUMEN GENERAL" NO copia esos números: cada fila de sector tiene una fórmula cross-sheet real (ej. `='Living'!G10`) apuntando a la celda de costo de la hoja de ese sector, y recién ahí aplica los coeficientes de obra completa en cadena — Costo → **+15% Gastos Generales** → **+10% Beneficio** (sobre Costo+GG) → Subtotal → **+23.5% Impuestos** (sobre el Subtotal) → Precio Final — igual que las fórmulas reales del PRESUP de SEATE. Como son fórmulas de Excel de verdad (no una copia estática), si se edita una cantidad o un precio en la hoja de un ambiente, ese total de sector y el consolidado general se recalculan solos al reabrir/recalcular el archivo. `_nombreHojaSector` sanea y desduplica los nombres de hoja (máx. 31 caracteres, sin `\/?*[]:`, numerados si se repiten). Un ítem sin `precioUnitario` (no matcheó contra `catalogo_cifras`) sigue quedando marcado como **"A cotizar" / "Sin precio de catálogo"** en vez de que se le invente un precio — mismo principio anti-alucinación que en el resto del módulo — y el toast final avisa cuántos ítems quedaron así.
- **Nueva dependencia**: `docx` (fijada en `8.5.0`, sin caret, a propósito — no se pudo instalar ni probar desde este entorno porque ni el sandbox ni el bridge del dispositivo tienen salida a `registry.npmjs.org`, así que se prefirió una versión exacta conocida en vez de dejar que `npm install` resuelva a lo último y arriesgar una API distinta a la que se usó acá). **Antes del próximo `npm run build` hay que correr `npm install`** para que se baje.
- **Fotos no-JPEG (ej. HEIC de iPhone) y proporción real en el Word**: `subirFotoRelevamiento` (`Relevamientos.jsx`) comprime siempre a JPEG; si la compresión falla (típico con HEIC, que muchos navegadores no pueden decodificar en un `<canvas>`), sube el archivo original tal cual pero ahora lo etiqueta con SU extensión real (`_extPorTipoArchivo`, basada en `file.type`/nombre) en vez de asumir `.jpg` a ciegas. Del lado del Informe Técnico, `generarInformeTecnicoRelevamiento` ya no asume `type: 'jpg'` para todas las fotos: lee el `Content-Type` real de la descarga (`_tipoDocxPorContentType`) y si no es uno de los formatos que `docx` sabe incrustar (jpg/png/gif/bmp — HEIC/webp no), la salta con un aviso en el documento (`[Foto no incrustada: ...]`) en vez de generar un `.docx` corrupto. Además ahora calcula el tamaño real de cada foto (`createImageBitmap`) y la escala manteniendo su proporción dentro de una caja de 420×560, en vez del tamaño fijo horizontal 420×315 que achataba las fotos verticales (la mayoría, al ser sacadas con el celular).
- **Selección inteligente de foto por ítem (Edge Function v42)**: antes, `handleProcesarIA` le pegaba TODAS las fotos subidas del sector a TODOS los ítems propuestos por igual (el `fotoUrlCompuesta`), sin importar qué mostraba cada foto — reportado como bug por el usuario ("me sube por cada ítem todas las fotos"). Ahora `promptRelevamiento` le manda a Claude cada foto etiquetada con un bloque de texto `Foto N:` justo antes de la imagen (N = posición 1-based en el array `fotoUrls`, estable aunque alguna foto falle al descargarse en el backend), y el JSON de respuesta de cada ítem incluye `fotos_relevantes: [1,3]` — los números de foto que la IA identificó como representativos de ESE trabajo puntual (puede ser `[]` si ninguna corresponde, o repetirse en más de un ítem si es una foto de contexto/vista general que aplica a varios). El backend valida que los números estén en rango antes de devolverlos. En el cliente, `handleProcesarIA` mapea esos índices de vuelta a las URLs reales de `fotoUrlsListas` y solo guarda esas en `fotoUrl` del ítem — ya no hay ningún ítem que reciba automáticamente el combo completo de fotos del sector.
- **Chat de justificación por ítem sabe cuántas fotos tiene cada uno (Edge Function v43)**: el chat interactivo por sector (`handleEnviarConsultaChat` / modo `consulta_relevamiento`) ya cubría ítems todavía sin confirmar (`itemsPropuestos`) además de los confirmados — lo que faltaba era que supiera algo sobre las fotos. Ahora `aContexto` (en `Relevamientos.jsx`) suma un campo `fotos` (cantidad de URLs en `fotoUrl` de ese ítem) al contexto que se le manda a la IA, y `promptConsultaRelevamiento` lo incluye en el listado de ítems (`...|fotos asociadas|justificación...`) — así el técnico puede preguntar "¿por qué este ítem no tiene foto?" o "¿cuántas fotos tiene?" y la IA responde con el dato real. La IA NO ve el contenido de las fotos en este chat (es texto, no multimodal en este modo) — si preguntan qué muestra una foto puntual, el prompt le indica que lo diga explícitamente y sugiera revisarla en pantalla, en vez de inventar una descripción.
- **Fotos de Relevamientos migradas a subida server-side (Edge Function v44)**: reportado repetidas veces por el usuario ("tarda mucho en subir fotos"). `subirFotoRelevamiento` (`Relevamientos.jsx`) todavía subía DIRECTO desde el cliente con `supabase.storage.from('relevamientos-fotos').upload()` — nunca se había migrado al patrón server-side que ya se usa para comprobantes de pago y pólizas por el mismo problema de carrier que bloquea/estanca POSTs directos desde mobile (ver "Paraguay carrier issue" más abajo). Ahora arma el base64 (`_leerBase64Relevamiento`) y llama a la Edge Function con `{ tipoAnalisis: 'subir_archivo', base64, mimeType, bucket: 'relevamientos-fotos', carpeta }` — mismo modo `subir_archivo` que ya existía para `comprobantes-pagos`, con `bucketsPermitidos` ampliado para incluir también `relevamientos-fotos`. Se eliminó la función `_extPorTipoArchivo` (ya no hace falta inferir la extensión en el cliente — el modo `subir_archivo` la deriva del `mimeType` server-side).
- **"La IA no devolvió un JSON válido" en Procesar IA de un sector (Edge Function v45)**: bug real en producción, reportado por el usuario con captura de pantalla — el `max_tokens: 2000` del modo `relevamiento` había quedado corto desde que cada ítem devuelto empezó a incluir también `fotos_relevantes` (v42): en sectores con varios ítems la respuesta de Claude se cortaba a mitad del JSON y `JSON.parse` fallaba. Se subió `max_tokens` a `4096`, se agregó un fallback que intenta extraer el bloque entre la primera `{` y la última `}` antes de rendirse, y si igual falla se loguea `stop_reason` + los primeros/últimos caracteres de la respuesta cruda (antes no quedaba rastro de qué había devuelto la IA) — el mensaje de error que ve el técnico ahora distingue si fue un corte por longitud ("probá con menos fotos o un relato más corto") de un JSON realmente inválido.
- **La IA "agranda" el alcance del trabajo entre una corrida y otra (Edge Function v46)**: reportado por el usuario — la primera vez identificó y cuantificó bien "algunas cerámicas" (lo puntualmente descripto/dañado), otra vez con la misma foto/relato interpretó "todo el baño". Dos causas combinadas: (1) sin `temperature` explícito, el default de la API es 1 (máxima variabilidad) — la misma consulta puede dar resultados bien distintos entre corridas; se bajó a `0.2` para que corridas repetidas sobre el mismo insumo converjan más. (2) el prompt no le decía explícitamente que se quedara acotada al alcance puntual — se agregó una regla en el punto 3 de `promptRelevamiento`: cuantificar SOLO lo que el relato describe o se ve dañado en la foto, nunca asumir que hay que intervenir todo el ambiente salvo que el relato o la foto lo indiquen explícitamente, y ante la duda entre una cantidad chica o abarcativa, preferir la chica y marcar `confianza_medicion:"baja"` (es más fácil que el técnico agrande una cantidad chica a que note que la IA infló una grande).
- **"No se pudo analizar con IA: new row for relation "relevamiento_mensajes"..." al procesar un sector**: bug real, reportado con captura — los ítems SÍ se proponían bien (v45 funcionando), pero el mensaje de auditoría que se guarda junto (`mensaje_auditoria`/`alertas_omision` de la IA, y las respuestas del chat de consulta) intentaba insertar `emisor: 'ia'` en `relevamiento_mensajes`, un valor que el CHECK constraint de esa columna nunca aceptó (`relevamiento_mensajes_emisor_check` solo permite `'tecnico'` o `'agente_ia'`) — el insert fallaba siempre, en cualquier sector, desde que existe esta función. Se corrigió a `emisor: 'agente_ia'` en los dos puntos donde se guarda (después de "Procesar IA" y en las respuestas del chat de consulta) y en la condición que decide el ícono 🤖 al mostrar los mensajes.
- **% de reparación (`coeficiente_ajuste`) ahora es opcional, con tilde**: antes, apenas la IA marcaba `es_restauracion=true` en un ítem propuesto, la revisión mostraba forzado el bloque de "% del ítem nuevo" sin ninguna forma de decir "no, esto va a precio de nuevo completo" — el técnico solo podía cambiar el número, no desactivar el concepto. El usuario pidió que no se aplique "para todo" y sea opcional. Ahora tanto la revisión de propuestas de la IA (`itemsPropuestos`, checkbox + `handleCambiarEsRestauracionPropuesta`) como la carga manual (`itemManual`, checkbox + `handleCambiarEsRestauracionManual`/`handleCambiarCoeficienteManual`, nuevo campo `precioReferenciaNuevo` en el estado del modal) muestran un tilde "🔧 Es reparación (no reemplazo nuevo)" — visible siempre que hay un precio de referencia de catálogo, sin importar lo que haya sugerido la IA. Destildado: cobra el 100% del ítem nuevo. Tildado: aplica el % (recuerda el último % cargado, no resetea a 100 cada vez que se vuelve a tildar). En la carga manual, elegir un ítem distinto del catálogo resetea el tilde y el % a su estado inicial (no arrastra el % de un ítem anterior).

---

## Edge Function: `analizar-comprobante`

Ubicación: `src/supabase/functions/analizar-comprobante/index.ts`  
URL deploy: `https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante`

**Modos** (versión 45 a la fecha):
- Si `body.table` presente → **DB write proxy** (tabla, método, payload, filter, returning) — genérico, sirve para cualquier tabla.
- Si `body.tipoAnalisis === 'subir_archivo'` → **solo sube un archivo a Storage, sin IA** (`{ base64, mimeType, bucket, carpeta }`, bucket restringido a una lista fija: `comprobantes-pagos` y `relevamientos-fotos`). Devuelve `{ url }`. Usado por `subirArchivoStorage` en `GestorObras.jsx` para el comprobante de pago y por `subirFotoRelevamiento` en `Relevamientos.jsx` para las fotos de sector (ver "Feature: Upload de Comprobantes de Pago" y la sección de Relevamientos más arriba).
- Si `body.tipoAnalisis === 'relevamiento'` → módulo Relevamientos (ver esa sección).
- Si `body.tipoAnalisis === 'consulta_relevamiento'` → chat de consulta sobre un cómputo de Relevamientos ya generado (ver esa sección).
- Si no matchea ninguno de los anteriores y `body.base64` está presente → **modo IA de extracción**: `body.tipoAnalisis` = `'comprobante'` (default) o `'poliza'`, cada uno con su propio prompt y su propio bucket de destino (`comprobantes` vs `polizas-documentos`). El prompt de `comprobante` incluye desde esta revisión: reglas explícitas de formato numérico argentino (punto = miles, coma = decimales), instrucción de tomar siempre el TOTAL final y no un subtotal, aviso sobre fechas DD/MM/AAAA, y un campo nuevo `confianza` ("alta"/"media"/"baja") que la IA autoevalúa sobre qué tan segura está de la lectura — si viene "baja", `ModalFoto` (`GestorObras.jsx`) le muestra un toast de aviso al usuario para que revise los datos a mano antes de guardar, en vez de dejar pasar en silencio una lectura dudosa.

**La Edge Function pasa el JWT del usuario** en todas las escrituras a Supabase (`authHeader = req.headers.get('Authorization')`), por lo que respeta las políticas RLS.

**Variables de entorno requeridas en Supabase:**
- `SUPABASE_URL` (auto-set por Supabase)
- `SUPABASE_ANON_KEY` (auto-set por Supabase)
- `ANTHROPIC_API_KEY` (configurar manualmente)

**Deploy:** Vía dashboard de Supabase (CLI bloqueado por carrier). Ir a Edge Functions → analizar-comprobante → Deploy.

---

## Seguridad: Row Level Security (RLS)

Las siguientes tablas deben tener RLS activado con política "solo usuarios autenticados":

```sql
-- Activar RLS
ALTER TABLE gastos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE obras       ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE proveedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios    ENABLE ROW LEVEL SECURITY;

-- Política: solo autenticados
CREATE POLICY "solo_autenticados" ON gastos      FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "solo_autenticados" ON obras       FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "solo_autenticados" ON clientes    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "solo_autenticados" ON proveedores FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "solo_autenticados" ON usuarios    FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

Esto no rompe la app porque todos los usuarios siempre inician sesión (rol `authenticated`).
### Fix — políticas RLS abiertas a `public`/anon sin querer (septiembre 2026)

Al revisar el Security Advisor de Supabase por otro tema, aparecieron varias tablas con una política RLS que aplica al rol `public` (o sea, también a alguien SIN sesión, con solo la clave `anon` pública del bundle JS) con `USING(true)`/`WITH CHECK(true)` — acceso total sin login. Se confirmó con una consulta directa a `pg_policies` (el Advisor a propósito no muestra políticas `SELECT USING(true)`, así que hubo que pedir el dump completo para no dejar huecos sin ver).

- **Causa**: la mayoría de estas tablas nunca llegaron a tener la política `"solo_autenticados"` que sí tienen `gastos`, `obras`, `clientes`, `proveedores`, `usuarios` (ver sección de arriba) — se quedaron con una política más vieja/genérica ("acceso X", "allow_all_X") que nunca exigió login. Y en `gastos`/`obras` puntualmente, la política vieja SIGUIÓ EXISTIENDO al lado de la nueva `"solo_autenticados"` correcta — como Postgres combina políticas RLS con OR, la vieja (permisiva) neutralizaba a la nueva (correcta) sin que se notara.
- **Tablas corregidas** (política existente, solo se le sacó el permiso a `public`/anon, dejándola aplicar solo a `authenticated` — el `USING`/`WITH CHECK` no se tocó): `cc_pago_items`, `cc_pagos`, `comprobante_obras`, `factura_remitos`, `obra_usuarios`, `remito_items`, `remitos`, `usuarios_crm`, `bancos` (las dos políticas: lectura y escritura).
- **`pagos`**: las políticas de INSERT/UPDATE/DELETE ya estaban bien (verifican `usuarios.rol = 'admin'` vía `auth.uid()`, así que un anon ya fallaba ese chequeo solo). Pero había una política `"todos leen pagos"` de SELECT sin ningún chequeo — cualquiera sin login podía leer el historial completo de pagos. Se cerró igual que las demás (solo `authenticated`).
- **`gastos` y `obras`**: se eliminó la política vieja (`"acceso total gastos"` / `"acceso total obras"`) que quedó dando vueltas al lado de la correcta `"solo_autenticados"` — la protección real queda a cargo de esta última, que no se tocó.
- **`usuarios_obras`** (no confundir con `obra_usuarios`, son tablas distintas): ya tenía políticas bien pensadas con chequeo por fila (`admin gestiona asignaciones` vía `auth.uid()` + rol admin, `operador lee sus asignaciones` con `usuario_id = auth.uid()`) — no hizo falta tocarla.
- **Función `get_auth_users_sin_perfil()`** (la usa el panel de administración de usuarios, `GestorObras.jsx` línea ~2118, mientras el usuario está logueado): se le fijó el `search_path` (mutable antes, riesgo de schema-injection) y se le sacó el permiso de ejecución a `anon` — se le dejó a `authenticated` para no romper ese panel.
- **Vista `obras_resumen`**: tenía la propiedad `SECURITY DEFINER`, que hace que ignore el RLS de las tablas que usa por debajo (corre con los permisos de quien la creó, no de quien consulta). Se le puso `security_invoker = on` para que vuelva a respetar el RLS del usuario que consulta, como cualquier vista normal.
- **Storage**: los buckets públicos `comprobantes`, `comprobantes-pagos`, `polizas-documentos`, `relevamientos-fotos` tenían políticas que permitían **listar** todos los archivos sin login (no solo abrir uno si ya tenés la URL — eso sigue funcionando igual, un bucket público sirve objetos por URL directa sin pasar por estas políticas). Se cerró la posibilidad de enumerar/listar a quien no está logueado.
- **Lo que NO se tocó a propósito**: ninguna política cambió su lógica (`USING`/`WITH CHECK`) — el único cambio en todos los casos fue restringir el rol de `public` a `authenticated`. Como toda la app exige login (no hay ninguna pantalla pública en `gestor-obras`), esto no debería cambiar nada para el uso normal.
- **Migración**: `fix_seguridad_rls_2026-09.sql` en la raíz del repo — se corre a mano en el SQL Editor del dashboard de Supabase (dividido en dos bloques transaccionales, primero el confirmado 100% contra `pg_policies`, después el de función/vista/storage, para que si algún nombre de política de storage no coincide exacto, no arrastre para atrás lo que ya está confirmado).
- **Pendiente manual, no es SQL**: activar "Leaked Password Protection" en el dashboard de Supabase (Authentication → Policies/Security) — chequea contraseñas contra HaveIBeenPwned, hoy está desactivado. Es un toggle de un clic, no requiere migración.


---

## Auth

- Login con Supabase Auth (email/password)
- JWT guardado en `localStorage` con key `seate-auth`
- `getTokenSync()` en `utils.js` lee el JWT sincrónicamente (sin network)
- Logout limpia localStorage primero, luego llama `signOut` (no bloquea si hay error de red)

```js
const handleLogout = () => {
  localStorage.removeItem('seate-auth')
  supabase.auth.signOut({ scope: 'local' }).catch(() => {})
}
```

---

## Hooks principales en `GestorObras.jsx`

| Hook | Expone | Descripción |
|---|---|---|
| `useListas` | `clientes, proveedores, bancos, recargarListas, setProveedores` | Datos de lookup |
| `useObras` | `obras, loading, recargarObras` | Obras del usuario |
| `useGastos` | `gastos, setGastos, loading, recargar` | Gastos filtrados por obras accesibles |

`recargarTodo(silent?)` — recarga obras + gastos. `silent=true` para background sin spinner.

---

## Paleta de colores

```js
export const C = {
  bg: '#F7F7F7', surface: '#FFFFFF', border: '#EBEBEB', borderFaint: '#F5F5F5',
  purple: '#7B4DB5', purpleLight: '#9B6DD5', purpleDark: '#5B2D8E', purpleDim: '#F3F0FF',
  text: '#1A1A1A', textMuted: '#888888', textFaint: '#CDCDCD',
  green: '#1A6B3C', greenDim: '#EDFAF3',
  orange: '#8A5200', orangeDim: '#FFF8ED',
}
```

---

## Proceso de deploy

**Plataforma:** Cloudflare **Pages** (no Workers)  
**Trigger:** automático — Cloudflare Pages tiene integración directa con GitHub y despliega solo al hacer push a `main`. No hace falta ir a ningún panel ni ejecutar workflows manualmente.

**Pasos (siempre desde la PC Windows, no desde el sandbox Linux):**
```bash
# En terminal Windows (C:\Users\<usuario>\gestor-obras):
npm run build
git add -A
git commit -m "descripción del cambio"
git push origin main
```

**Variables de entorno** (Cloudflare Pages dashboard):
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

**Proyecto Cloudflare Pages:** `gestordeobras`  
**Repo GitHub:** `https://github.com/dcrasiuc/GestorObras.git`

---

## Bugs resueltos ✅

- **Spinner infinito en mobile al guardar gasto** → Failsafe 12s + `showLoading=false` en recarga post-save
- **PC no se actualiza cuando mobile guarda** → Supabase Realtime subscriptions
- **Nuevo proveedor no aparece en dropdown** → Optimistic update con `setProveedores(prev => [...prev, nuevoProv])`
- **Gasto/proveedor guardado pero invisible hasta reiniciar** → Optimistic updates en `setGastos`
- **Delete en PC no refleja en mobile** → Realtime subscription + optimistic `filter`
- **`onProveedorCreado(null)` crashea** → Null-safe guard `if (!np?.id) return`
- **Logout cuelga en mobile** → Logout síncrono (localStorage primero, signOut async sin await)
- **Upload comprobante queda en "subiendo" forever** → try-catch global en `subirArchivoStorage`; usaba `readAsDataURL` que causaba OOM en Pixel 8 Pro → migrado a `createObjectURL`
- **Upload comprobante timeout** → compresión bajada a 600px, timeout subido a 60s, retry automático
- **400 al guardar pago con tarjeta_credito** → faltaba `ALTER TABLE pagos DROP CONSTRAINT pagos_medio_pago_check` + recrear con nuevos valores
- **Gasto general no se guardaba** → `obra_id NOT NULL` + constraint de concepto no incluía conceptos generales → SQL migrations aplicadas
- **Seguros queda pensando en blanco (spinner infinito) en mobile** → los 4 hooks de datos de `Seguros.jsx` (`useObrasSeguros`, `usePolizas`, `usePagosPoliza`, `useRenovacionesPoliza`) nunca habían adoptado el patrón de Failsafe Timeouts documentado más arriba — si alguna de las 4 consultas a Supabase colgaba o tiraba una excepción no capturada (típico en conexión celular inestable), `setLoading(false)` nunca se ejecutaba y el panel entero quedaba en `<Spinner />` para siempre, porque `loading = loadingObras || loadingPolizas || loadingPagos || loadingRenovaciones` requiere que las 4 resuelvan. Se agregó a los 4 el mismo failsafe de 12s + try/catch que ya tenían `useObras`/`useGastos` en `GestorObras.jsx`.
- **App entera en pantalla en blanco después de un deploy (setiembre 2026, corregido el mismo día)** → import circular entre módulos ES: `src/exportSegurosExcel.js` importaba `TIPOS_COBERTURA` desde `'./Seguros'`, mientras que `Seguros.jsx` importa `exportSegurosExcel.js`. Al evaluarse el bundle, JS llega al import de `exportSegurosExcel.js` ANTES de que `Seguros.jsx` termine de inicializar su propio `export const TIPOS_COBERTURA`, y tira `ReferenceError: Cannot access 'TIPOS_COBERTURA' before initialization` — esto pasa al cargar el módulo, antes de que React llegue a renderizar nada, así que la pantalla queda en blanco sin ningún error visible salvo en la consola del navegador (F12). Se reprodujo en aislado con un test mínimo de Node ESM para confirmar la causa exacta antes de tocar nada. Fix: `exportSegurosExcel.js` ya no importa nada de `'./Seguros'` — tiene su propia copia local chica de las etiquetas de cobertura (`COBERTURA_LABELS`), mismo patrón que ya usaba `exportExcel.js`. **Regla general: un archivo `export*.js` (o cualquier módulo "hoja") nunca debe importar de vuelta el módulo que lo importa a él** — si hace falta compartir una constante chica, se duplica localmente en vez de crear el ciclo. Técnica de verificación reutilizable: bundlear `src/main.jsx` con `esbuild` (stubs de DOM/`import.meta.env`) y correrlo con `node` — si el bundle entero evalúa sin `ReferenceError` hasta llegar a `ReactDOM.createRoot`, no hay import circular en el grafo de módulos.

---

## Pendientes 📋

- **Permisos multi-usuario**: administrador vs. operario (columna `rol` en `usuarios`)
- **Informe PDF** por obra (resumen de gastos y estado)
- **Módulo vencimiento de tarjeta de compras** (pendiente de diseño)
- **CuentaCorriente de clientes**: cobros por obra (hoy `CuentaCorriente.jsx` cubre proveedores; falta el lado clientes)
- **Seguros**: badge de etapa/organismo en `PanelObras` (hoy solo se ve en la sección Seguros); Realtime propio para la sección; migrar datos del proyecto viejo `seate-polizas` si tenía cargas reales
- **Seguros — anti-alucinación al leer pólizas con IA (setiembre 2026, pedido explícito del usuario, no implementado)**: si la IA (OCR de `analizar-comprobante`) no está 100% segura de un dato crítico, tiene que preguntar en vez de inventarlo/estimarlo. Datos que nunca se pueden inventar: `nro_poliza`, `fecha_vencimiento`, y los montos/"valores" en general. Ya existe el mismo principio aplicado a `prima_fuente` (no completa `prima` salvo etiqueta explícita "PRIMA"/"PREMIO") — falta extenderlo a `nro_poliza` y `fecha_vencimiento`: hoy la IA los completa igual aunque la lectura sea dudosa, en vez de dejarlos en null/marcar baja confianza para que el usuario los confirme a mano.

---

## Comandos útiles

```bash
# Desarrollo local (en PC Windows)
npm run dev

# Build para deploy
npm run build

# Git
git status
git add -A && git commit -m "mensaje" && git push
```

### Atajo: `build-y-subir.bat` (septiembre 2026)

Doble clic en la raíz del proyecto — hace `npm run build` (si falla, se detiene y no sube nada), pide un mensaje de commit (Enter = uno automático con fecha/hora), `git add -A`, `git commit` y `git push origin main`. Usa `cd /d "%~dp0"` (la carpeta donde está el .bat) en vez de una ruta fija, para no romperse si el proyecto se mueve de carpeta otra vez (a diferencia de `subir-github.bat`, que quedó con la ruta vieja de antes de la migración de PC de julio 2026 y ya no sirve tal cual).

---

## Notas de contexto adicional

- **Paraguay carrier issue**: El carrier bloquea POSTs directos a Supabase REST desde mobile → todas las escrituras van por Edge Function proxy. Los GET directos al cliente Supabase funcionan.
- **Supabase CLI**: No funciona en la red del usuario (bloquea api.supabase.com). Usar siempre el dashboard web para deployar Edge Functions.
- **Build en sandbox**: El sandbox Linux de Cowork no tiene los binarios correctos para `npm run build`. Siempre decirle al usuario que haga el build en su PC Windows.
- **`seate-auth`**: El storageKey del cliente Supabase. Si hay problemas de auth, verificar que localStorage tiene este key con un objeto que incluye `access_token`.
- **Fotos mobile de alta resolución**: Pixel 8 Pro saca fotos de 50MP. La compresión usa `createObjectURL` (no `readAsDataURL`/base64) para evitar OOM en mobile.
- **Migración de PC (julio 2026)**: Daniel migró a una PC nueva. Como el proyecto vive en GitHub y el deploy es automático vía Cloudflare Pages, la migración fue simplemente clonar el repo. Ubicación: `C:\Users\dcras\Documents\Proyectos\gestor-obras`. El archivo `.env.local` no está en git (se copia manualmente a cada PC nueva).
- **HISTORIAL.md**: además de este archivo, el repo tiene `HISTORIAL.md` con la narrativa cronológica completa del proyecto por etapas. Mantener ambos archivos coherentes al agregar features nuevas.
- **Deploy de Edge Functions vía Supabase MCP**: cuando Claude tiene el connector de Supabase disponible (Cowork), puede desplegar la Edge Function directamente con `deploy_edge_function` sin pasar por el dashboard — mucho más rápido que pedirle a Daniel que lo haga manualmente. Igual sigue valiendo la limitación de que el build de la app (`npm run build`) se hace desde la PC Windows.
- **Límite de proyectos Supabase free tier**: la cuenta de Daniel tiene como máximo 2 proyectos activos simultáneos. Si hace falta restaurar un proyecto pausado (ej. `seate-polizas`), puede hacer falta pausar otro primero (ej. `parmetal-crm`).
