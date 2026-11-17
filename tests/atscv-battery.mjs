#!/usr/bin/env node
// =============================================================================
// tests/atscv-battery.mjs — batería E2E de recorridos reales de CV ATS Match
//
// Un recorrido = una persona nueva = una cuenta eliminada al final.
// El arnés habla con el front real mediante Chrome/CDP, usa el WebSocket global
// de Node 22 y no instala dependencias. Todas las llamadas al modelo son reales.
//
// Variables principales:
//   ROUNDS=1 CONCURRENCY=1 RUN_ID=smoke-1 BASE_URL=https://atscv.djlabs.cl/
//   RESUME=1 API_REPO=/ruta/al/api HEADFUL=1
// =============================================================================

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');
const DEFAULT_BASE_URL = 'https://atscv.djlabs.cl/';
const UI_TIMEOUT_MS = 60_000;
const LLM_TIMEOUT_MS = 5 * 60_000;
const HEART = 'atscv';
const MODOS = ['archivo', 'url', 'texto'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function enteroEnv(nombre, valorPorDefecto, minimo, maximo) {
  const valor = Number.parseInt(process.env[nombre] ?? String(valorPorDefecto), 10);
  if (!Number.isInteger(valor) || valor < minimo || valor > maximo) {
    throw new Error(`${nombre} debe ser un entero entre ${minimo} y ${maximo}`);
  }
  return valor;
}

function nombreSeguro(valor) {
  return String(valor || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
}

const ROUNDS = enteroEnv('ROUNDS', 1, 1, 1000);
const CONCURRENCY = enteroEnv('CONCURRENCY', 1, 1, 8);
const RUN_ID = nombreSeguro(process.env.RUN_ID || `run-${Date.now()}`);
const RESUME = (process.env.RESUME ?? '1') !== '0';
const API_REPO = path.resolve(process.env.API_REPO || '/home/test/test/api-independent');
const CHROME_BIN = process.env.CHROME_BIN || 'google-chrome';
const HEADFUL = process.env.HEADFUL === '1';
const BASE_URL_RAW = process.env.BASE_URL || DEFAULT_BASE_URL;

let BASE_URL;
try {
  BASE_URL = new URL(BASE_URL_RAW).toString();
  if (!BASE_URL.endsWith('/')) BASE_URL += '/';
} catch {
  throw new Error(`BASE_URL no es una URL válida: ${BASE_URL_RAW}`);
}
if (new URL(BASE_URL).protocol !== 'https:' || new URL(BASE_URL).hostname !== 'atscv.djlabs.cl') {
  throw new Error('BASE_URL debe apuntar siempre a https://atscv.djlabs.cl/');
}

const JSONL_PATH = path.join(ARTIFACTS, `battery-${RUN_ID}.jsonl`);
const SUMMARY_PATH = path.join(ARTIFACTS, `battery-${RUN_ID}.summary.json`);
const RUN_DIR = path.join(ARTIFACTS, `battery-${RUN_ID}`);
mkdirSync(ARTIFACTS, { recursive: true });
mkdirSync(RUN_DIR, { recursive: true });

const resumenGlobal = {
  runId: RUN_ID,
  baseUrl: BASE_URL,
  roundsRequested: ROUNDS,
  roundsCompleted: 0,
  roundsOk: 0,
  roundsFailed: 0,
  resumedRoundsSkipped: 0,
  accountsDeleted: 0,
  accountsDeletionVerified: 0,
  contactEmailsSent: 0,
  llmHttpOperationsObserved: 0,
  llmCallsEstimated: 0,
  downloadsVerified: 0,
  failedRounds: [],
};

function ahora() {
  return new Date().toISOString();
}

function registrarEvento(tipo, datos = {}) {
  const evento = { timestamp: ahora(), runId: RUN_ID, type: tipo, ...datos };
  appendFileSync(JSONL_PATH, `${JSON.stringify(evento)}\n`, 'utf8');
  return evento;
}

function leerCompletadas() {
  const completadas = new Map();
  if (!existsSync(JSONL_PATH)) return completadas;
  const lineas = readFileSync(JSONL_PATH, 'utf8').split('\n');
  for (const linea of lineas) {
    if (!linea.trim()) continue;
    try {
      const evento = JSON.parse(linea);
      if (evento.type === 'round_completed' && Number.isInteger(evento.round)) {
        completadas.set(evento.round, evento);
      }
    } catch {
      // Una línea dañada no debe impedir reanudar las rondas válidas.
    }
  }
  return completadas;
}

function redactar(valor, clave = '') {
  if (/token|password|contrase|secret|authorization|cookie/i.test(clave)) return '[REDACTADO]';
  if (Array.isArray(valor)) return valor.map((item) => redactar(item));
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, redactar(v, k)]));
  }
  return valor;
}

function guardarRespuesta(roundDir, etiqueta, respuesta) {
  if (!respuesta) return;
  const dir = path.join(roundDir, 'responses');
  mkdirSync(dir, { recursive: true });
  const seguro = redactar(respuesta);
  writeFileSync(
    path.join(dir, `${nombreSeguro(etiqueta)}.json`),
    JSON.stringify(seguro, null, 2),
    'utf8',
  );
}

function textoVisible(selector) {
  const nodo = document.querySelector(selector);
  return nodo ? (nodo.textContent || '').replace(/\s+/g, ' ').trim() : '';
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
  }

  async connect(timeoutMs = 15_000) {
    if (typeof WebSocket !== 'function') {
      throw new Error('Node no expone el WebSocket global requerido (usa Node 22)');
    }
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => reject(new Error('Tiempo agotado al conectar CDP')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('No se pudo abrir la conexión CDP'));
      }, { once: true });
    });

    this.ws.addEventListener('message', (event) => {
      let mensaje;
      try {
        mensaje = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (mensaje.id && this.pending.has(mensaje.id)) {
        const pendiente = this.pending.get(mensaje.id);
        this.pending.delete(mensaje.id);
        clearTimeout(pendiente.timer);
        if (mensaje.error) {
          pendiente.reject(new Error(`${pendiente.method}: ${mensaje.error.message || JSON.stringify(mensaje.error)}`));
        } else {
          pendiente.resolve(mensaje.result || {});
        }
        return;
      }
      if (mensaje.method) {
        for (const listener of this.listeners) listener(mensaje);
      }
    });
  }

  call(method, params = {}, sessionId = undefined, timeoutMs = 30_000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('CDP no está conectado'));
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tiempo agotado en ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    try {
      if (this.ws && this.ws.readyState <= 1) this.ws.close();
    } catch {
      // El cierre es best-effort.
    }
  }
}

class CdpPage {
  constructor(connection, sessionId, contextId, targetId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.contextId = contextId;
    this.targetId = targetId;
    this.responses = [];
    this.responseByRequest = new Map();
    this.requestByRequest = new Map();
    this.consoleErrors = [];
    this.unsubscribe = null;
  }

