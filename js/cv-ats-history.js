/**
 * History of the CV ATS comparisons. The module is loaded by BOTH surfaces
 * (the card inside the panel and the standalone /cv-ats/ page), so it builds
 * every piece of markup by itself.
 */

const HISTORIAL_BASE = '/v1/cv-ats';
const STORAGE_ABIERTO = 'atscv_historial_abierto';
const MENSAJE_GENERICO = 'No pudimos completar la acción ahora. Inténtalo de nuevo en un ratito.';

const BOTON = 'inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50';
const BOTON_AZUL = 'inline-flex items-center rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 transition hover:bg-blue-50';

const formatoNumero = new Intl.NumberFormat('es-CL');
const formatoFecha = new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const estado = {
  entradas: [], tipos: [], plantillas: [], seccion: null, overlay: null,
  minimizados: new Set(), generados: new Map(),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const apiUrl = (path) => (typeof window.API === 'function' ? window.API(path) : path);
const numero = (valor) => formatoNumero.format(Number(valor) || 0);
const ocultarSeccion = () => { if (estado.seccion) estado.seccion.style.display = 'none'; };
const leerAbierto = () => { try { return localStorage.getItem(STORAGE_ABIERTO) !== '0'; } catch (error) { return true; } };
const guardarAbierto = (abierto) => { try { localStorage.setItem(STORAGE_ABIERTO, abierto ? '1' : '0'); } catch (error) { /* private mode */ } };
const detalleDe = (entrada) => pedir(HISTORIAL_BASE + '/historial/' + encodeURIComponent(entrada.id_hys));

class ErrorHistorial extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function formatearFecha(valor) {
  if (!valor) return '';
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? '' : formatoFecha.format(fecha);
}

// Every call carries the session cookie: the history belongs to the person.
async function pedir(path, opciones = {}) {
  const config = { method: opciones.method || 'GET', credentials: 'include', headers: {} };
  if (opciones.body !== undefined) {
    config.headers['Content-Type'] = 'application/json'; config.body = JSON.stringify(opciones.body);
  }
  let response;
  try {
    response = await fetch(apiUrl(path), config);
  } catch (networkError) {
    throw new ErrorHistorial(0, 'NETWORK_ERROR', 'No pudimos conectar ahora. Revisa tu conexión y vuelve a intentarlo, sin apuro.');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.success !== true) {
    const apiError = (payload && payload.error) || {};
    throw new ErrorHistorial(response.status, apiError.code || 'HTTP_' + response.status, apiError.message || MENSAJE_GENERICO);
  }
  return payload.data || {};
}

function inyectarEstilos() {
  if (document.getElementById('cv-ats-history-styles')) return;
  const estilo = document.createElement('style');
  estilo.id = 'cv-ats-history-styles';
  estilo.textContent = [
    '.cvats-hist-seccion { margin-top: 1.5rem; }',
    '.cvats-hist-wrap { display: grid; grid-template-rows: 1fr; transition: grid-template-rows .28s ease; } .cvats-hist-wrap-inner { overflow: hidden; min-height: 0; }',
    '.cvats-hist-tarjeta-wrap { display: grid; grid-template-rows: 1fr; transition: grid-template-rows .28s ease; } .cvats-hist-tarjeta-inner { overflow: hidden; min-height: 0; }',
    '.cvats-hist-overlay { position: fixed; inset: 0; z-index: 50; } .cvats-hist-overlay-fondo { position: absolute; inset: 0; background: rgba(15, 23, 42, .65); }',
    '.cvats-hist-overlay-caja { position: relative; width: 98vw; height: 94vh; margin: 3vh auto; overflow: auto; background: #fff; border-radius: 1rem; box-shadow: 0 24px 60px rgba(15, 23, 42, .35); }',
    '.cvats-hist-overlay-cerrar { position: absolute; top: .75rem; right: .75rem; z-index: 2; border: 1px solid #e2e8f0; border-radius: .5rem; background: #fff; padding: .35rem .85rem; font-size: .875rem; font-weight: 600; color: #334155; }',
    '.cvats-hist-overlay-cerrar:hover { background: #f1f5f9; } .cvats-hist-overlay-contenido { padding: 1.25rem; } .cvats-hist-score { border-radius: 9999px; background: #f1f5f9; border: 1px solid #e2e8f0; padding: .15rem .65rem; font-size: .8125rem; font-weight: 700; color: #334155; white-space: nowrap; }',
    '.cvats-hist-opcion { display: block; border: 1px solid #e2e8f0; border-radius: .75rem; padding: .6rem .75rem; cursor: pointer; } .cvats-hist-opcion:hover { border-color: #93c5fd; }',
    '.cvats-hist-enlace { display: inline-flex; border: 1px solid #bfdbfe; border-radius: .5rem; background: #fff; padding: .35rem .85rem; font-size: .875rem; font-weight: 600; color: #1d4ed8; text-decoration: none; }',
  ].join('\n');
  document.head.appendChild(estilo);
}

function boton(accion, texto, clases, ariaExpanded) {
  const expandido = ariaExpanded ? ` aria-expanded="${ariaExpanded}"` : '';
  return `<button type="button" data-cvats-accion="${accion}"${expandido} class="${clases || BOTON}">${escapeHtml(texto)}</button>`;
}

function enlace(href, texto, clases) {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" class="${clases}">${escapeHtml(texto)}</a>`;
}

function crearSeccion() {
  const seccion = document.createElement('section');
  seccion.id = 'cvats-historial';
  seccion.className = 'cvats-hist-seccion rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
  seccion.setAttribute('aria-labelledby', 'cvats-historial-titulo');
  seccion.innerHTML = `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0"><h2 id="cvats-historial-titulo" class="font-display text-lg font-semibold text-slate-900">Historial de ofertas</h2>
        <p class="mt-1 text-sm text-slate-600">Cada oferta que comparaste queda guardada aquí, con su informe y sus descargas.</p></div>
      <div class="flex flex-wrap items-center gap-2"><span id="cvats-historial-conteo" class="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">0 ofertas</span>
        ${boton('seccion-minimizar', 'Minimizar', BOTON, 'true')}${boton('seccion-actualizar', 'Actualizar', BOTON)}</div>
    </div>
    <div id="cvats-historial-cuerpo" class="cvats-hist-wrap mt-4" style="grid-template-rows: 1fr;">
      <div class="cvats-hist-wrap-inner"><div id="cvats-historial-lista"><p class="text-sm text-slate-600">Cargando tu historial…</p></div></div></div>`;
  return seccion;
}

function montarSeccion() {
  if (estado.seccion && document.body.contains(estado.seccion)) return estado.seccion;
  // The panel anchors the section after its own card; the standalone page
  // anchors it after the section that holds the results.
  const card = document.getElementById('card-cv-ats');
  const resultados = document.getElementById('resultados');
  const ancla = card || (resultados ? (resultados.closest('section') || resultados) : null);
  if (!ancla) return null;

  const seccion = crearSeccion();
  ancla.insertAdjacentElement('afterend', seccion);
  estado.seccion = seccion;

  // The open/closed state survives a reload: the section remembers it.
  const abierto = leerAbierto();
  seccion.querySelector('#cvats-historial-cuerpo').style.gridTemplateRows = abierto ? '1fr' : '0fr';
  const botonMinimizar = seccion.querySelector('[data-cvats-accion="seccion-minimizar"]');
  botonMinimizar.setAttribute('aria-expanded', String(abierto));
  botonMinimizar.textContent = abierto ? 'Minimizar' : 'Maximizar';
  return seccion;
}

function actualizarConteo() {
  const conteo = document.getElementById('cvats-historial-conteo');
  if (!conteo) return;
  const total = estado.entradas.length;
  conteo.textContent = total + (total === 1 ? ' oferta' : ' ofertas');
}

function documentosMarkup(documentos) {
  const items = (Array.isArray(documentos) ? documentos : []).filter((documento) => documento && documento.url)
    .map((documento) => ({ url: documento.url, nombre: documento.filename || 'Documento' }));
  if (!items.length) return '<p class="mt-2 text-sm text-slate-500">Todavía no hay documentos descargables en esta oferta.</p>';
  const lista = items.map((item) => `<li>${enlace(apiUrl(item.url), item.nombre, 'text-sm font-medium text-blue-700 underline')}</li>`).join('');
  return `<div class="mt-3"><p class="text-xs font-semibold uppercase tracking-wide text-slate-500">Documentos listos</p>
    <ul class="mt-1 space-y-1">${lista}</ul></div>`;
}

function opcionesRadios(nombre, items, elegido, conCreditos) {
  return items.map((item) => {
    const id = `${nombre}-${item.id}`;
    const detalle = (item.descripcion || '') + (conCreditos && item.creditos ? ` · ${numero(item.creditos)} créditos` : '');
    return `<label class="cvats-hist-opcion mb-2" for="${escapeHtml(id)}">
      <span class="flex items-center gap-2"><input type="radio" id="${escapeHtml(id)}" name="${escapeHtml(nombre)}" value="${escapeHtml(item.id)}"${item.id === elegido ? ' checked' : ''}>
        <span class="font-medium text-slate-800">${escapeHtml(item.nombre || item.id)}</span></span>
      <span class="mt-1 block text-xs text-slate-600">${escapeHtml(detalle)}</span></label>`;
  }).join('');
}

function pickerMarkup(entrada) {
  const { plantillas, tipos } = estado;
  if (!plantillas.length || !tipos.length) {
    return '<p class="text-sm text-slate-500">El catálogo de plantillas no está disponible ahora. Inténtalo de nuevo en un ratito.</p>';
  }
  const plantillaElegida = plantillas.some((item) => item.id === entrada.plantilla) ? entrada.plantilla : plantillas[0].id;
  const tipoElegido = tipos.some((item) => item.id === entrada.tipo) ? entrada.tipo : tipos[0].id;
  return `<fieldset class="mt-3"><legend class="text-sm font-semibold text-slate-800">Formato del documento</legend>
      <div class="mt-2">${opcionesRadios('cvats-hist-plantilla-' + entrada.id_hys, plantillas, plantillaElegida, false)}</div></fieldset>
    <fieldset class="mt-3"><legend class="text-sm font-semibold text-slate-800">Qué documento quieres descargar</legend>
      <div class="mt-2">${opcionesRadios('cvats-hist-tipo-' + entrada.id_hys, tipos, tipoElegido, true)}</div></fieldset>
    <button type="button" data-cvats-accion="generar" class="mt-3 ${BOTON_AZUL}">Generar y descargar</button>`;
}

function generadosMarkup(generado) {
  if (!generado) return '';
  const cv = generado.cv || {};
  const carta = generado.carta || {};
  const enlaces = [{ url: cv.docx_url, texto: 'CV adaptado (DOCX)' }, { url: cv.pdf_url, texto: 'CV adaptado (PDF)' },
    { url: carta.docx_url, texto: 'Carta (DOCX)' }, { url: carta.pdf_url, texto: 'Carta (PDF)' }].filter((item) => item.url);
  if (!enlaces.length) return '';
  const score = Math.max(0, Math.min(100, Math.round(Number(generado.nuevo_match_score) || 0)));
  const links = enlaces.map((item) => enlace(apiUrl(item.url), item.texto, 'cvats-hist-enlace')).join('');
  return `<div class="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
    <p class="text-sm font-semibold text-emerald-800">Nuevo puntaje estimado: ${score} %</p>
    <div class="mt-2 flex flex-wrap gap-2">${links}</div></div>`;
}

function tarjetaMarkup(entrada) {
  const titulo = escapeHtml(entrada.oferta_titulo || 'Oferta sin título');
  const score = Math.max(0, Math.min(100, Math.round(Number(entrada.score) || 0)));
  const minimo = estado.minimizados.has(entrada.id_hys);
  const generado = estado.generados.get(entrada.id_hys) || null;
  const documentos = Array.isArray(entrada.documentos) ? entrada.documentos : [];
  return `<article class="rounded-xl border border-slate-200 bg-white p-4" data-cvats-hist-id="${escapeHtml(entrada.id_hys || '')}">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 flex-1"><p class="truncate font-semibold text-slate-900" title="${titulo}">${titulo}</p>
        <p class="mt-0.5 text-xs text-slate-500">${escapeHtml(formatearFecha(entrada.fecha))}</p></div>
      <span class="cvats-hist-score">${score} %</span>
    </div>
    <div class="mt-3 flex flex-wrap items-center gap-2">${boton('ver', 'Ver informe', BOTON)}${boton('descargar', 'Descargar', BOTON)}${boton('quitar', 'Quitar', BOTON)}
      ${boton('minimizar', minimo ? 'Expandir' : 'Minimizar', BOTON, minimo ? 'false' : 'true')}${boton('maximizar', 'Maximizar', BOTON)}</div>
    <div class="cvats-hist-tarjeta-wrap mt-3" style="grid-template-rows: ${minimo ? '0fr' : '1fr'};">
      <div class="cvats-hist-tarjeta-inner"><p class="text-sm text-slate-600">CV: ${numero(entrada.cv_chars)} caracteres · Oferta: ${numero(entrada.oferta_chars)} caracteres</p>
        ${documentosMarkup(documentos)}${generadosMarkup(generado)}
        <div class="cvats-hist-picker mt-3"${generado ? '' : ' hidden'}>${pickerMarkup(entrada)}</div>
        <p class="cvats-hist-mensaje mt-2 text-sm text-rose-700" role="status" hidden></p></div>
    </div>
  </article>`;
}

function pintarLista(mensaje) {
  const lista = document.getElementById('cvats-historial-lista');
  if (!lista) return;
  if (mensaje) {
    lista.innerHTML = `<p class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">${escapeHtml(mensaje)}</p>`;
    return;
  }
  if (!estado.entradas.length) {
    lista.innerHTML = `<div class="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center">
      <p class="font-medium text-slate-700">Todavía no tienes ofertas guardadas</p>
      <p class="mt-1 text-sm text-slate-600">Cuando analices una oferta, aparecerá aquí con su informe y sus descargas.</p></div>`;
  } else lista.innerHTML = `<div class="space-y-3">${estado.entradas.map(tarjetaMarkup).join('')}</div>`;
  actualizarConteo();
}

const mostrarMensajeTarjeta = (tarjeta, mensaje) => {
  const destino = tarjeta.querySelector('.cvats-hist-mensaje');
  if (!destino) return;
  destino.textContent = mensaje; destino.hidden = false;
};

async function cargarLista() {
  cerrarOverlay();
  let mensaje = '';
  try {
    const data = await pedir(HISTORIAL_BASE + '/historial');
    estado.entradas = Array.isArray(data.historial) ? data.historial : [];
    estado.tipos = Array.isArray(data.tipos) ? data.tipos : [];
    estado.plantillas = Array.isArray(data.plantillas) ? data.plantillas : [];
  } catch (error) {
    // Without a session there is no history to show: the section steps
    // aside quietly instead of shouting at somebody who was only looking.
    if (error.status === 401) { ocultarSeccion(); return; }
    mensaje = error.message;
  }
  const seccion = montarSeccion();
  if (!seccion) return;
  seccion.style.display = ''; pintarLista(mensaje);
}

/**
 * The report painter lives in cv-ats.js, which the page already loads with
 * its own <script> tag. The history module reuses THAT instance (the query
 * string included): a second copy would evaluate the analyser twice.
 */
function urlModuloCvAts() {
  const tag = Array.from(document.querySelectorAll('script[type="module"]'))
    .find((node) => /(^|\/)cv-ats\.js(\?|$)/.test(node.getAttribute('src') || ''));
  return tag ? new URL(tag.getAttribute('src'), document.baseURI).href : new URL('./cv-ats.js', import.meta.url).href;
}

let abrirInforme = null;

async function abrirInformeConDetalle(detalle) {
  if (!abrirInforme) abrirInforme = (await import(urlModuloCvAts())).abrirInforme;
  if (typeof abrirInforme !== 'function') {
    throw new ErrorHistorial(0, 'SIN_INFORME', 'No pudimos abrir el informe ahora. Actualiza la página e inténtalo de nuevo.');
  }
  const item = (detalle && detalle.historial) || {};
  // The painter expects the very same fields a fresh report carries.
  abrirInforme({
    ...item, match_score: item.match_score !== undefined ? item.match_score : item.score,
    perfil: item.perfil || {}, oferta: item.oferta || {}, brecha: item.brecha || {},
    informe_texto: item.informe_texto || '',
    tipos: (detalle && detalle.tipos) || [], plantillas: (detalle && detalle.plantillas) || [],
  });
}

async function verInforme(tarjeta, boton, entrada) {
  boton.disabled = true;
  boton.textContent = 'Abriendo tu informe…';
  try {
    await abrirInformeConDetalle(await detalleDe(entrada));
    const resultados = document.getElementById('resultados');
    if (resultados) resultados.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (error.status === 401) { ocultarSeccion(); return; }
    mostrarMensajeTarjeta(tarjeta, error.message);
  } finally { boton.disabled = false; boton.textContent = 'Ver informe'; }
}

function alternarMinimizar(tarjeta, boton) {
  const wrap = tarjeta.querySelector('.cvats-hist-tarjeta-wrap');
  if (!wrap) return;
  const abierto = wrap.style.gridTemplateRows !== '0fr';
  wrap.style.gridTemplateRows = abierto ? '0fr' : '1fr';
  boton.setAttribute('aria-expanded', String(!abierto));
  boton.textContent = abierto ? 'Expandir' : 'Minimizar';
  const id = tarjeta.getAttribute('data-cvats-hist-id');
  if (abierto) estado.minimizados.add(id); else estado.minimizados.delete(id);
}

function alternarMaximizar(tarjeta, boton) {
  if (estado.overlay) { cerrarOverlay(); return; }

  // A maximized card shows everything: a collapsed body opens first.
  const wrap = tarjeta.querySelector('.cvats-hist-tarjeta-wrap');
  if (wrap && wrap.style.gridTemplateRows === '0fr') {
    wrap.style.gridTemplateRows = '1fr';
    estado.minimizados.delete(tarjeta.getAttribute('data-cvats-hist-id'));
    const botonMinimizar = tarjeta.querySelector('[data-cvats-accion="minimizar"]');
    botonMinimizar.setAttribute('aria-expanded', 'true'); botonMinimizar.textContent = 'Minimizar';
  }

  const overlay = document.createElement('div');
  overlay.className = 'cvats-hist-overlay';
  overlay.innerHTML = `<div class="cvats-hist-overlay-fondo" data-cvats-fondo="1"></div>
    <div class="cvats-hist-overlay-caja" role="dialog" aria-modal="true" aria-label="Informe ampliado">
      <button type="button" data-cvats-accion="cerrar-overlay" class="cvats-hist-overlay-cerrar">Cerrar</button>
      <div class="cvats-hist-overlay-contenido"></div></div>`;

  const marcador = document.createComment('cvats-historial');
  tarjeta.parentNode.insertBefore(marcador, tarjeta);
  document.body.appendChild(overlay);
  overlay.querySelector('.cvats-hist-overlay-contenido').appendChild(tarjeta);
  estado.overlay = { overlay, tarjeta, marcador, boton }; boton.textContent = 'Restaurar';
}

function cerrarOverlay() {
  const actual = estado.overlay;
  if (!actual) return;
  estado.overlay = null;
  if (actual.marcador.parentNode) actual.marcador.parentNode.insertBefore(actual.tarjeta, actual.marcador);
  actual.marcador.remove(); actual.overlay.remove(); actual.boton.textContent = 'Maximizar';
}

function alternarPicker(tarjeta) {
  const destino = tarjeta.querySelector('.cvats-hist-picker');
  if (destino) destino.hidden = !destino.hidden;
}

async function generar(tarjeta, boton, entrada) {
  const elegido = (selector) => (tarjeta.querySelector(selector) || {}).value;
  const plantilla = elegido(`input[name="cvats-hist-plantilla-${entrada.id_hys}"]:checked`);
  const tipo = elegido(`input[name="cvats-hist-tipo-${entrada.id_hys}"]:checked`);
  if (!plantilla || !tipo) {
    mostrarMensajeTarjeta(tarjeta, 'Elige un formato y un tipo de documento para continuar.');
    return;
  }

  boton.disabled = true; boton.textContent = 'Generando tu documento…';
  try {
    const detalle = await detalleDe(entrada);
    const item = (detalle && detalle.historial) || {};
    const generado = await pedir(HISTORIAL_BASE + '/generar-adaptado', {
      method: 'POST',
      // The same combination always means the same document: retrying it
      // never charges twice.
      body: {
        perfil: item.perfil || {}, oferta: item.oferta || {}, brecha: item.brecha || {},
        // The operation of the stored analysis: with it the generated files
        // stay linked to THIS report, so they show up in its card.
        operacion: item.operacion || '',
        plantilla, tipo, idempotency_key: `hist-${entrada.id_hys}-${plantilla}-${tipo}`,
      },
    });

    const creditos = Number(generado.creditos_restantes);
    if (Number.isFinite(creditos)) document.dispatchEvent(new CustomEvent('wallet:balance-updated', { detail: { balance: creditos } }));
    estado.generados.set(entrada.id_hys, generado);
    await cargarLista();
  } catch (error) {
    if (error.status === 401) { ocultarSeccion(); return; }
    mostrarMensajeTarjeta(tarjeta, error.message);
  } finally { boton.disabled = false; boton.textContent = 'Generar y descargar'; }
}

async function quitar(tarjeta, boton, entrada) {
  if (!window.confirm('¿Quieres quitar este informe de tu historial?')) return;
  boton.disabled = true;
  try {
    await pedir(HISTORIAL_BASE + '/historial/' + encodeURIComponent(entrada.id_hys), { method: 'DELETE' });
    estado.entradas = estado.entradas.filter((item) => item.id_hys !== entrada.id_hys);
    estado.generados.delete(entrada.id_hys); tarjeta.remove(); actualizarConteo();
  } catch (error) {
    boton.disabled = false;
    if (error.status === 401) { ocultarSeccion(); return; }
    mostrarMensajeTarjeta(tarjeta, error.message);
  }
}
const ACCIONES = { ver: verInforme, descargar: alternarPicker, quitar, minimizar: alternarMinimizar, maximizar: alternarMaximizar, generar };

document.addEventListener('click', (evento) => {
  if (evento.target.closest('[data-cvats-fondo]')) { cerrarOverlay(); return; }

  const boton = evento.target.closest('button[data-cvats-accion]');
  if (!boton || !boton.closest('.cvats-hist-seccion, .cvats-hist-overlay')) return;

  const accion = boton.getAttribute('data-cvats-accion');
  if (accion === 'cerrar-overlay') { cerrarOverlay(); return; }
  if (accion === 'seccion-actualizar') { cargarLista(); return; }
  if (accion === 'seccion-minimizar') {
    const cuerpo = estado.seccion.querySelector('#cvats-historial-cuerpo');
    const abierto = boton.getAttribute('aria-expanded') === 'true';
    cuerpo.style.gridTemplateRows = abierto ? '0fr' : '1fr';
    boton.setAttribute('aria-expanded', String(!abierto));
    boton.textContent = abierto ? 'Maximizar' : 'Minimizar'; guardarAbierto(!abierto); return;
  }

  const tarjeta = boton.closest('[data-cvats-hist-id]');
  if (!tarjeta) return;
  const entrada = estado.entradas.find((item) => item.id_hys === tarjeta.getAttribute('data-cvats-hist-id'));
  if (!entrada) return;

  const manejar = ACCIONES[accion];
  if (manejar) manejar(tarjeta, boton, entrada);
});

document.addEventListener('keydown', (evento) => {
  if (evento.key === 'Escape' && estado.overlay) cerrarOverlay();
});

window.addEventListener('atscv:historial-refrescar', () => { cargarLista(); });

inyectarEstilos();
cargarLista();
