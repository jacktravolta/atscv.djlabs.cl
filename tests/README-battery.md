# Batería E2E de CV ATS Match

`tests/atscv-battery.mjs` ejecuta recorridos reales de CV ATS Match contra
`https://atscv.djlabs.cl/` con Chrome y CDP. No usa Playwright, Puppeteer ni
ninguna otra dependencia nueva: el cliente CDP y el acceso a MySQL están
incluidos en el propio script.

## Qué verifica cada ronda

Cada ronda crea una cuenta nueva y termina eliminándola desde la interfaz:

1. envío del formulario de contacto;
2. registro con bono inicial;
3. cierre de sesión desde el panel;
4. inicio de sesión;
5. carga del panel y lectura del saldo;
6. alta del CV y de la oferta en uno de los tres modos;
7. análisis ATS contra la oferta;
8. selección de plantilla;
9. generación del CV adaptado y de la carta;
10. descarga y validación de ambos PDF;
11. carta adicional solicitada al chat del asistente;
12. baja desde Perfil con la confirmación `BORRAR`;
13. comprobación de `GET /auth/me` con HTTP 401;
14. intento de login posterior, que debe seguir rechazado;
15. comprobación en MySQL de que no quedan filas de usuario ni de sus datos;
16. cierre de sesión final, si todavía queda una sesión abierta.

Los PDF se validan por HTTP 200, cabecera `%PDF` y tamaño mayor de 1 KB. La
baja se verifica tanto en la API como en la base de datos. La fila de
`account_deletion_log` y el registro antifraude de
`welcome_bonus_grantees` se conservan a propósito: el primero deja evidencia
de la baja y el segundo impide entregar otra vez el bono de bienvenida.

## Requisitos

- Node.js 22 o superior, con `WebSocket` global;
- Google Chrome instalado y disponible como `google-chrome`, o `CHROME_BIN`
  apuntando al binario;
- `mysql` disponible en `PATH`;
- el checkout de `api-independent`, porque el script lee de ahí la
  configuración de la base de datos y comprueba las filas tras la baja;
- credenciales de MySQL configuradas en `api-independent/config/config.php`.

No hay que instalar dependencias del proyecto para ejecutar la batería.

## Ejecución recomendada

Empieza siempre con una sola ronda y un identificador nuevo:

```bash
cd /home/test/test/atscv-independent
ROUNDS=1 RUN_ID=smoke-local CONCURRENCY=1 node tests/atscv-battery.mjs
```

Para la corrida completa:

```bash
ROUNDS=100 RUN_ID=battery-2026-11-17 CONCURRENCY=1 node tests/atscv-battery.mjs
```

`RUN_ID` forma parte del correo temporal de cada cuenta. Usa uno nuevo para
cada intención de prueba: el registro antifraude del bono puede impedir
reutilizar un correo que ya consumió el bono de bienvenida.

La corrida completa genera contactos, correos de bienvenida y llamadas reales
al modelo. Revisa los costos y el volumen de correo antes de iniciarla.

## Modos de carga

Las rondas alternan automáticamente entre:

- `archivo`: PDF local del CV y PDF local de la oferta;
- `url`: páginas HTML públicas de los fixtures;
- `texto`: CV y oferta escritos en los campos de texto.

Para una corrida de 100 rondas quedan 34 de archivo, 33 de URL y 33 de texto.
El script no modifica fixtures, front, CSS ni JavaScript de la aplicación.

## Datos nuevos en cada ronda

Cada ronda genera su propio CV y su propia oferta: no se repite ni un solo
documento entre las 100 pruebas.

- La semilla combina `RUN_ID` y el número de ronda (`xmur3` + `mulberry32`),
  así que reanudar una corrida reproduce exactamente los mismos datos.
- Hay seis perfiles profesionales (analista de datos, QA, backend, soporte,
  marketing y logística). Cada ronda cambia nombre, ciudad, empresas, años de
  experiencia, logros numéricos, herramientas, condiciones y brechas entre el
  CV y la oferta.
- La `huella` de la ronda es el SHA-256 (16 hex) de `CV + oferta`. Se registra
  en `round_started` y en `round_completed`, y sirve para comprobar que las
  100 rondas usaron datos distintos.
- El modo `texto` escribe esos textos en los campos; el modo `archivo` genera
  un PDF mínimo por documento (texto seleccionable en Helvetica, sin
  dependencias: el front lo extrae con pdf.js); el modo `url` publica un HTML
  por documento.

### Dónde se publican los HTML del modo URL

El lector de URL del producto descarga la página desde internet, así que los
HTML se publican en el docroot público de la API:

```text
<API_REPO>/public/atscv/_battery/<RUN_ID>/cv-<ronda>.html
<API_REPO>/public/atscv/_battery/<RUN_ID>/oferta-<ronda>.html
```

Se sirven como `https://api.djlabs.cl/atscv/_battery/<RUN_ID>/<archivo>`.
Al terminar la corrida se borra SOLO la carpeta `<RUN_ID>`; la carpeta padre
`_battery` nunca se toca. Con `FIXTURE_PUBLIC_BASE` se puede apuntar a otra
base pública.

