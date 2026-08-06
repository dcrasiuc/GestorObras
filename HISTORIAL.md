# HISTORIAL DEL PROYECTO — Gestor de Obras
*SEATE S.R.L. — Daniel Crasiuc*

---

## Origen del proyecto

App de gestión de obras de construcción creada para SEATE S.R.L. (Posadas, Misiones, Argentina). Reemplaza el control manual en planillas Excel. El objetivo principal es poder registrar gastos por obra, pagos a proveedores y analizar comprobantes con IA desde el celular en campo.

---

## Etapa 1 — Base de la aplicación

**Lo que se construyó:**
- Login con Supabase Auth
- Panel de obras (crear, editar, ver gastos)
- Registro de gastos por obra con proveedor, concepto, monto, tipo de comprobante
- Lista de proveedores y clientes
- Análisis de comprobantes con IA (foto → datos extraídos automáticamente)
- Deploy en Cloudflare Pages con GitHub integration (push a `main` = deploy automático)

**Decisiones de arquitectura:**
- React + Vite como frontend (multi-archivo, sin TypeScript para simplicidad)
- Supabase como backend (base de datos + auth + storage + edge functions)
- Cloudflare Pages para deploy (gratuito, automático, sin configuración manual)

---

## Etapa 2 — Problema crítico: Mobile Write Proxy

**El problema:**
Los POST directos desde el celular a la API REST de Supabase eran bloqueados/descartados por el carrier. Los datos parecían guardarse (no había error) pero no aparecían hasta reiniciar la app. Los GET funcionaban bien.

**La solución:**
Todas las escrituras (INSERT/UPDATE/DELETE) se redirigen a través de la Supabase Edge Function `analizar-comprobante`, que ya existía para el análisis de IA. La Edge Function hace el request server-to-server a Supabase REST, lo cual es confiable.

Se creó `dbWrite()` en `utils.js` como función única para todas las escrituras:
```
Celular/PC → Edge Function analizar-comprobante → Supabase REST
```

**Regla fija desde entonces:** NUNCA usar `supabase.from(...).insert/update/delete` directamente. Siempre `dbWrite()`.

---

## Etapa 3 — Multi-device Sync + Optimistic Updates

**Problema:** cuando el celular guardaba un gasto, la PC no se enteraba (y viceversa).

**Solución:**
- **Supabase Realtime**: suscripción a cambios en tablas `gastos`, `obras`, `clientes`, `proveedores`. Cuando otro dispositivo guarda algo, el canal Realtime avisa y se recarga en background sin spinner.
- **Optimistic Updates**: al guardar algo, el estado React se actualiza inmediatamente sin esperar a releer de Supabase. Luego se hace una recarga silenciosa en background (`recargarTodo(silent=true)`).

**SQL necesario para Realtime:**
```sql
ALTER TABLE gastos      REPLICA IDENTITY FULL;
ALTER TABLE obras       REPLICA IDENTITY FULL;
ALTER TABLE clientes    REPLICA IDENTITY FULL;
ALTER TABLE proveedores REPLICA IDENTITY FULL;
```

---

## Etapa 4 — Pagos y Comprobantes de Pago

**Lo que se construyó:**
- Registro de pagos por gasto (parciales o totales)
- Múltiples pagos por gasto (pagos parciales)
- Modal de pago múltiple (pagar varios gastos del mismo proveedor a la vez)
- Upload de foto/PDF del comprobante de pago adjunto a cada pago
- Modal para adjuntar comprobantes a pagos ya registrados
- Subida masiva de comprobantes

**Bucket de Storage:** `comprobantes-pagos` (PUBLIC en Supabase Storage)

**Problema con uploads en mobile (Pixel 8 Pro):**
El Pixel 8 Pro saca fotos de hasta 50MP (15-20MB). El método original usaba `FileReader.readAsDataURL` que convierte el archivo a base64 en memoria (+33% RAM) y luego lo decodifica como imagen (~300MB RAM total) → crash en mobile.