  async initialize() {
    await this.call('Page.enable');
    await this.call('Runtime.enable');
    await this.call('Network.enable');
    await this.call('Log.enable');
    await this.call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });

    this.unsubscribe = this.connection.on((mensaje) => {
      if (mensaje.sessionId !== this.sessionId) return;
      if (mensaje.method === 'Network.requestWillBeSent') {
        const { requestId, request } = mensaje.params;
        const requestUrl = request?.url || '';
        this.requestByRequest.set(requestId, {
          method: request?.method || 'UNKNOWN',
          requestUrl,
          // Solo guardamos el cuerpo del endpoint que queremos diagnosticar.
          // El resto lleva CV y oferta completos: no se copian a la evidencia.
          postData: requestUrl.includes('/v1/cv-ats/desde-url') ? (request?.postData || '') : '',
        });
      }
      if (mensaje.method === 'Network.responseReceived') {
        const { requestId, response } = mensaje.params;
        const request = this.requestByRequest.get(requestId);
        this.responseByRequest.set(requestId, {
          url: response.url,
          method: request?.method || 'UNKNOWN',
          requestUrl: request?.requestUrl || response.url,
          postData: request?.postData || '',
          status: response.status,
          statusText: response.statusText,
          headers: response.headers || {},
          mimeType: response.mimeType,
        });
      }
      if (mensaje.method === 'Network.loadingFinished') {
        void this.capturarCuerpo(mensaje.params.requestId);
      }
      if (mensaje.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(mensaje.params.exceptionDetails?.text || 'Excepción sin detalle');
      }
      if (mensaje.method === 'Log.entryAdded' && mensaje.params.entry?.level === 'error') {
        this.consoleErrors.push(mensaje.params.entry.text || 'Error de log sin detalle');
      }
    });
  }

  async capturarCuerpo(requestId) {
    const base = this.responseByRequest.get(requestId);
    if (!base) return;
    let body = '';
    let bodyBase64Encoded = false;
    try {
      const resultado = await this.call('Network.getResponseBody', { requestId });
      body = resultado.base64Encoded ? Buffer.from(resultado.body || '', 'base64').toString('utf8') : (resultado.body || '');
      bodyBase64Encoded = Boolean(resultado.base64Encoded);
    } catch {
      body = '';
    }
    this.responses.push({ ...base, body, bodyBase64Encoded, receivedAt: ahora() });
    this.responseByRequest.delete(requestId);
    this.requestByRequest.delete(requestId);
  }

  call(method, params = {}, timeoutMs = 30_000) {
    return this.connection.call(method, params, this.sessionId, timeoutMs);
  }

  async evaluate(expression, timeoutMs = UI_TIMEOUT_MS) {
    const trimmed = expression.trim();
    const necesitaFuncion = trimmed.startsWith('return ')
      || (!trimmed.startsWith('(') && /\breturn\b/.test(trimmed));
    const source = necesitaFuncion ? `(() => { ${expression} })()` : expression;
    const resultado = await this.call('Runtime.evaluate', {
      expression: source,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs);
    if (resultado.exceptionDetails) {
      const detalle = resultado.exceptionDetails.exception?.description
        || resultado.exceptionDetails.text
        || 'excepción sin detalle';
      throw new Error(`Error de JavaScript: ${detalle} (${JSON.stringify(resultado.exceptionDetails)})`);
    }
    return resultado.result?.value;
  }

  async waitFor(expression, timeoutMs = UI_TIMEOUT_MS, description = 'condición') {
    const limite = Date.now() + timeoutMs;
    let ultimo;
    while (Date.now() < limite) {
      try {
        ultimo = await this.evaluate(`return (${expression});`, 10_000);
        if (ultimo) return ultimo;
      } catch (error) {
        ultimo = error.message;
      }
      await sleep(250);
    }
    throw new Error(`Tiempo agotado esperando ${description}${ultimo ? ` (${ultimo})` : ''}`);
  }

  async navigate(url) {
    const respuesta = await this.call('Page.navigate', { url });
    if (respuesta.errorText) throw new Error(`No se pudo abrir ${url}: ${respuesta.errorText}`);
    await this.waitFor(
      `document.readyState === 'complete' && location.href.startsWith(${JSON.stringify(new URL(url).origin)})`,
      UI_TIMEOUT_MS,
      `carga de ${url}`,
    );
  }

  async setValue(selector, value) {
    const ok = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(String(value))});
      else el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`No existe el campo ${selector}`);
  }

  async setChecked(selector, checked) {
    const ok = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.checked = ${checked ? 'true' : 'false'};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`No existe el checkbox ${selector}`);
  }

  async click(selector, timeoutMs = UI_TIMEOUT_MS) {
    await this.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, timeoutMs, selector);
    const info = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const encima = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        visible: r.width > 0 && r.height > 0,
        tapado: !(encima && (encima === el || el.contains(encima))),
        encima: encima ? (encima.id || encima.tagName) : '',
      };
    })()`);
    if (!info) throw new Error(`No existe ${selector}`);
    if (!info.visible || info.tapado) {
      await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click(); return true;`);
      return { fallback: true, ...info };
    }
    await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 });
    await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 });
    return { fallback: false, ...info };
  }

  async setFile(selector, filePath) {
    if (!existsSync(filePath)) throw new Error(`No existe el fixture ${filePath}`);
    const bytes = readFileSync(filePath);
    const base64 = bytes.toString('base64');
    const nombre = path.basename(filePath);
    const mime = filePath.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
    const asignado = await this.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      const binary = atob(${JSON.stringify(base64)});
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], ${JSON.stringify(nombre)}, { type: ${JSON.stringify(mime)} });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dataset.bateriaProbe = 'before';
      input.addEventListener('change', () => { input.dataset.bateriaProbe = 'event'; }, { once: true });
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: input.files.length === 1 && input.files[0].name === ${JSON.stringify(nombre)},
        probe: input.dataset.bateriaProbe || '',
        inputCount: document.querySelectorAll(${JSON.stringify(selector)}).length,
      };
    })()`);
    if (!asignado?.ok) throw new Error(`Chrome no asignó el fixture a ${selector}: ${JSON.stringify(asignado)}`);
    await sleep(750);
    const estado = await this.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      const chip = document.querySelector(${JSON.stringify(selector === '#cv-input' ? '#cv-chip' : '#oferta-chip')});
      const name = document.querySelector(${JSON.stringify(selector === '#cv-input' ? '#cv-chip-name' : '#oferta-chip-name')});
      const error = document.querySelector(${JSON.stringify(selector === '#cv-input' ? '#cv-error' : '#oferta-error')});
      const progress = document.querySelector(${JSON.stringify(selector === '#cv-input' ? '#cv-progress-label' : '#oferta-progress-label')});
      return {
        files: input?.files?.length || 0,
        fileName: input?.files?.[0]?.name || '',
        chipClass: chip?.className || '',
        chipName: (name?.textContent || '').trim(),
        error: (error?.textContent || '').trim(),
        progress: (progress?.textContent || '').trim(),
        resources: performance.getEntriesByType('resource').map((item) => item.name).filter((url) => url.includes('pdfjs') || url.includes('jsdelivr')),
        inputCount: document.querySelectorAll(${JSON.stringify(selector)}).length,
        probe: input?.dataset?.bateriaProbe || '',
      };
    })()`);
    registrarEvento('file_assignment', { selector, file: nombre, estado });
  }

  async response(fragment, afterIndex = -1, timeoutMs = UI_TIMEOUT_MS) {
    const limite = Date.now() + timeoutMs;
    while (Date.now() < limite) {
      const encontrada = [...this.responses]
        .slice(afterIndex + 1)
        .reverse()
        .find((item) => item.url.includes(fragment) && item.method !== 'OPTIONS');
      if (encontrada) return encontrada;
      await sleep(200);
    }
    return null;
  }

  async screenshot(filePath) {
    try {
      const { data } = await this.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(filePath, Buffer.from(data, 'base64'));
    } catch {
      // La captura es evidencia best-effort; el error original manda.
    }
  }

  async html(filePath) {
    try {
      const html = await this.evaluate('return document.documentElement.outerHTML;', 30_000);
      writeFileSync(filePath, String(html || ''), 'utf8');
    } catch {
      // La captura del DOM es evidencia best-effort.
    }
  }

  async close() {
    if (this.unsubscribe) this.unsubscribe();
  }
}

