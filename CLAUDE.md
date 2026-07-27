# GESTOR DE OBRAS — Contexto para Claude
*Última actualización: Julio 2026*

---

## ¿Qué es este proyecto?

App de gestión de obras de construcción para **Daniel (SEATE S.R.L., Posadas, Misiones, Argentina)**. Permite registrar obras, gastos por obra, pagos, proveedores y clientes. Incluye análisis de comprobantes con IA (Claude).

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

**Tablas Supabase:** `obras`, `gastos`, `pagos`, `clientes`, `proveedores`, `bancos`, `usuarios`

---

## Arquitectura del código

```
src/
├── main.jsx            # Entry point
├── App.jsx             # Router raíz (Login vs GestorObras)
├── GestorObras.jsx     # App principal (~3500+ líneas)
├── CuentaCorriente.jsx # Vista cuenta corriente por cliente/proveedor
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
- Try-catch global: si Supabase lanza excepción (en vez de devolver `{error}`), la función siempre retorna null → `setSubiendo(false)` siempre se llama
- Si la compresión falla Y el original es >5MB → muestra toast de error en vez de intentar subir

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

## Edge Function: `analizar-comprobante`

Ubicación: `src/supabase/functions/analizar-comprobante/index.ts`  
URL deploy: `https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante`

**Modo dual:**
- Si `body.table` presente → **modo DB write proxy** (tabla, método, payload, filter, returning)
- Si `body.base64` presente → **modo IA** (analiza imagen de comprobante con Claude Anthropic)

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

---

## Pendientes 📋

- **Permisos multi-usuario**: administrador vs. operario (columna `rol` en `usuarios`)
- **Informe PDF** por obra (resumen de gastos y estado)
- **Módulo vencimiento de tarjeta de compras** (pendiente de diseño)

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