**Solución:** migrar a `URL.createObjectURL` que referencia el archivo directamente sin copiarlo en memoria. Además:
- Compresión a **600px / 0.72 calidad** (resultado ~60-80KB, suficiente para un comprobante)
- Timeout aumentado a **60 segundos** (antes 20s, insuficiente con conexión móvil lenta)
- **Retry automático** una vez si falla, con 1.5s de pausa
- Try-catch global en `subirArchivoStorage()` para garantizar que `setSubiendo(false)` siempre se llama (antes, si Supabase lanzaba una excepción, la UI quedaba colgada en "Subiendo..." para siempre)

---

## Etapa 5 — Gastos Generales de Empresa

**Contexto:** además de gastos por obra (materiales, mano de obra, etc.), SEATE tiene gastos que no pertenecen a ninguna obra específica: combustible, servicios, administración, legales, etc. Estos se deben prorratear entre todas las obras activas.

**Lo que se construyó:**
- Checkbox "Gasto general de empresa" en el formulario de gasto
- Conceptos generales: `combustible`, `servicios`, `legal`, `oficina`, `varios_gral`
- Los gastos generales se guardan con `obra_id = null` y `es_gasto_general = true`
- Prorrateo proporcional según el gasto directo de cada obra en el período (mes a mes)
- Badge azul en cada card de obra: "🏛️ +$X empresa → $Y total"
- Total del header mobile incluye gastos generales
- Saldo pendiente incluye gastos generales impagos
- CuentaCorriente de proveedor tiene tab "Gastos" que muestra sus gastos generales
- Modal 📊 "Cierre de obra": historial mes a mes con gastos directos + prorrateo acumulado

**SQL migrations aplicadas:**
```sql
ALTER TABLE gastos ALTER COLUMN obra_id DROP NOT NULL;

ALTER TABLE gastos DROP CONSTRAINT gastos_concepto_check;
ALTER TABLE gastos ADD CONSTRAINT gastos_concepto_check
  CHECK (concepto IN (
    'materiales', 'mano-obra', 'equipos', 'subcontratos', 'varios',
    'combustible', 'servicios', 'legal', 'oficina', 'varios_gral'
  ));
```

---

## Etapa 6 — Tarjeta de Crédito/Débito como Medio de Pago

**Contexto:** SEATE paga proveedores con tarjeta de crédito. El mismo banco puede tener varias tarjetas vinculadas, por lo que se necesita poder etiquetar cada tarjeta y registrar las cuotas.

**Lo que se construyó:**
- Nuevos medios de pago: `tarjeta_credito` y `tarjeta_debito` (el antiguo `tarjeta` se mantiene para compatibilidad con registros anteriores)
- Campo `nota_tarjeta`: descripción libre de la tarjeta (ej: "VISA terminada 1234")
- Campo `cuotas`: número de cuotas (solo para crédito)
- El banco ya existía como campo y se mantiene
- Los campos se muestran condicionalmente según el medio de pago elegido

**SQL migrations aplicadas:**
```sql
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS nota_tarjeta TEXT;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS cuotas INTEGER;

ALTER TABLE pagos DROP CONSTRAINT pagos_medio_pago_check;
ALTER TABLE pagos ADD CONSTRAINT pagos_medio_pago_check
  CHECK (medio_pago IN ('transferencia', 'cheque', 'efectivo', 'tarjeta', 'tarjeta_credito', 'tarjeta_debito'));
```

---

## Etapa 7 — Seguridad: Row Level Security (RLS)

**Contexto:** Supabase envió alerta de seguridad indicando que varias tablas eran accesibles públicamente sin autenticación (cualquiera con la URL del proyecto podía leer/modificar datos).

**Tablas afectadas:** `gastos`, `obras`, `clientes`, `proveedores`, `usuarios`

**Solución aplicada:**
```sql
ALTER TABLE gastos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE obras       ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE proveedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "solo_autenticados" ON gastos      FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "solo_autenticados" ON obras       FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "solo_autenticados" ON clientes    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "solo_autenticados" ON proveedores FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "solo_autenticados" ON usuarios    FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

La Edge Function pasa el JWT del usuario en todas las escrituras, por lo que RLS no rompe nada — todos los usuarios están siempre autenticados.

---

## Etapa 8 — Migración a nueva PC (Julio 2026)

**Contexto:** Daniel migró de PC. El proyecto vive en GitHub y el deploy es automático vía Cloudflare Pages, por lo que la migración es simplemente clonar el repo.

**Nueva ubicación:** `C:\Users\dcras\Documents\Proyectos\gestor-obras`  
**Repo:** `https://github.com/dcrasiuc/GestorObras.git`  
**Archivo de entorno:** `.env.local` (no está en git, se copia manualmente)