async function puertoLibre() {
  return new Promise((resolve, reject) => {
    const servidor = net.createServer();
    servidor.unref();
    servidor.on('error', reject);
    servidor.listen(0, '127.0.0.1', () => {
      const puerto = servidor.address().port;
      servidor.close(() => resolve(puerto));
    });
  });
}

async function lanzarChrome() {
  const puerto = await puertoLibre();
  const perfil = path.join('/tmp/opencode', `atscv-battery-${RUN_ID}-${process.pid}-${Date.now()}`);
  mkdirSync(perfil, { recursive: true });
  const args = [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${puerto}`,
    `--user-data-dir=${perfil}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=390,844',
    'about:blank',
  ];
  if (!HEADFUL) args.unshift('--headless=new');

  const proceso = spawn(CHROME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proceso.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-12_000);
  });
  proceso.on('error', (error) => {
    stderr = `${stderr}\n${error.message}`;
  });

  let version;
  const limite = Date.now() + 20_000;
  while (Date.now() < limite) {
    try {
      const response = await fetch(`http://127.0.0.1:${puerto}/json/version`);
      if (response.ok) {
        version = await response.json();
        break;
      }
    } catch {
      // Chrome aún está arrancando.
    }
    await sleep(200);
  }
  if (!version?.webSocketDebuggerUrl) {
    try { proceso.kill('SIGKILL'); } catch { /* best-effort */ }
    throw new Error(`Chrome no abrió el puerto CDP ${puerto}. Diagnóstico: ${stderr.slice(-2000)}`);
  }

  const connection = new CdpConnection(version.webSocketDebuggerUrl);
  await connection.connect();

  async function createPage() {
    const { browserContextId } = await connection.call('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await connection.call('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const { sessionId } = await connection.call('Target.attachToTarget', { targetId, flatten: true });
    const page = new CdpPage(connection, sessionId, browserContextId, targetId);
    await page.initialize();
    return page;
  }

  async function disposePage(page) {
    await page.close();
    try {
      await connection.call('Target.disposeBrowserContext', { browserContextId: page.contextId });
    } catch {
      // Si Chrome ya cayó, no hay contexto que liberar.
    }
  }

  async function close() {
    try {
      await connection.call('Browser.close', {}, undefined, 5_000);
    } catch {
      // best-effort
    }
    connection.close();
    await sleep(300);
    try { proceso.kill('SIGTERM'); } catch { /* best-effort */ }
    rmSync(perfil, { recursive: true, force: true });
  }

  return { connection, createPage, disposePage, close, proceso, stderr: () => stderr };
}

class BaseDatos {
  constructor(repo) {
    this.repo = repo;
    this.config = null;
  }

  cargarConfig() {
    if (this.config) return this.config;
    if (!existsSync(path.join(this.repo, 'config', 'config.php'))) {
      throw new Error(`API_REPO no contiene config/config.php: ${this.repo}`);
    }
    const codigo = [
      'require "app/Core/autoload.php";',
      '\\App\\Core\\Config::load("config/config.php");',
      'echo json_encode([',
      '"host" => (string) \\App\\Core\\Config::get("db.host", "127.0.0.1"),',
      '"port" => (string) \\App\\Core\\Config::get("db.port", "3306"),',
      '"name" => (string) \\App\\Core\\Config::get("db.name", ""),',
      '"user" => (string) \\App\\Core\\Config::get("db.user", ""),',
      '"pass" => (string) \\App\\Core\\Config::get("db.pass", ""),',
      ']);',
    ].join(' ');
    const resultado = spawnSync('php', ['-r', codigo], {
      cwd: this.repo,
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (resultado.status !== 0) {
      throw new Error(`No se pudo leer la configuración de BD: ${resultado.stderr || resultado.stdout}`);
    }
    try {
      this.config = JSON.parse(resultado.stdout);
    } catch {
      throw new Error('La configuración de BD no devolvió JSON válido');
    }
    if (!this.config.name || !this.config.user) throw new Error('La configuración de BD está incompleta');
    return this.config;
  }

  query(sql) {
    const config = this.cargarConfig();
    const resultado = spawnSync('mysql', [
      '--protocol=TCP',
      '-h', String(config.host || '127.0.0.1'),
      '-P', String(config.port || '3306'),
      '-u', String(config.user),
      '--batch',
      '--raw',
      '--skip-column-names',
      '--default-character-set=utf8mb4',
      String(config.name),
      '-e', sql,
    ], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, MYSQL_PWD: String(config.pass || '') },
    });
    if (resultado.status !== 0) {
      throw new Error(`Consulta MySQL falló: ${(resultado.stderr || resultado.stdout || '').trim()}`);
    }
    return resultado.stdout.replace(/\n$/, '').split('\n').filter(Boolean);
  }

  scalar(sql) {
    return this.query(sql)[0] ?? '';
  }
}

