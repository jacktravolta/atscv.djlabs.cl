// chat-emphasis.js — visual emphasis for the chat panel (CV ATS Match).
//
// The assistant's answers carry structure the reader must SEE while the
// answer is still being written: the bold the model marked with **...**, the
// [POR COMPLETAR - Verificar] flags (the landing promises them in yellow)
// and the figures that carry the match score.
//
// This module owns that language. It borrows the visual vocabulary of the ATS
// panel (js/cv-ats.js): the blue of the product for the figures, the amber of
// "pay attention" for the flags, and the same soft breathing ("latido") the
// panel uses on its call-to-action zone. The chat does NOT import cv-ats.js:
// it only shares the look, never the code.
//
// Three public helpers:
//   - inyectarEstilos(): injects the style sheet once per document.
//   - aplicarEnfasis(el): wraps the flags and the figures already rendered.
//   - animarBloques(el, desdeIndice): staggered entrance for the blocks.
//
// Safety: the answer is UNTRUSTED model output. Nothing here writes model
// text into innerHTML: the text nodes are split and re-wrapped with
// document.createTextNode / document.createElement, and the style sheet is a
// static string that never contains anything from the model.

const ID_ESTILO = 'chat-emphasis-estilos';

// Class names (prefixed with "chat-" so they cannot collide with the ATS
// panel or with the host page).
const CLASE_MARCA = 'chat-marca';
const CLASE_CIFRA = 'chat-cifra';
const CLASE_BLOQUE = 'chat-bloque';
const CLASE_LINEA_VIVA = 'chat-linea-viva';

// TreeWalker constants (kept numeric so the module never depends on a
// global that a non-browser host might not expose).
const SHOW_TEXT = 4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

// Flags the product already uses: [POR COMPLETAR - Verificar],
// [POR COMPLETAR] and [POR COMPLETAR - Verificar <detalle>].
const RE_MARCA = /\[POR\s+COMPLETAR\b[^\]]*\]/gi;

// Figures: NN% and NN.N% (1 or 2 decimals).
const RE_CIFRA = /\d{1,3}(?:[.,]\d{1,2})?\s*%/g;

// The stylesheet. Blue for the figures (the product blue of the ATS panel),
// amber for the flags ("pay attention"), and a short rise for the blocks.
const CSS = [
  // ---- Flags: amber chip with a soft breathing (same idea as cvats-latido) ----
  '.chat-marca {',
  '  display: inline-block;',
  '  margin: 0 1px;',
  '  padding: 0 5px;',
  '  border: 1px solid #fcd34d;',
  '  border-radius: 6px;',
  '  background: #fef3c7;',
  '  color: #78350f;',
  '  font-weight: 600;',
  '  animation: chat-latido-marca 2.8s ease-in-out infinite;',
  '}',
  '@keyframes chat-latido-marca {',
  '  0%, 100% { background: #fef3c7; border-color: #fcd34d; box-shadow: 0 0 0 0 rgba(245,158,11,0); }',
  '  50% { background: #ffedc2; border-color: #fbbf24; box-shadow: 0 0 0 3px rgba(245,158,11,.12); }',
  '}',

  // ---- Figures: ONE short pulse of attention when they appear (never a loop) ----
  '.chat-cifra {',
  '  display: inline-block;',
  '  padding: 0 2px;',
  '  border-radius: 4px;',
  '  color: #1d4ed8;',
  '  font-weight: 700;',
  '  animation: chat-pulso-cifra 720ms cubic-bezier(.2,.8,.3,1) 1 both;',
  '}',
  '@keyframes chat-pulso-cifra {',
  '  0% { transform: scale(1); background-color: rgba(37,99,235,0); }',
  '  40% { transform: scale(1.09); background-color: rgba(37,99,235,.14); }',
  '  100% { transform: scale(1); background-color: rgba(37,99,235,0); }',
  '}',

  // ---- Blocks: staggered entrance (fade + short rise) ----
  // The entrance starts from 35% (not from zero): a block that is rebuilt
  // while the answer is being written settles back instead of blinking.
  '.chat-bloque {',
  '  animation: chat-entra 420ms cubic-bezier(.22,.8,.3,1) both;',
  '}',
  '@keyframes chat-entra {',
  '  0% { opacity: .35; transform: translateY(6px); }',
  '  100% { opacity: 1; transform: translateY(0); }',
  '}',

  // ---- The line that is still being written ----
  '.chat-linea-viva {',
  '  white-space: pre-wrap;',
  '}',

  // ---- Calm mode: the reader asked the system to calm down, so nothing moves ----
  '@media (prefers-reduced-motion: reduce) {',
  '  .chat-marca, .chat-cifra, .chat-bloque { animation: none !important; }',
  '  .chat-bloque { opacity: 1 !important; transform: none !important; }',
  '}',
].join('\n');

/**
 * Injects the style sheet of the module. Safe to call as many times as you
 * want: the sheet is inserted once per document (it is looked up by id).
 *
 * @returns {void}
 */
export function inyectarEstilos() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(ID_ESTILO)) return; // already there: one sheet only
  const estilo = document.createElement('style');
  estilo.id = ID_ESTILO;
  estilo.textContent = CSS;
  (document.head || document.documentElement).appendChild(estilo);
}

