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
- `organismo TEXT` — IPRODA / EBY / UCEF / MUNI_POSADAS / VIALIDAD / Privado / Otro
- `monto_contrato NUMERIC` — monto del contrato/licitación (distinto de `presupuesto`, que es para seguimiento de gastos)
- `etapa TEXT DEFAULT 'ejecucion'` CHECK IN ('oferta', 'ejecucion') — separa obras que todavía están en licitación de las adjudicadas/en curso. **Importante:** `obras_resumen` (la vista que usa el panel principal de Obras) y el `useObras()` de `GestorObras.jsx` filtran `.neq('etapa','oferta')` — una obra "en oferta" cargada desde Seguros NO aparece en el panel de Obras, dropdowns de gastos/finanzas ni en `CuentaCorriente.jsx` hasta que se marca "adjudicada" (pasa a `etapa='ejecucion'`) desde Seguros. Recién ahí se "activa" en el resto de la app.
- `estado_licitacion TEXT DEFAULT 'en_curso'` CHECK IN ('en_curso', 'recepcion_provisoria', 'recepcion_definitiva') — dispara las alertas de baja de póliza. Una obra es "vigente" (vista default de Seguros) mientras no llegue a `recepcion_definitiva`.
- `recepcion_provisoria_url TEXT`, `recepcion_definitiva_url TEXT` — foto/PDF del acta de recepción de obra firmada con el organismo, cargada vía `ModalRecepcionObra` al marcar cada etapa. Es el documento que después se le presenta a la aseguradora para pedir la baja.

### `organismo` vs. cliente vinculado (`obras.cliente_id`) — de dónde sacar "quién es" la obra
`organismo` es un campo propio de Seguros que en la práctica **casi nadie completa** (se confirmó por SQL: en las 30 obras más recientes, `organismo` está `null` en todas). Lo que sí está cargado, para la mayoría de las obras reales, es `obras.cliente_id` (FK a `clientes`, el mismo campo "Cliente" que ya se ve en el panel principal de Obras) — para obra pública ese cliente ES el organismo (ej. "ENTIDAD BINACIONAL YACYRETA", "IPRODHA", "USCEPP"), y para obra privada es el cliente real. Por eso Seguros usa `nombreOrganismoObra(obra)` (en `Seguros.jsx`) como fuente de "quién es la obra": prioriza `obra.clientes.nombre` (requiere que la query de `useObrasSeguros()` haga `select('*, clientes(nombre)')`) y sólo cae a `organismo` como fallback legacy si no hay cliente vinculado. `FilaObra` y el `<select>` de obra en `ModalPoliza` muestran este valor en vez de `obra.organismo` directamente — antes de este fix, Seguros mostraba "Sin organismo" en casi todas las obras aunque el panel de Obras ya tuviera el cliente cargado. `candidatasObra()` (detección de obra duplicada) también compara el `organismo` que lee la IA contra este mismo nombre (fuzzy match), no sólo contra el enum `organismo`.

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

### Cumplimiento de Contrato vs. Anticipo Financiero (`tipo_cobertura`)
Son dos garantías DISTINTAS aunque ambas sean seguros de caución de la misma obra — error común detectado en la v1 (la IA metía "anticipo financiero" dentro de `ejecucion_contrato`). Cumplimiento (`ejecucion_contrato`, label "Cumplimiento de Contrato") garantiza que se ejecute el contrato, no se amortiza, se cancela recién en recepción. Anticipo Financiero (`anticipo_financiero`, valor nuevo) garantiza la devolución del anticipo entregado por el organismo, y se va reduciendo a medida que se descuenta de los certificados de obra — no espera a la recepción. `inferirVigenciaYFinalObra()` les da defaults distintos (`requiere_final_obra: true` para cumplimiento, `false` para anticipo).

### Cláusula de repetición — importante para no confundir
En un seguro de caución la aseguradora SIEMPRE conserva el derecho de repetir contra el tomador (SEATE) — así funciona la caución, respaldada por la contragarantía. Lo que `clausula_repeticion` busca NO es eso: es si el documento renuncia a repetir contra el ORGANISMO/COMITENTE (típico en pólizas de Responsabilidad Civil, ej. "sin derecho de repetición contra el comitente"). El prompt de la Edge Function y el label del campo en `Seguros.jsx` dejan esto explícito para no generar falsos "con_repeticion" en pólizas de caución donde no aplica.

### Matching de obra al leer una póliza con IA (evita duplicados)
`matchFuerteObra()` hace un match exacto/substring y auto-selecciona. Si no hay match fuerte, `candidatasObra()` busca obras con alguna palabra significativa en común o mismo organismo y se le muestran al usuario como pregunta ("¿Es alguna de estas la misma obra?") antes de ofrecer "+ Crear obra" — se agregó después de que la IA creara una obra duplicada ("Mojones EBY" vs. "8360 Mojones") por leer un nombre distinto para la misma obra real.

### `obras.requiere_poliza` (boolean, default true)
Para obras menores o de clientes privados que no piden garantías de seguro. Se edita desde `ModalObra` en `GestorObras.jsx` (checkbox) o queda implícito en `true` para las creadas desde Seguros vía licitación. En `Seguros.jsx` se ve como badge "Sin póliza requerida" en `FilaObra`.

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

---

## Pendientes 📋

- **Permisos multi-usuario**: administrador vs. operario (columna `rol` en `usuarios`)
- **Informe PDF** por obra (resumen de gastos y estado)
- **Módulo vencimiento de tarjeta de compras** (pendiente de diseño)
- **CuentaCorriente de clientes**: cobros por obra (hoy `CuentaCorriente.jsx` cubre proveedores; falta el lado clientes)
- **Seguros**: badge de etapa/organismo en `PanelObras` (hoy solo se ve en la sección Seguros); Realtime propio para la sección; migrar datos del proyecto viejo `seate-polizas` si tenía cargas reales

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