function literalSql(valor) {
  return `'${String(valor).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

const TABLAS_DATOS = [
  'auth_tokens',
  'refresh_tokens',
  'wallets',
  'credit_transactions',
  'conversations',
  'knowledge_sources',
  'knowledge_chunks',
  'pseudonymization_maps',
  'atscv_documents',
  'atscv_analyses',
  'cv_ats_trials',
  'documents',
  'ai_usage_logs',
  'prompt_audits',
  'jobs',
  'url_analyses',
  'notifications',
  'notification_deliveries',
  'user_notify_prefs',
];

function limpiarRateLimits(db) {
  const sql = [
    "DELETE FROM rate_limits WHERE bucket_key LIKE 'auth:login:%'",
    "OR bucket_key LIKE 'contact:ip:%'",
    "OR bucket_key LIKE 'auth:refresh:%'",
    "OR bucket_key LIKE 'voucher_verify:ip:%'",
  ].join(' ');
  db.query(sql);
}

function usuarioPorCorreo(db, email) {
  return db.scalar(`SELECT id FROM users WHERE email = ${literalSql(email)} LIMIT 1;`);
}

function verificarBorrado(db, email, userId) {
  const id = userId || db.scalar(
    `SELECT user_id FROM account_deletion_log WHERE email = ${literalSql(email)} ORDER BY created_at DESC LIMIT 1;`,
  );
  const users = id ? db.scalar(`SELECT COUNT(*) FROM users WHERE id = ${literalSql(id)};`) : '0';
  const counts = {};
  for (const tabla of TABLAS_DATOS) {
    counts[tabla] = id
      ? db.scalar(`SELECT COUNT(*) FROM ${tabla} WHERE user_id = ${literalSql(id)};`)
      : '0';
  }
  counts.chat_attachments = id
    ? db.scalar(`SELECT COUNT(*) FROM chat_attachments WHERE owner_key = ${literalSql(id)};`)
    : '0';
  const baja = db.scalar(`SELECT COUNT(*) FROM account_deletion_log WHERE email = ${literalSql(email)};`);
  const bonoAntifraude = id
    ? db.scalar(`SELECT COUNT(*) FROM welcome_bonus_grantees WHERE user_id = ${literalSql(id)};`)
    : '0';
  const datosLimpios = Object.values(counts).every((valor) => Number(valor) === 0);
  return {
    userId: id || null,
    users,
    counts,
    accountDeletionLog: baja,
    welcomeBonusGrantee: bonoAntifraude,
    ok: Number(users) === 0
      && datosLimpios
      && Number(baja) >= 1
      && Number(bonoAntifraude) >= 1,
  };
}

const CV_TEXTO = `CURRÍCULUM VITAE — PERSONA FICTICIA DE LA BATERÍA ATSCV
Nombre de prueba: Andrea Herrera
Título: Analista de datos y automatización de procesos
Resumen profesional: Ingeniera ficticia con seis años de experiencia construyendo repositorios de datos, tableros operativos y tareas automatizadas. Usa SQL, Python, dbt y Airflow para mejorar la calidad del dato y explicar resultados a equipos comerciales y de operaciones.
Experiencia:
- Analista de datos senior — Comercio digital ficticio (2022 a actualidad). Automaticé 35 reportes mensuales con SQL y Python, reduje el tiempo de cierre mensual en 45 % y publiqué un tablero de inventario en Power BI.
- Analista de datos — Distribuidora ficticia (2020 a 2022). Uní operaciones y finanzas con dbt, validé calidad de datos y automaticé la conciliación de despachos con Python.
- Analista junior — Consultora ficticia (2019 a 2020). Limpié catálogos con OpenRefine, construí reportes de ventas y documenté consultas SQL.
Educación: Ingeniería en Datos, universidad ficticia (2019). Diplomado en Analítica Avanzada y Machine Learning (2023).
Habilidades: SQL, PostgreSQL, MySQL, Python, pandas, dbt, Airflow, Power BI, Docker, Git, Excel, control de indicadores, calidad de datos, documentación, trabajo en equipo.
Idiomas: español nativo e inglés técnico intermedio.`;

const OFERTA_TEXTO = `OFERTA FICTICIA DE EMPLEO — ANALISTA DE DATOS (SSC)
Empresa de prueba SpA, modalidad híbrida en Santiago.
Responsabilidades: construir tableros de indicadores; desarrollar consultas SQL; automatizar reportes con Python, dbt y Airflow; validar calidad de dato; presentar hallazgos a equipos no técnicos.
Requisitos: 3 años en análisis de datos; SQL avanzado con PostgreSQL o MySQL; Python para análisis y automatización; visualización con Power BI o Looker Studio; Git y Docker; inglés intermedio.
Palabras clave: SQL, Python, Power BI, dbt, Airflow, PostgreSQL, MySQL, pandas, Docker, Git, calidad de datos, dashboard, indicadores, automatización, repositorio de datos, modelado dimensional, reporting.
Condiciones: contrato indefinido, jornada completa, capacitación y seguro de salud. Oferta y empresa completamente ficticias.`;

function passwordDeRonda(round) {
  return `Bateria-${RUN_ID}-${round}-Aa1!`;
}

function correoDeRonda(round) {
  return `atscv.battery.${RUN_ID}.${round}@example.com`;
}

async function capturarFallo(page, roundDir, step, error) {
  const seguro = nombreSeguro(step);
  const base = path.join(roundDir, 'fallos');
  mkdirSync(base, { recursive: true });
  await page.screenshot(path.join(base, `${seguro}.png`));
  await page.html(path.join(base, `${seguro}.html`));
  writeFileSync(
    path.join(base, `${seguro}.json`),
    JSON.stringify({ timestamp: ahora(), step, message: error.message, stack: error.stack }, null, 2),
    'utf8',
  );
}

async function ejecutarPaso(page, roundDir, round, step, accion) {
  const started = Date.now();
  try {
    const data = await accion();
    registrarEvento('step_completed', { round, step, durationMs: Date.now() - started, data: data || null });
    return { ok: true, data };
  } catch (error) {
    await capturarFallo(page, roundDir, step, error);
    registrarEvento('step_failed', {
      round,
      step,
      durationMs: Date.now() - started,
      error: { message: error.message, stack: error.stack },
      consoleErrors: page.consoleErrors.slice(-20),
    });
    return { ok: false, error };
  }
}

async function leerApiBase(page) {
  const base = await page.evaluate(`return String(window.__API_BASE__ || '').replace(/\\/+$/, '');`);
  if (!base || !/^https:\/\//.test(base)) {
    throw new Error(`El front no publicó una base API válida: ${base || '(vacía)'}`);
  }
  return base;
}

async function esperarApp(page) {
  await page.waitFor(
    `(location.pathname.endsWith('/app') || location.pathname.endsWith('/app.html')) && !!document.querySelector('#app') && !document.querySelector('#app').classList.contains('hidden')`,
    UI_TIMEOUT_MS,
    'panel de usuario',
  );
  await page.waitFor(
    `(() => { const b = document.querySelector('#header-balance'); return b && (b.textContent || '').trim() && (b.textContent || '').trim() !== '—'; })()`,
    UI_TIMEOUT_MS,
    'saldo en la cabecera',
  );
}

async function enviarFormulario(page, selectorCampo) {
  const ok = await page.evaluate(`(() => {
    const campo = document.querySelector(${JSON.stringify(selectorCampo)});
    const form = campo?.closest('form');
    const boton = form?.querySelector('button[type="submit"]');
    if (!boton) return false;
    boton.dataset.cdpBateriaEnviar = '1';
    return true;
  })()`);
  if (!ok) throw new Error(`No se encontró el envío del formulario de ${selectorCampo}`);
  await page.click('button[data-cdp-bateria-enviar="1"]');
}

async function pasoContacto(page, roundDir, round, email) {
  const indice = page.responses.length;
  await page.setValue('#contact-name', `Persona Batería ${RUN_ID} ${round}`);
  await page.setValue('#contact-email', email);
  await page.setValue('#contact-message', `Consulta técnica de la batería ATSCV, recorrido ${round}.`);
  await page.click('#contact-submit');
  await page.waitFor(
    `(() => { const s = document.querySelector('#contact-status'); return s && !s.classList.contains('hidden') && (s.textContent || '').trim(); })()`,
    UI_TIMEOUT_MS,
    'respuesta del formulario de contacto',
  );
  const status = await page.evaluate(`return (document.querySelector('#contact-status')?.textContent || '').replace(/\\s+/g, ' ').trim();`);
  const respuesta = await page.response('/contact', indice, UI_TIMEOUT_MS);
  guardarRespuesta(roundDir, 'contact', respuesta);
  if (!respuesta || respuesta.status !== 200) {
    throw new Error(`El contacto no respondió HTTP 200: ${respuesta?.status ?? 'sin respuesta'}`);
  }
  if (!/gracias/i.test(status)) throw new Error(`El front no confirmó el contacto: ${status}`);
  return { status, httpStatus: respuesta.status };
}

async function pasoRegistro(page, roundDir, round, email, password) {
  const indice = page.responses.length;
  await page.setValue('#registro-name', `Persona Batería ${RUN_ID} ${round}`);
  await page.setValue('#registro-email', email);
  await page.setValue('#registro-password', password);
  await page.setValue('#registro-password-confirm', password);
  await page.setChecked('#registro-terms', true);
  await enviarFormulario(page, '#registro-email');
  await esperarApp(page);
  const respuesta = await page.response('/auth/register', indice, UI_TIMEOUT_MS);
  guardarRespuesta(roundDir, 'register', respuesta);
  if (!respuesta || respuesta.status !== 200) {
    throw new Error(`El registro no respondió HTTP 200: ${respuesta?.status ?? 'sin respuesta'}`);
  }
  const balance = await page.evaluate(`return (document.querySelector('#header-balance')?.textContent || '').replace(/\\s+/g, ' ').trim();`);
  return { httpStatus: respuesta.status, balance };
}

async function pasoLogout(page, roundDir, round) {
  const indice = page.responses.length;
  await page.click('#header-menu-toggle');
  await page.waitFor(
    `(() => { const b = document.querySelector('#session-logout-mobile'); return b && !b.classList.contains('hidden'); })()`,
    UI_TIMEOUT_MS,
    'botón de logout móvil',
  );
  await page.click('#session-logout-mobile');
  await page.waitFor(
    `location.pathname === '/' || location.pathname.endsWith('/index.html') || location.pathname.endsWith('/index')`,
    UI_TIMEOUT_MS,
    'vuelta al inicio tras logout',
  );
  const respuesta = await page.response('/auth/logout', indice, 5_000);
  guardarRespuesta(roundDir, 'logout', respuesta);
  return { httpStatus: respuesta?.status ?? null };
}

async function pasoLogin(page, roundDir, round, email, password, etiqueta = 'login') {
  const indice = page.responses.length;
  await page.setValue('#login-email', email);
  await page.setValue('#login-password', password);
  await enviarFormulario(page, '#login-email');
  await esperarApp(page);
  const respuesta = await page.response('/auth/login', indice, UI_TIMEOUT_MS);
  guardarRespuesta(roundDir, etiqueta, respuesta);
  if (!respuesta || respuesta.status !== 200) {
    throw new Error(`El login no respondió HTTP 200: ${respuesta?.status ?? 'sin respuesta'}`);
  }
  return { httpStatus: respuesta.status };
}

async function cargarModoArchivo(page, roundDir) {
  const cvPath = path.join(ROOT, 'tests', 'fixtures', 'cv-battery.pdf');
  const ofertaPath = path.join(ROOT, 'tests', 'fixtures', 'oferta-battery.pdf');
  await page.waitFor(
    `!!document.querySelector('#cv-tabs') && !!document.querySelector('#cv-url-bloque') && !!document.querySelector('#oferta-url-bloque')`,
    UI_TIMEOUT_MS,
    'inicialización del analizador CV',
  );
  await page.setFile('#cv-input', cvPath);
  await page.waitFor(
    `(() => {
      const chip = document.querySelector('#cv-chip');
      const progress = document.querySelector('#cv-progress-label');
      return chip && !chip.classList.contains('hidden') && progress && /list[ao]/i.test(progress.textContent || '');
    })()`,
    UI_TIMEOUT_MS,
    'extracción del PDF de CV',
  );
  await page.setFile('#oferta-input', ofertaPath);
  await page.waitFor(
    `(() => {
      const chip = document.querySelector('#oferta-chip');
      const progress = document.querySelector('#oferta-progress-label');
      return chip && !chip.classList.contains('hidden') && progress && /list[ao]/i.test(progress.textContent || '');
    })()`,
    UI_TIMEOUT_MS,
    'extracción del PDF de oferta',
  );
  await page.waitFor(
    `document.querySelector('#btn-analizar')?.getAttribute('aria-disabled') === 'false'`,
    UI_TIMEOUT_MS,
    'CV y oferta listos en modo archivo',
  );
  return { mode: 'archivo', cvFixture: path.basename(cvPath), ofertaFixture: path.basename(ofertaPath) };
}

async function leerBloqueUrl(page, roundDir, bloque, url, etiqueta, timeoutMs = UI_TIMEOUT_MS) {
  const input = `${bloque} input`;
  const button = `${bloque} button`;
  const estadoSelector = `${bloque} p:last-child`;
  const indice = page.responses.length;
  await page.setValue(input, url);
  await page.click(button);
  await page.waitFor(
    `(() => {
      const boton = document.querySelector(${JSON.stringify(button)});
      const estado = document.querySelector(${JSON.stringify(estadoSelector)});
      return boton && !boton.disabled && (boton.textContent || '').trim() === 'Leer'
        && estado && !estado.classList.contains('hidden') && (estado.textContent || '').trim();
    })()`,
    timeoutMs,
    `lectura URL de ${bloque}`,
  );
  const estado = await page.evaluate(`(() => {
    const n = document.querySelector(${JSON.stringify(estadoSelector)});
    return n ? (n.textContent || '').replace(/\\s+/g, ' ').trim() : '';
  })()`);
  const respuesta = await page.response('/v1/cv-ats/desde-url', indice, 10_000);
  guardarRespuesta(roundDir, `desde-url-${etiqueta}`, respuesta);

  if (!respuesta) {
    throw new Error(`La lectura URL de ${bloque} no dejó respuesta HTTP: ${estado}`);
  }
  if (respuesta.status !== 200) {
    let detalleApi = '';
    try {
      const payload = JSON.parse(respuesta.body || '{}');
      detalleApi = payload?.error?.message || payload?.message || '';
    } catch {
      // El front muestra un mensaje legible; guardamos también ese detalle.
    }
    throw new Error(`La lectura URL de ${bloque} respondió HTTP ${respuesta.status}: ${detalleApi || estado}`);
  }
  if (!/le[ií]mos/i.test(estado)) {
    throw new Error(`El front no confirmó la lectura URL de ${bloque}: ${estado}`);
  }
  return { estado, httpStatus: respuesta.status };
}

async function cargarModoUrl(page, roundDir) {
  const cvUrl = new URL('tests/fixtures/cv-battery.html', BASE_URL).toString();
  const ofertaUrl = new URL('tests/fixtures/oferta-battery.html', BASE_URL).toString();
  await page.waitFor(`!!document.querySelector('#cv-url-bloque input') && !!document.querySelector('#oferta-url-bloque input')`, UI_TIMEOUT_MS, 'bloques URL');
  const cv = await leerBloqueUrl(page, roundDir, '#cv-url-bloque', cvUrl, 'cv');
  const oferta = await leerBloqueUrl(page, roundDir, '#oferta-url-bloque', ofertaUrl, 'oferta');
  await page.waitFor(
    `(() => {
      const cv = document.querySelector('#cv-textarea')?.value || '';
      const oferta = document.querySelector('#oferta-textarea')?.value || '';
      return cv.trim().length > 30 && oferta.trim().length > 30;
    })()`,
    UI_TIMEOUT_MS,
    'textos cargados desde URL',
  );
  return {
    mode: 'url',
    cvUrl,
    ofertaUrl,
    cvEstado: cv.estado,
    ofertaEstado: oferta.estado,
    cvHttpStatus: cv.httpStatus,
    ofertaHttpStatus: oferta.httpStatus,
  };
}

async function cargarModoTexto(page, roundDir) {
  await page.waitFor(`!!document.querySelector('#cv-textarea') && !!document.querySelector('#oferta-textarea')`, UI_TIMEOUT_MS, 'campos de texto');
  await page.setValue('#cv-textarea', CV_TEXTO);
  await page.setValue('#oferta-textarea', OFERTA_TEXTO);
  await page.waitFor(
    `document.querySelector('#btn-analizar')?.getAttribute('aria-disabled') === 'false'`,
    UI_TIMEOUT_MS,
    'CV y oferta listos en modo texto',
  );
  return { mode: 'texto', cvLength: CV_TEXTO.length, ofertaLength: OFERTA_TEXTO.length };
}

async function pasoAnalizar(page, roundDir) {
  const indice = page.responses.length;
  await page.click('#btn-analizar');
  await page.waitFor(
    `!!document.querySelector('#btn-generar') || !!document.querySelector('#resultados [role="alert"]')`,
    LLM_TIMEOUT_MS,
    'informe ATS (operación LLM)',
  );
  const respuesta = await page.response('/v1/cv-ats/match', indice, LLM_TIMEOUT_MS);
  guardarRespuesta(roundDir, 'match', respuesta);
  if (!respuesta || respuesta.status !== 200) {
    throw new Error(`El análisis no respondió HTTP 200: ${respuesta?.status ?? 'sin respuesta'}`);
  }
  await page.waitFor(`!!document.querySelector('#btn-generar')`, LLM_TIMEOUT_MS, 'botón Generar');
  const score = await page.evaluate(`return (document.querySelector('#gauge-number')?.textContent || '').trim();`);
  return { httpStatus: respuesta.status, score, llmCallsEstimated: 3 };
}

async function pasoPlantilla(page, roundDir) {
  const plantilla = await page.evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('input[name="cv-ats-plantilla"]'));
    if (!inputs.length) return null;
    const first = inputs[0];
    first.click();
    const checked = document.querySelector('input[name="cv-ats-plantilla"]:checked');
    const label = checked?.closest('label');
    return {
      id: checked?.value || '',
      checked: Boolean(checked),
      nombre: (label?.textContent || '').replace(/\\s+/g, ' ').trim(),
      total: inputs.length,
    };
  })()`);
  if (!plantilla || !plantilla.checked) throw new Error('No se pudo seleccionar la primera plantilla disponible');
  return plantilla;
}

