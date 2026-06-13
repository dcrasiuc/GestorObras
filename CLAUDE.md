# GESTOR DE OBRAS — Contexto para Claude
*Última actualización: Junio 2026*

---

## ¿Qué es este proyecto?

App de gestión de obras de construcción para **Daniel (SEATE S.R.L., Posadas, Misiones, Argentina)**. Permite registrar obras, gastos por obra, pagos, proveedores y clientes. Incluye análisis de comprobantes con IA (Claude).

**Dueño:** Daniel  
**Empresa:** SEATE S.R.L. (Posadas, Misiones, Argentina)

---

## Stack técnico

| Componente | Tecnología | URL / Info |
|---|---|---|
| Frontend | React + Vite (multi-archivo) | `src/` |
| Deploy | Cloudflare Workers | Deploy manual vía Wrangler o dashboard |
| Base de datos | Supabase | Proyecto: `oyqmowolwwjjuarxttuh` |
| IA (análisis comprobantes) | Anthropic Claude (via Edge Function) | Supabase Edge Function |
| Auth | Supabase Auth | `storageKey: 'seate-auth'` en localStorage |

**Tablas Supabase:** `obras`, `gastos`, `pagos`, `clientes`, `proveedores`, `bancos`, `usuarios`

---

## Arquitectura del código

```
src/
├── main.jsx            # Entry point
├── App.jsx             # Router raíz (Login vs GestorObras)
├── GestorObras.jsx     # App principal (~2000+ líneas)
├── CuentaCorriente.jsx # Vista cuenta corriente por cliente
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

## Edge Function: `analizar-comprobante`

Ubicación: `src/supabase/functions/analizar-comprobante/index.ts`  
URL deploy: `https://oyqmowolwwjjuarxttuh.supabase.co/functions/v1/analizar-comprobante`

**Modo dual:**
- Si `body.table` presente → **modo DB write proxy** (tabla, método, payload, filter, returning)
- Si `body.base64` presente → **modo IA** (analiza imagen de comprobante con Claude Anthropic)

**Variables de entorno requeridas en Supabase:**
- `SUPABASE_URL` (auto-set por Supabase)
- `SUPABASE_ANON_KEY` (auto-set por Supabase)
- `ANTHROPIC_API_KEY` (configurar manualmente)

**Deploy:** Vía dashboard de Supabase (CLI bloqueado por carrier). Ir a Edge Functions → analizar-comprobante → Deploy.

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
  bg: '#F7F7F7', surface: '#FFFFFF', border: '#EBEBEB',
  purple: '#7B4DB5', purpleLight: '#9B6DD5', purpleDark: '#5B2D8E', purpleDim: '#F3F0FF',
  text: '#1A1A1A', textMuted: '#888888', textFaint: '#CDCDCD',
  green: '#1A6B3C', greenDim: '#EDFAF3',
  orange: '#8A5200', orangeDim: '#FFF8ED',
}
```

---

## Proceso de deploy

**El build SIEMPRE se hace en la PC del usuario (Windows), no en el sandbox Linux.**  
(El sandbox tiene binarios Linux, no funciona para rolldown/Vite en este proyecto.)

```bash
# En la terminal de Windows (C:\Users\dcras\gestor-obras):
npm run build
git add -A
git commit -m "descripción del cambio"
git push
```

El deploy a Cloudflare Workers se hace automáticamente vía GitHub → Cloudflare Pages/Workers.

---

## Bugs resueltos ✅

- **Spinner infinito en mobile al guardar gasto** → Failsafe 12s + `showLoading=false` en recarga post-save
- **PC no se actualiza cuando mobile guarda** → Supabase Realtime subscriptions
- **Nuevo proveedor no aparece en dropdown** → Optimistic update con `setProveedores(prev => [...prev, nuevoProv])`
- **Gasto/proveedor guardado pero invisible hasta reiniciar** → Optimistic updates en `setGastos`
- **Delete en PC no refleja en mobile** → Realtime subscription + optimistic `filter`
- **`onProveedorCreado(null)` crashea** → Null-safe guard `if (!np?.id) return`
- **Logout cuelga en mobile** → Logout síncrono (localStorage primero, signOut async sin await)

---

## Pendientes 📋

- **Habilitar Realtime** en dashboard Supabase + ejecutar SQL `REPLICA IDENTITY FULL` (ver arriba)
- **Pagos**: implementar registro de pagos parciales por gasto
- **Informe PDF** por obra (resumen de gastos y estado)
- **Permisos multi-usuario**: administrador vs. operario (columna `rol` en `usuarios`)

---

## Comandos útiles

```bash
# Desarrollo local (en PC Windows)
npm run dev

# Build para deploy
npm run build

# Ver archivos generados
ls dist/

# Git
git status
git add -A && git commit -m "mensaje" && git push
```

---

## Notas de contexto adicional

- **Paraguay carrier issue**: No bloquea la app de Gestor de Obras directamente (es Argentina), pero el patrón de proxy via Edge Function se mantiene por compatibilidad y porque el backend de Daniel está en Paraguay.
- **Supabase CLI**: No funciona en la red del usuario (bloquea api.supabase.com). Usar siempre el dashboard web para deployar Edge Functions.
- **Build en sandbox**: El sandbox Linux no tiene los binarios correctos para `npm run build`. Siempre decirle al usuario que haga el build en su PC Windows.
- **`seate-auth`**: El storageKey del cliente Supabase. Si hay problemas de auth, verificar que localStorage tiene este key con un objeto que incluya `access_token`.