---

## Estado actual de la base de datos (Julio 2026)

### Tabla `gastos`
| Columna | Tipo | Notas |
|---|---|---|
| id | uuid | PK |
| obra_id | uuid | NULL permitido (gastos generales) |
| proveedor_id | uuid | |
| concepto | text | CHECK incluye conceptos generales |
| monto | numeric | |
| fecha | date | |
| tipo_comprobante | text | |
| pagado | boolean | |
| es_gasto_general | boolean | true = gasto de empresa |
| ... | | |

### Tabla `pagos`
| Columna | Tipo | Notas |
|---|---|---|
| id | uuid | PK |
| gasto_id | uuid | |
| monto | numeric | |
| fecha_pago | date | |
| medio_pago | text | CHECK incluye tarjeta_credito, tarjeta_debito |
| banco_id | uuid | |
| nota_tarjeta | text | descripción de la tarjeta |
| cuotas | integer | número de cuotas (crédito) |
| comprobante_url | text | URL pública en Storage |
| ... | | |

---

## Etapa 9 — Integración de Seguros (Control de Pólizas) — Agosto 2026

**Contexto:** meses atrás Daniel había armado con Claude un proyecto aparte, `seate-polizas` (React + Vite + Supabase, en `C:\Users\dcras\Documents\Empresas\SEATE\SEATE\SEATE SEGUROS\seate-polizas`), para llevar el control de las garantías de seguro de caución que SEATE presenta ante organismos públicos por cada obra licitada. Vivía en su propio Supabase (`pkjibantkftjcqxldzim`) sin conexión con gestor-obras, nunca se subió a git, y no tenía el patrón de mobile write proxy ni RLS resueltos.

**Decisión:** unificar todo dentro de gestor-obras como una sección nueva ("Seguros"), reusando la misma base de Supabase (`oyqmowolwwjjuarxttuh`) y ligando las pólizas a las obras reales ya existentes, en vez de mantener una tabla `obras` separada.

**Lo que se construyó:**
- Columnas nuevas en `obras`: `organismo`, `monto_contrato`, `etapa` ('oferta' | 'ejecucion'), `estado_licitacion` ('en_curso' | 'recepcion_provisoria' | 'recepcion_definitiva'). La separación entre obras "en oferta" (todavía en licitación, sin gastos) y "en ejecución" existía porque hay pólizas (Mantenimiento de Oferta) que son propias solo de la etapa de licitación.
- Tabla `polizas` (tipo de cobertura, aseguradora, número, monto asegurado, vigencia, estado administrativo) y tabla `poliza_documentos` (para adjuntar la póliza en sí, el comprobante de pago, endosos u otros documentos vinculantes — varios documentos por póliza).
- Bucket de Storage `polizas-documentos`.
- Extensión de la Edge Function `analizar-comprobante`: ahora acepta `tipoAnalisis: 'poliza'` y usa un prompt de IA distinto para leer una foto o PDF de póliza y extraer aseguradora, número, tipo de cobertura, organismo, obra, monto garantizado y fechas de vigencia — mismo patrón de compresión de imagen y upload server-to-server que ya se usaba para comprobantes de gasto.
- Módulo `Seguros.jsx` (standalone, mismo estilo que `CuentaCorriente.jsx`): alta de obras en oferta, carga de pólizas con foto/PDF + autocompletado por IA, adjuntar documentos adicionales a una póliza ya cargada, y un motor de alertas que avisa cuándo corresponde exigir la baja de una póliza (al adjudicarse la obra, al llegar a recepción provisoria o definitiva).
- Se accede desde el botón "🛡️ Seguros" en la topbar (desktop) o desde "Más" (mobile).