async function pasoGenerar(page, roundDir) {
  const indice = page.responses.length;
  await page.click('#btn-generar');
  await page.waitFor(`!!document.querySelector('#cv-generado')`, LLM_TIMEOUT_MS, 'CV generado (operación LLM)');
  const respuesta = await page.response('/v1/cv-ats/generar-adaptado', indice, LLM_TIMEOUT_MS);
  guardarRespuesta(roundDir, 'generate', respuesta);
  if (!respuesta || respuesta.status !== 200) {
    throw new Error(`La generación no respondió HTTP 200: ${respuesta?.status ?? 'sin respuesta'}`);
  }
  return { httpStatus: respuesta.status, llmCallsEstimated: 1 };
}

async function descargarPdfDesdeFront(page, roundDir, textoEnlace, nombreArchivo) {
  const resultado = await page.evaluate(`(async () => {
    const enlace = Array.from(document.querySelectorAll('#cv-generado a'))
      .find((a) => (a.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(textoEnlace)});
    if (!enlace) return { error: 'No se encontró el enlace ${textoEnlace}' };
    const response = await fetch(enlace.href, { credentials: 'include' });
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return {
      url: enlace.href,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      contentDisposition: response.headers.get('content-disposition') || '',
      size: bytes.length,
      magic: String.fromCharCode(...bytes.subarray(0, 4)),
      base64: btoa(binary),
    };
  })()`, LLM_TIMEOUT_MS);
  if (resultado.error) throw new Error(resultado.error);
  const bytes = Buffer.from(resultado.base64, 'base64');
  const dir = path.join(roundDir, 'downloads');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, nombreArchivo), bytes);
  const evidencia = { ...resultado, base64: undefined, savedAs: nombreArchivo };
  writeFileSync(path.join(dir, `${nombreArchivo}.json`), JSON.stringify(evidencia, null, 2), 'utf8');
  if (resultado.status !== 200) throw new Error(`${textoEnlace} respondió HTTP ${resultado.status}`);
  if (!resultado.magic.startsWith('%PDF')) throw new Error(`${textoEnlace} no empieza con la cabecera %PDF: ${resultado.magic}`);
  if (resultado.size <= 1024) throw new Error(`${textoEnlace} weighs only ${resultado.size} bytes`);
  return evidencia;
}