La carpeta `public/atscv/_battery/` está en `.git/info/exclude` del checkout de
la API: los fixtures no se commitean.

### Verificación local del generador

```bash
BATTERY_DRY_DATA=1 ROUNDS=100 RUN_ID=verificacion-100 node tests/atscv-battery.mjs
```

No abre Chrome ni toca la API: comprueba que las 100 rondas tengan huellas
distintas y deja un PDF de muestra en el directorio temporal.

## Variables de entorno

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `ROUNDS` | `1` | Número de rondas, entre 1 y 1000. |
| `RUN_ID` | `run-<timestamp>` | Identificador de corrida; se normaliza para usarlo en rutas y correos. |
| `CONCURRENCY` | `1` | Rondas simultáneas, entre 1 y 8. Se recomienda 1 para una primera ejecución. |
| `RESUME` | `1` | Si vale `1`, omite las rondas ya registradas en el JSONL. Con `0`, rechaza un log que ya contenga rondas terminadas. |
| `BASE_URL` | `https://atscv.djlabs.cl/` | Front real. El script solo acepta ese dominio HTTPS. |
| `API_REPO` | `/home/test/test/api-independent` | Checkout de la API usado para leer la configuración y consultar MySQL. |
| `CHROME_BIN` | `google-chrome` | Binario de Chrome. |
| `HEADFUL` | sin valor | Usa `HEADFUL=1` para abrir Chrome con interfaz visible. |

La API no está codificada en el arnés: se lee `window.__API_BASE__` desde el
front real y se registra en el JSONL al iniciar cada ronda.

## Evidencia y reanudación

Toda la evidencia se escribe bajo `tests/artifacts/`, que está ignorado por
Git:

```text
tests/artifacts/
├── battery-<RUN_ID>.jsonl
├── battery-<RUN_ID>.summary.json
└── battery-<RUN_ID>/
    └── round-<n>/
        ├── responses/
        ├── downloads/
        └── fallos/
```

- El JSONL solo agrega líneas. Cada ronda terminada registra su estado,
  fallos, operaciones observadas y verificación de baja.
- `battery-<RUN_ID>.summary.json` contiene los contadores agregados y la lista
  de rondas fallidas.
- `responses/` conserva las respuestas HTTP y el cuerpo recibido.
- `downloads/` conserva los dos PDF y sus metadatos de validación.
- `fallos/` conserva HTML, captura y JSON del paso que falló.

Para reanudar la misma corrida:

```bash
ROUNDS=100 RUN_ID=battery-2026-11-17 CONCURRENCY=1 RESUME=1 \
  node tests/atscv-battery.mjs
```

El resumen reconstruye los contadores de las rondas omitidas a partir del
JSONL. No borra ni reescribe rondas anteriores.

## Límites que limpia el arnés

Antes de cada ronda, el script borra solamente estas claves globales de
`rate_limits`:

- `auth:login:%`
- `contact:ip:%`
- `auth:refresh:%`
- `voucher_verify:ip:%`

No toca los límites por usuario de ATSCV, incluidos `atscv:user:%`,
`atscv:gen:user:%` y `atscv:url:user:%`. El objetivo es permitir que la
cuenta nueva atraviese los límites globales de acceso, sin alterar los
límites de consumo del producto.

## Modo URL: bloque ya resuelto

El 17 de noviembre de 2026 se comprobó un defecto del producto en producción,
no del arnés: la API respondía `URL inválida. Debe incluir el esquema y el
dominio.` ante una URL que sí era válida.

**Causa:** GitHub Pages sirve los `.html` con URL limpia, así que el fixture
responde `307` con un `Location` **relativo** (`/tests/fixtures/cv-battery`).
El re-chequeo anti-SSRF recibía esa referencia sin resolver y la tomaba por
una URL sin esquema ni dominio → rechazo.

**Corrección:** el `Location` se resuelve contra la URL efectiva del salto
anterior antes de volver a validar (commit `314fb42` en api-independent, ya
en producción).

**Verificación:** el 18 de noviembre de 2026 se corrieron 2 rondas del arnés
contra el dominio real (modos `archivo` y `url`): **2/2 OK**, con
`cv-oferta-modo-url` en verde y el paso de chat en verde. El script conserva
la respuesta real en `responses/desde-url-cv.json`.

## Comprobaciones antes de entregar

```bash
node --check tests/atscv-battery.mjs
git diff --check
git status --short
```

Una ronda terminada correctamente debe mostrar en el JSONL:

- `step_completed` para el análisis, la generación, las descargas, el chat y
  la baja;
- `GET /auth/me` con estado 401 después de eliminar la cuenta;
- login posterior con estado 401;
- `users=0`, cero filas en las tablas de datos verificadas y al menos una fila
  en `account_deletion_log` y en `welcome_bonus_grantees`;
- `status=ok` y `deletionVerified=true` en `round_completed`.