**Pendiente de esta etapa:** los datos que hubiera cargados en el Supabase viejo (`pkjibantkftjcqxldzim`) no se migraron — el proyecto estaba pausado (free tier) y no se pudo restaurar porque la cuenta ya tenía 2 proyectos activos (el máximo del plan). Si tenía cargas reales, hace falta liberar un proyecto activo y volver a intentarlo.

---

## Etapa 10 — Seguros: aseguradora vs. corredor, baja en dos pasos, cuenta corriente y "experto en pólizas" — Agosto 2026

**Contexto:** después de ver la primera versión de Seguros, Daniel pidió una segunda ronda de ajustes, todos en la misma conversación: distinguir quién es la aseguradora de quién es el corredor; separar "ya le pedimos la baja a la aseguradora" de "la aseguradora ya la confirmó"; poder armar una cuenta corriente con cada aseguradora; un lugar para subir la recepción de obra y otro para la confirmación de baja firmada; que el pago de una póliza se refleje como gasto de la obra; y, en una tercera ronda, que la IA actúe como un experto en seguros (tipo de vigencia, si requiere final de obra, cláusula de repetición, cláusulas especiales, descripción de la póliza), poder editar/eliminar una póliza cargada, sumar tipos de documento (cuponera, factura, certificación, legalización) y poder descargar la documentación desde la app.

**Lo que se construyó:**
- `polizas.corredor` y `polizas.prima` separados de `aseguradora`/`monto_asegurado`; el prompt de IA de pólizas ahora distingue explícitamente "compañía aseguradora" de "corredor/productor".
- `polizas.estado_admin` pasó a 4 valores: `activa` → `baja_presentada` (se le presentó a la aseguradora el acta de recepción de obra pidiendo la baja) → `dada_de_baja` (la aseguradora ya la confirmó) → `vencida`. Dos modales nuevos: `ModalRecepcionObra` (sube el acta de recepción provisoria/definitiva, queda en `obras.recepcion_provisoria_url`/`recepcion_definitiva_url`) y `ModalConfirmarBaja` (registra la confirmación de la aseguradora, opcionalmente con el documento firmado).
- Tabla `pagos_poliza` + vista "💳 Cuenta corriente" en `Seguros.jsx`: agrupa pólizas y pagos por aseguradora o por corredor (toggle), con prima total/pagado/saldo teórico por grupo y por póliza.
- Pago de una prima (`ModalPagoPoliza`) ahora genera automáticamente un `gastos` (concepto `'seguros'`) + `pagos` en la obra, además del `pagos_poliza` — se ve tanto en la contabilidad de la obra como en la cuenta corriente con la aseguradora.
- Las pólizas se muestran anidadas dentro de cada obra (ya no como lista aparte), y la lista de obras por default sólo muestra las "vigentes" (no llegaron a Recepción Definitiva), con opción de mostrar las finalizadas.
- **Experto en seguros:** nuevos campos `tipo_vigencia` (única vez vs. renovable), `requiere_final_obra`, `clausula_repeticion` (sin/con derecho de repetición) y `descripcion_ia` (resumen auto-generado y editable), con valores por defecto según el tipo de cobertura y extracción por IA con un prompt reescrito como "experto en seguros de caución" que interpreta el documento en vez de solo transcribirlo. Se agregó también un chequeo de calidad de datos client-side (`detectarAdvertencias`) independiente de la IA.
- `ModalPoliza` ahora sirve para alta y edición; se agregó "🗑️ Eliminar" póliza (borra documentos y desvincula pagos, sin borrar los gastos ya generados).
- Nuevos tipos de documento: cuponera, factura, certificación, legalización (además de póliza/comprobante/endoso/baja). Todos los documentos adjuntos ahora se listan con link de descarga directa.
- Se encontró y corrigió una obra duplicada real: "8360 Mojones" y "Mojones EBY" eran la misma obra (mismo organismo EBY, misma garantía de ejecución de contrato) cargada dos veces porque la IA no reconoció el nombre al leer una póliza — se fusionaron manualmente.
- Se detectó que las obras "en oferta" (creadas desde Seguros, sin adjudicar) ya aparecían mezcladas con las obras reales en el panel principal, en los dropdowns de gastos y en `CuentaCorriente.jsx` de proveedores — se corrigió filtrando `etapa != 'oferta'` en `obras_resumen` y en las consultas de obras de `GestorObras.jsx`/`CuentaCorriente.jsx`. Recién al marcar una obra "adjudicada" desde Seguros pasa a aparecer en el resto de la app.