async function pasoDescargas(page, roundDir) {
  const cv = await descargarPdfDesdeFront(page, roundDir, 'Descargar PDF', 'cv-adaptado.pdf');
  const carta = await descargarPdfDesdeFront(page, roundDir, 'Carta PDF', 'carta-presentacion.pdf');
  return { cv, carta, verified: 2 };
}

async function pasoCartaChat(page, roundDir) {
  await page.waitFor(`!!document.querySelector('#chat-panel textarea')`, UI_TIMEOUT_MS, 'chat del asistente');
  const indice = page.responses.length;
  const pregunta = 'Genera una carta de presentación en modo humano, natural y sin frases infladas, de máximo 220 palabras, para el puesto ficticio de Analista de Datos. Usa esta experiencia inventada: SQL, Python, dbt, Airflow, Power BI, Docker y Git; seis años de experiencia y reducción de cierres mensuales en 45 %. No inventes datos y recuerda que es un borrador para revisión humana.';
  await page.setValue('#chat-panel textarea', pregunta);
  await page.click('#chat-panel form button[type="submit"]');
  const respuesta = await page.response('/chat/completions', indice, LLM_TIMEOUT_MS);
  guardarRespuesta(roundDir, 'chat', respuesta);
  if (!respuesta || respuesta.status !== 200) {
    throw new Error(`El chat no respondió HTTP 200: ${respuesta?.status ?? 'sin respuesta'}`);
  }
  let data = {};
  try { data = JSON.parse(respuesta.body || '{}'); } catch { /* se valida por longitud */ }
  const answer = String(data?.data?.answer || data?.answer || '');
  if (answer.trim().length < 40) throw new Error('El asistente no devolvió una carta con contenido suficiente');
  return { httpStatus: respuesta.status, answerLength: answer.length, llmCallsEstimated: 1 };
}

async function asegurarSesionParaBorrado(page, email, password) {
  const enApp = await page.evaluate(`(() => {
    const app = document.querySelector('#app');
    return (location.pathname.endsWith('/app') || location.pathname.endsWith('/app.html')) && app && !app.classList.contains('hidden');
  })()`);
  if (enApp) return;
  await page.navigate(BASE_URL);
  await page.setValue('#login-email', email);
  await page.setValue('#login-password', password);
  await enviarFormulario(page, '#login-email');
  await esperarApp(page);
}

async function borrarDesdeFront(page, roundDir, email, password) {
  const indice = page.responses.length;
  await asegurarSesionParaBorrado(page, email, password);
  await page.click('#user-avatar-btn');
  await page.click('#user-menu-profile');
  await page.waitFor(
    `(() => { const p = document.querySelector('#panel-perfil'); return p && !p.classList.contains('hidden'); })()`,
    UI_TIMEOUT_MS,
    'panel de perfil',
  );
  await page.evaluate(`(() => {
    const details = document.querySelector('#panel-perfil details');
    if (details) details.open = true;
    return true;
  })()`);
  await page.click('#profile-delete-account');
  await page.waitFor(`!!document.querySelector('#delete-account-modal-confirm-input')`, UI_TIMEOUT_MS, 'modal de borrado');
  await page.setValue('#delete-account-modal-confirm-input', 'BORRAR');
  await page.click('#delete-account-modal-confirm');
  await page.waitFor(
    `location.pathname === '/' || location.pathname.endsWith('/index.html') || location.pathname.endsWith('/index')`,
    UI_TIMEOUT_MS,
    'salida tras borrar la cuenta',
  );
  const respuesta = await page.response('/account/delete', indice, UI_TIMEOUT_MS);
  guardarRespuesta(roundDir, 'account-delete', respuesta);
  if (!respuesta || respuesta.status !== 200) {
    throw new Error(`El borrado desde el front no respondió HTTP 200: ${respuesta?.status ?? 'sin respuesta'}`);
  }
  return { httpStatus: respuesta.status, viaUi: true };
}