/**
 * Wraps the flags and the figures already rendered inside `el`.
 *
 * It walks the TEXT nodes (never the markup) and splits them, so the exact
 * text of the answer is preserved: nothing is lost, nothing is duplicated.
 * Calling it twice does not double-wrap: the spans already created are
 * recognized by their class and skipped.
 *
 * @param {HTMLElement} el
 * @returns {void}
 */
export function aplicarEnfasis(el) {
  if (!el || !el.ownerDocument || typeof el.ownerDocument.createTreeWalker !== 'function') return;
  const doc = el.ownerDocument;

  const walker = doc.createTreeWalker(el, SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentNode;
      if (!parent || parent.nodeType !== 1) return FILTER_REJECT;
      const tag = parent.tagName;
      // Code and styles are not prose: leave them alone.
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'CODE' || tag === 'PRE') {
        return FILTER_REJECT;
      }
      // Already wrapped: do not nest a second time.
      if (parent.closest && parent.closest('.' + CLASE_MARCA + ', .' + CLASE_CIFRA)) {
        return FILTER_REJECT;
      }
      const value = node.nodeValue;
      if (!value || !value.trim()) return FILTER_REJECT;
      return FILTER_ACCEPT;
    },
  });

  // The tree is modified while walking it, so the nodes are collected first.
  const nodos = [];
  let actual = walker.nextNode();
  while (actual) {
    nodos.push(actual);
    actual = walker.nextNode();
  }

  for (const nodo of nodos) {
    envolverNodo(nodo);
  }
}

/**
 * Gives the blocks of `el` (the <p>, <ul> and <ol> the markdown renderer
 * produces) a staggered entrance: fade + a short rise, a small delay per
 * block. `desdeIndice` animates only the blocks that are new.
 *
 * With prefers-reduced-motion nothing moves: the style sheet turns the
 * animation off, so the class can be applied without any motion at all.
 *
 * @param {HTMLElement} el
 * @param {number} [desdeIndice=0]
 * @returns {void}
 */
export function animarBloques(el, desdeIndice = 0) {
  if (!el || !el.children) return;
  const bloques = bloquesDe(el);
  const desde = Number.isFinite(desdeIndice) ? Math.max(0, Math.trunc(desdeIndice)) : 0;
  for (let i = desde; i < bloques.length; i++) {
    const bloque = bloques[i];
    bloque.classList.add(CLASE_BLOQUE);
    bloque.style.animationDelay = ((i - desde) * 70) + 'ms';
  }
}

/**
 * The block children of `el`, in document order.
 *
 * @param {HTMLElement} el
 * @returns {HTMLElement[]}
 */
function bloquesDe(el) {
  const salida = [];
  const hijos = (el && el.children) ? el.children : [];
  for (const hijo of hijos) {
    const tag = hijo.tagName;
    if (tag === 'P' || tag === 'UL' || tag === 'OL') salida.push(hijo);
  }
  return salida;
}

/**
 * Splits one text node and wraps the flags and the figures it contains.
 *
 * @param {Text} nodo
 * @returns {void}
 */
function envolverNodo(nodo) {
  const texto = nodo.nodeValue || '';
  const hallazgos = [];
  buscar(RE_MARCA, texto, hallazgos, CLASE_MARCA, true);
  buscar(RE_CIFRA, texto, hallazgos, CLASE_CIFRA, false);
  if (!hallazgos.length) return;

  hallazgos.sort((a, b) => a.inicio - b.inicio);
  // Overlapping matches: the first one wins, the other is dropped.
  const utiles = [];
  let limite = -1;
  for (const hallazgo of hallazgos) {
    if (hallazgo.inicio < limite) continue;
    utiles.push(hallazgo);
    limite = hallazgo.fin;
  }

  const doc = nodo.ownerDocument;
  const fragmento = doc.createDocumentFragment();
  let cursor = 0;
  for (const hallazgo of utiles) {
    if (hallazgo.inicio > cursor) {
      fragmento.appendChild(doc.createTextNode(texto.slice(cursor, hallazgo.inicio)));
    }
    const span = doc.createElement('span');
    span.className = hallazgo.clase;
    span.textContent = texto.slice(hallazgo.inicio, hallazgo.fin);
    fragmento.appendChild(span);
    cursor = hallazgo.fin;
  }
  if (cursor < texto.length) {
    fragmento.appendChild(doc.createTextNode(texto.slice(cursor)));
  }

  if (nodo.parentNode) {
    nodo.parentNode.replaceChild(fragmento, nodo);
  }
}

/**
 * Collects the matches of one pattern inside a text.
 *
 * @param {RegExp} patron
 * @param {string} texto
 * @param {{inicio: number, fin: number, clase: string}[]} salida
 * @param {string} clase
 * @param {boolean} esMarca
 * @returns {void}
 */
function buscar(patron, texto, salida, clase, esMarca) {
  const flags = patron.flags.indexOf('g') === -1 ? patron.flags + 'g' : patron.flags;
  const re = new RegExp(patron.source, flags);
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(texto)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const inicio = m.index;
    const fin = inicio + m[0].length;
    const previo = inicio > 0 ? texto.charAt(inicio - 1) : '';
    if (esMarca) {
      // A flag is a word of its own: it never sticks to a previous word.
      if (/[\wÀ-ÿ]/.test(previo)) continue;
    } else if (/[\d.,]/.test(previo)) {
      // "1.234%" is not a figure: the number must not continue another one.
      continue;
    }
    salida.push({ inicio, fin, clase });
  }
}