---

## Etapa 11 — Seguros: anticipo financiero vs. cumplimiento, auto-renovación por período, facturas/cuponeras y saneamiento de datos de IA — Agosto 2026

**Contexto:** revisando la app ya en uso real (con capturas de pantalla y una póliza real subida), Daniel identificó varios problemas de precisión y de UX en Seguros, todos ajustados en la misma sesión.

**Lo que se construyó:**
- `tipo_cobertura` sumó `anticipo_financiero` como valor propio (antes se mezclaba con `ejecucion_contrato`, que se relabeleó "Cumplimiento de Contrato") — son garantías distintas con reglas de baja distintas (anticipo se amortiza contra certificados, no espera recepción).
- Matching de obra al leer una póliza con IA: si el nombre no matchea fuerte con ninguna obra existente pero hay candidatas parecidas, se pregunta antes de ofrecer crear una obra nueva (evita duplicados como el caso real "8360 Mojones"/"Mojones EBY" de la etapa anterior).
- `obras.requiere_poliza` (default true) para marcar obras menores/privadas sin garantía exigible.
- Alerta dedicada + filtro para obras marcadas "Finalizada" en el panel de Obras que todavía tienen pólizas sin dar de baja.
- **Auto-renovación por períodos:** muchas cauciones "hasta la recepción" en realidad las emite la aseguradora por períodos fijos (90/180 días) que se renuevan solos con una prima nueva si no se presenta la recepción a tiempo — y a veces esa renovación se anula retroactivamente si la recepción tiene fecha anterior al corte. Se modeló con `polizas.se_autorenueva`/`duracion_periodo_dias` + tabla nueva `renovaciones_poliza` (cargos de renovación, separados de los pagos), aplicando solo a los tipos atados a un hito de obra (no a mantenimiento de oferta ni RC).
- **Bug real de la IA corregido:** en una póliza de Anticipo Financiero sin prima rotulada explícitamente, la IA tomó el "T.C.N." (un dato de costos del corredor, no la prima) y lo cargó como si fuera la prima, sin poder el usuario verificar de dónde salió. Se agregó `polizas.prima_fuente` (la IA debe copiar la etiqueta literal de donde sacó el número) y el prompt ahora exige `null` si no hay una etiqueta explícita de "PRIMA"/"PREMIO" — con advertencia visible en la app si la fuente no es confiable.
- **Factura y cuponera como fuente real del monto a pagar:** botón dedicado "+ Factura" (separado de "+ Documento" y "+ Registrar pago") que lee la factura con IA y genera un gasto PENDIENTE en la obra; al registrar el pago real, si hay una factura pendiente se liquida ESA (no se duplica el gasto). El comprobante de "+ Registrar pago" también acepta una cuponera y se lee con IA, comparando el monto contra la prima esperada de la póliza.
- UI: `FilaObra`/`FilaPoliza` ahora arrancan colapsadas por defecto (antes mostraban todo el detalle siempre, muy largo con varias pólizas por obra) — colapsada solo se ve tipo de cobertura + vencimiento + alertas; el resto aparece al expandir.
- Botón "⬇️ Descargar todo (.zip)" por póliza: junta todos los documentos + comprobantes de pago en un único .zip (JSZip vía CDN), con archivos renombrados `{obra}_{nroPoliza}_{tipo}_N`.
- Cuenta corriente: subtotales por aseguradora Y por corredor visibles siempre lado a lado (antes solo uno a la vez con el toggle).
- Edge Function `analizar-comprobante` en v36 (desde v33 al inicio de esta etapa).

---

## Pendientes futuros

- **Permisos multi-usuario**: rol administrador vs. operario
- **Informe PDF** por obra (resumen de gastos y estado)
- **Módulo vencimiento de tarjeta de compras**
- **CuentaCorriente de clientes** (cobros por obra)
- **Seguros**: badge de etapa/organismo visible también en el panel general de Obras; Realtime propio; migrar datos del proyecto viejo si corresponde