async function fallbackBorrado(page, roundDir, email, password) {
  await asegurarSesionParaBorrado(page, email, password);
  const indice = page.responses.length;
  const status = await page.evaluate(`(async () => {
    const token = localStorage.getItem('jwt') || '';
    const response = await fetch(window.API('/account/delete'), {
      method: 'POST',
      credentials: 'include',
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: JSON.stringify({ confirm: 'BORRAR' }),
    });
    return response.status;
  })()`, UI_TIMEOUT_MS);
  const respuesta = await page.response('/account/delete', indice, UI_TIMEOUT_MS);
  guardarRespuesta(roundDir, 'account-delete-fallback', respuesta);
  if (status !== 200) throw new Error(`El fallback de borrado respondió HTTP ${status}`);
  return { httpStatus: status, viaUi: false };
}

async function verificarSesionCerrada(page, roundDir, email, password) {
  await page.navigate(new URL('app', BASE_URL).toString());
  await page.waitFor(
    `(() => { const gate = document.querySelector('#gate'); const app = document.querySelector('#app'); return gate && !gate.classList.contains('hidden') && app && app.classList.contains('hidden'); })()`,
    UI_TIMEOUT_MS,
    'gate de sesión cerrada',
  );
  const indice = page.responses.length;
  const meStatus = await page.evaluate(`(async () => {
    const response = await fetch(window.API('/auth/me?heart=${HEART}'), { credentials: 'include' });
    return response.status;
  })()`, UI_TIMEOUT_MS);
  const meRespuesta = await page.response('/auth/me', indice, 5_000);
  guardarRespuesta(roundDir, 'auth-me-after-delete', meRespuesta);
  if (meStatus !== 401) throw new Error(`GET /auth/me después del borrado respondió HTTP ${meStatus}, no 401`);

  await page.navigate(BASE_URL);
  const loginIndice = page.responses.length;
  await page.setValue('#login-email', email);
  await page.setValue('#login-password', password);
  await enviarFormulario(page, '#login-email');
  await page.waitFor(
    `(() => {
      const app = document.querySelector('#app');
      const error = document.querySelector('#form-login [data-error]');
      const fallo = error && !error.classList.contains('hidden') && (error.textContent || '').trim();
      return fallo || (app && !app.classList.contains('hidden'));
    })()`,
    UI_TIMEOUT_MS,
    'rechazo del login tras borrar',
  );
  const falloLogin = await page.evaluate(`(() => {
    const error = document.querySelector('#form-login [data-error]');
    return error ? (error.textContent || '').replace(/\\s+/g, ' ').trim() : '';
  })()`);
  const loginRespuesta = await page.response('/auth/login', loginIndice, UI_TIMEOUT_MS);
  guardarRespuesta(roundDir, 'login-after-delete', loginRespuesta);
  const entro = await page.evaluate(`(() => {
    const app = document.querySelector('#app');
    return Boolean(app && !app.classList.contains('hidden'));
  })()`);
  if (entro) throw new Error('El login de la cuenta borrada todavía abrió el panel');
  if (loginRespuesta && loginRespuesta.status !== 401) {
    throw new Error(`El login posterior a la baja respondió HTTP ${loginRespuesta.status}, no 401`);
  }
  return { meStatus, loginStatus: loginRespuesta?.status ?? null, loginError: falloLogin };
}

async function logoutFinalSiHaceFalta(page, email, password) {
  const viva = await page.evaluate(`(() => {
    const app = document.querySelector('#app');
    return Boolean(app && !app.classList.contains('hidden'));
  })()`);
  if (!viva) return { performed: false };
  await asegurarSesionParaBorrado(page, email, password);
  await page.click('#header-menu-toggle');
  await page.click('#session-logout-mobile');
  await page.waitFor(
    `location.pathname === '/' || location.pathname.endsWith('/index.html') || location.pathname.endsWith('/index')`,
    UI_TIMEOUT_MS,
    'logout final',
  );
  return { performed: true };
}

