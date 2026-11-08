// api-config.js — the ONE deploy-time knob of the frontend.
//
// This file is plain JS (not an ES module) so index.html loads it BEFORE
// the modules, and the deploy can rewrite just this one file on the
// frontend server.
//
// Value below points at the production API origin: https://api.djlabs.cl.
// Nothing else in the front hardcodes an origin; this is the single line to
// change when the API moves.
//
// The backend must trust this origin in its 'cors.origins' config (exact
// scheme+host+port), and the session cookie must travel with the calls.
(function () {
  var definido = (typeof window.__API_BASE__ === 'string') ? window.__API_BASE__.trim() : '';

  if (!definido) {
    definido = 'https://api.djlabs.cl';
  }

  window.__API_BASE__ = definido;
})();
