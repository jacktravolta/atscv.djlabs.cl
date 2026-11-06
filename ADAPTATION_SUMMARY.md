# Adaptación Front Ley Laboral — estado real verificado

## Origen
Clon completo de `leydatos.djlabs.cl` → `/home/test/test/controldecarroceria/leylaboral`

## Corazón leylaboral — CREADO Y VERIFICADO EN DB
- Seeder nuevo: `api.djlabs.cl/bin/seed-leylaboral-heart.php` (patrón de `seed-cotizaia-heart.php`, CLI-only, idempotente).
- Verificado en `asistente_judicial` (MySQL 3306):
  - `heart_settings`: site_title=Asistente Laboral, site_skin=indigo, welcome_bonus_credits=100
  - `heart_personas`: authenticated (1493 chars, system_laboral_b2c_v1 + contrato de empatía) y anonymous (480 chars)
  - `tariffs` (heart-scoped, activas): chat_simple=1, chat_doc=1 (SIP: chat consume 1 crédito), laboral_document=3
- Bug corregido en el seeder: `TariffService::current()` hace fallback a filas GLOBALES (heart_id NULL: chat 8/15). Hay que validar `heart_id` de la fila devuelta antes de saltarse la creación.
- Resolución de corazón: `HeartResolver` honra el heart por request SOLO en `development` (config local: `app.env=development` → OK local). En producción: una instalación = un corazón (`HEART_ID=leylaboral` en su propio deploy).

## Correcciones aplicadas al front (defectos del agente anterior)
- `sed` ciego había dejado: "Asistente Laboral 21.719", "Tu sitio web, al día con la Asistente Laboral", Ley 21.719 en hero/SVG/cómo-funciona/qué-ofrece. Corregido a copy laboral (Código del Trabajo / BCN).
- Títulos sin actualizar: `verificar.html`, `contrasena.html` → Asistente Laboral.
- `debug-sources.html` con heart huérfano `ley_datos_21719` → `leylaboral`.
- `.htaccess` y `README.md` encabezados → leylaboral.djlabs.cl / Asistente Laboral.
- `app.html`: widget de chat "Asistente Ley 21.719" + welcome → "Asistente Laboral" + copy laboral.
- Todos los `heart_id` defaults: `ley_datos_21719` → `leylaboral` (index.html, app.html, README).

## PENDIENTE (build real — NO hecho todavía)
1. **API**: endpoints `/v1/laboral/classify`, `/v1/laboral/chat`, `/v1/laboral/document/generate`, `/v1/laboral/calculo/finiquito` NO existen (grep: 0 matches en app/).
2. **RAG**: colección `chile_laboral` sin ingestar (02_INGESTA_BCN.md: CT artículos 7-13, 21-40bis, 159-171, 184, 211-A a 211-E; Ley 21.561; 21.643; 21.645; 19.728; dictámenes DT).
3. **Front funcional** (06_FRONT_SPEC.md): quick replies B2C, formulario inline `faltan_datos`, sidebar "Base legal usada", cards CTA documento 3 créditos, panel /mis-documentos, selector de producto. El landing aún conserva el escáner de sitios de ley-datos (funcional pero de OTRO producto) y sus ilustraciones.
4. **Plantillas DOCX/PDF** para los 4 documentos (04_SCHEMAS_DOCUMENTOS.json).
5. **E2E en vivo**: registro→100 créditos, login, carga saldo, consulta con citas BCN, generación de escrito. Sin ejecutar (la API no estaba levantada; el front estático corre en :8001).
6. Términos/privacidad del modal legal aún describen el producto de escaneo (texto legal pendiente).

## Comprobación
- Servidor estático: `python3 -m http.server 8001` (200 OK).
- Seeder: ejecutado 2×; idempotente (segunda pasada solo versiona lo que falta).
- Verificación DB: query directa sobre `tariffs`, `heart_settings`, `heart_personas`.