async function ejecutarRonda(browser, db, round) {
  const email = correoDeRonda(round);
  const password = passwordDeRonda(round);
  const mode = MODOS[(round - 1) % MODOS.length];
  const roundDir = path.join(RUN_DIR, `round-${round}`);
  mkdirSync(roundDir, { recursive: true });
  const failures = [];
  const page = await browser.createPage();
  let userId = '';
  let registered = false;
  let deletion = null;
  let deletionVerified = false;
  let contactSent = false;
  let llmCalls = 0;
  let llmHttpOps = 0;
  let downloadsVerified = 0;
  let completedEvent = null;

  registrarEvento('round_started', { round, email, mode });

  try {
    await page.navigate(BASE_URL);
    const apiBase = await leerApiBase(page);
    registrarEvento('api_base_read', { round, apiBase });

    const contacto = await ejecutarPaso(page, roundDir, round, 'contacto', () => pasoContacto(page, roundDir, round, email));
    if (contacto.ok) {
      contactSent = true;
      resumenGlobal.contactEmailsSent += 1;
    } else failures.push({ step: 'contacto', error: contacto.error.message });

    const registro = await ejecutarPaso(page, roundDir, round, 'registro', () => pasoRegistro(page, roundDir, round, email, password));
    if (registro.ok) {
      registered = true;
      userId = usuarioPorCorreo(db, email);
      if (!userId) throw new Error('El registro respondió 200 pero el usuario no apareció en users');
    } else failures.push({ step: 'registro', error: registro.error.message });

    if (registered) {
      const logout = await ejecutarPaso(page, roundDir, round, 'logout-ui', () => pasoLogout(page, roundDir, round));
      if (!logout.ok) failures.push({ step: 'logout-ui', error: logout.error.message });

      const login = await ejecutarPaso(page, roundDir, round, 'login', () => pasoLogin(page, roundDir, round, email, password));
      if (!login.ok) failures.push({ step: 'login', error: login.error.message });

      const panel = await ejecutarPaso(page, roundDir, round, 'panel', async () => {
        await esperarApp(page);
        return { appVisible: true, balance: await page.evaluate(`return (document.querySelector('#header-balance')?.textContent || '').replace(/\\s+/g, ' ').trim();`) };
      });
      if (!panel.ok) failures.push({ step: 'panel', error: panel.error.message });

      const carga = await ejecutarPaso(page, roundDir, round, `cv-oferta-modo-${mode}`, async () => {
        if (mode === 'archivo') return cargarModoArchivo(page, roundDir);
        if (mode === 'url') return cargarModoUrl(page, roundDir);
        return cargarModoTexto(page, roundDir);
      });
      if (!carga.ok) failures.push({ step: `cv-oferta-modo-${mode}`, error: carga.error.message });

      let analisisOk = carga.ok;
      const analisis = await ejecutarPaso(page, roundDir, round, 'analizar', async () => {
        if (!carga.ok) throw new Error('No se puede analizar sin CV y oferta listos');
        const result = await pasoAnalizar(page, roundDir);
        llmCalls += result.llmCallsEstimated;
        llmHttpOps += 1;
        return result;
      });
      if (!analisis.ok) {
        analisisOk = false;
        failures.push({ step: 'analizar', error: analisis.error.message });
      }

      let generadoOk = analisisOk;
      if (analisisOk) {
        const plantilla = await ejecutarPaso(page, roundDir, round, 'plantilla', () => pasoPlantilla(page, roundDir));
        if (!plantilla.ok) {
          generadoOk = false;
          failures.push({ step: 'plantilla', error: plantilla.error.message });
        }
      }

      if (generadoOk) {
        const generacion = await ejecutarPaso(page, roundDir, round, 'generar', async () => {
          const result = await pasoGenerar(page, roundDir);
          llmCalls += result.llmCallsEstimated;
          llmHttpOps += 1;
          return result;
        });
        if (!generacion.ok) {
          generadoOk = false;
          failures.push({ step: 'generar', error: generacion.error.message });
        }
      }

      if (generadoOk) {
        const descargas = await ejecutarPaso(page, roundDir, round, 'descargas-pdf', () => pasoDescargas(page, roundDir));
        if (descargas.ok) downloadsVerified += 2;
        else failures.push({ step: 'descargas-pdf', error: descargas.error.message });
      }

      const carta = await ejecutarPaso(page, roundDir, round, 'carta-chat-ia', async () => {
        const result = await pasoCartaChat(page, roundDir);
        llmCalls += result.llmCallsEstimated;
        llmHttpOps += 1;
        return result;
      });
      if (!carta.ok) failures.push({ step: 'carta-chat-ia', error: carta.error.message });
    }

    if (registered) {
      const borrado = await ejecutarPaso(page, roundDir, round, 'borrar-cuenta-front', () => borrarDesdeFront(page, roundDir, email, password));
      if (borrado.ok) {
        deletion = borrado.data;
        resumenGlobal.accountsDeleted += 1;
      } else {
        failures.push({ step: 'borrar-cuenta-front', error: borrado.error.message });
        const fallback = await ejecutarPaso(page, roundDir, round, 'borrar-cuenta-fallback', () => fallbackBorrado(page, roundDir, email, password));
        if (fallback.ok) {
          deletion = fallback.data;
          resumenGlobal.accountsDeleted += 1;
        } else failures.push({ step: 'borrar-cuenta-fallback', error: fallback.error.message });
      }
    }

    if (registered && deletion) {
      const cerrada = await ejecutarPaso(page, roundDir, round, 'verificar-sesion-cerrada', () => verificarSesionCerrada(page, roundDir, email, password));
      if (!cerrada.ok) failures.push({ step: 'verificar-sesion-cerrada', error: cerrada.error.message });

      const bd = await ejecutarPaso(page, roundDir, round, 'verificar-bd', async () => {
        const verificacion = verificarBorrado(db, email, userId);
        if (!verificacion.ok) throw new Error(`La BD no quedó limpia: ${JSON.stringify(verificacion)}`);
        return verificacion;
      });
      if (bd.ok) deletionVerified = true;
      else failures.push({ step: 'verificar-bd', error: bd.error.message });

      const logoutFinal = await ejecutarPaso(page, roundDir, round, 'logout-final', () => logoutFinalSiHaceFalta(page, email, password));
      if (!logoutFinal.ok) failures.push({ step: 'logout-final', error: logoutFinal.error.message });
    }
  } catch (error) {
    await capturarFallo(page, roundDir, 'ronda', error);
    failures.push({ step: 'ronda', error: error.message });
  } finally {
    resumenGlobal.llmCallsEstimated += llmCalls;
    resumenGlobal.llmHttpOperationsObserved += llmHttpOps;
    resumenGlobal.downloadsVerified += downloadsVerified;
    const status = failures.length === 0 && deletionVerified ? 'ok' : 'failed';
    if (status === 'ok') resumenGlobal.roundsOk += 1;
    else {
      resumenGlobal.roundsFailed += 1;
      resumenGlobal.failedRounds.push({ round, mode, email, failures });
    }
    if (deletionVerified) resumenGlobal.accountsDeletionVerified += 1;
    completedEvent = registrarEvento('round_completed', {
      round,
      mode,
      email,
      status,
      userId: userId || null,
      deletion,
      deletionVerified,
      contactSent,
      llmCallsEstimated: llmCalls,
      llmHttpOperationsObserved: llmHttpOps,
      downloadsVerified,
      failures,
    });
    resumenGlobal.roundsCompleted += 1;
    writeFileSync(SUMMARY_PATH, `${JSON.stringify(resumenGlobal, null, 2)}\n`, 'utf8');
    try {
      await browser.disposePage(page);
    } catch {
      // El contexto se limpia al cerrar Chrome aunque falle su disposal.
    }
  }

  return completedEvent;
}

function imprimirResumen() {
  console.log('\n════════ RESUMEN BATERÍA ATSCV ════════');
  console.log(JSON.stringify(resumenGlobal, null, 2));
}

async function main() {
  const completadas = leerCompletadas();
  if (!RESUME && completadas.size > 0) {
    throw new Error(`La corrida ${RUN_ID} ya tiene ${completadas.size} ronda(s) completada(s); usa RESUME=1 o cambia RUN_ID`);
  }
  const pendientes = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    if (completadas.has(round)) {
      resumenGlobal.roundsCompleted += 1;
      resumenGlobal.resumedRoundsSkipped += 1;
      const previa = completadas.get(round);
      if (previa.status === 'ok') resumenGlobal.roundsOk += 1;
      else {
        resumenGlobal.roundsFailed += 1;
        resumenGlobal.failedRounds.push({ round, failures: previa.failures || [] });
      }
      if (previa.contactSent) resumenGlobal.contactEmailsSent += 1;
      if (previa.deletion) resumenGlobal.accountsDeleted += 1;
      if (previa.deletionVerified) resumenGlobal.accountsDeletionVerified += 1;
      resumenGlobal.llmCallsEstimated += Number(previa.llmCallsEstimated || 0);
      resumenGlobal.llmHttpOperationsObserved += Number(previa.llmHttpOperationsObserved || 0);
      resumenGlobal.downloadsVerified += Number(previa.downloadsVerified || 0);
      continue;
    }
    pendientes.push(round);
  }

  registrarEvento('run_started', {
    roundsRequested: ROUNDS,
    concurrency: CONCURRENCY,
    resume: RESUME,
    pendingRounds: pendientes,
    baseUrl: BASE_URL,
    apiRepo: API_REPO,
  });
  console.log(`Batería ATSCV: run=${RUN_ID} rondas=${ROUNDS} pendientes=${pendientes.length} concurrencia=${CONCURRENCY}`);
  console.log(`Log: ${JSONL_PATH}`);

  const db = new BaseDatos(API_REPO);
  const browser = await lanzarChrome();
  let exitCode = 0;
  try {
    const cola = [...pendientes];
    const workers = Array.from({ length: Math.min(CONCURRENCY, cola.length) }, async () => {
      while (cola.length) {
        const round = cola.shift();
        try {
          limpiarRateLimits(db);
          await ejecutarRonda(browser, db, round);
        } catch (error) {
          console.error(`Ronda ${round} no pudo ejecutarse: ${error.message}`);
          resumenGlobal.roundsCompleted += 1;
          resumenGlobal.roundsFailed += 1;
          resumenGlobal.failedRounds.push({ round, failures: [{ step: 'ronda', error: error.message }] });
          registrarEvento('round_completed', { round, status: 'failed', failures: [{ step: 'ronda', error: error.message }] });
        }
      }
    });
    await Promise.all(workers);
  } finally {
    await browser.close();
  }

  resumenGlobal.finishedAt = ahora();
  writeFileSync(SUMMARY_PATH, `${JSON.stringify(resumenGlobal, null, 2)}\n`, 'utf8');
  registrarEvento('run_finished', { summary: resumenGlobal });
  imprimirResumen();
  if (resumenGlobal.roundsFailed > 0) exitCode = 1;
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(`ERROR CRÍTICO DE LA BATERÍA: ${error.stack || error.message}`);
  try {
    registrarEvento('run_crashed', { error: { message: error.message, stack: error.stack } });
  } catch {
    // Si ni siquiera el log puede escribirse, el error original manda.
  }
  process.exitCode = 1;
});
