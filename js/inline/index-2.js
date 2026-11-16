    // heart-theme: el backend sirve la apariencia por heart como JSON (REST).
    //
    // Esta llamada NO vuelve a pintar la página. El accent (skin) y el
    // tema por defecto ya viven en el markup (data-skin="indigo"), que es
    // la única fuente de verdad: escribir aquí el skin del servidor
    // recoloreaba todo el sitio DESPUÉS del primer paint (parpadeo teal →
    // indigo, porque la utilidad `transition` de Tailwind también anima
    // background-color) y el tema por defecto del administrador pisaba la
    // preferencia día/noche que el visitante ya había elegido.
    //
    // El resultado queda disponible en window.__HEART_THEME__ para el
    // panel. El DOM no se toca después del primer paint.
    (function () {
      try {
        var api = (typeof window.__API_BASE__ === 'string') ? window.__API_BASE__.trim().replace(/\/+$/, '') : '';
        var heart = encodeURIComponent(localStorage.getItem('heart_id') || 'atscv');
        window.__HEART_THEME__ = { skin: '', tema: '' };
        fetch(api + '/ui/theme?heart=' + heart, { headers: { Accept: 'application/json' }, credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d || !d.data) return;
            var skin = typeof d.data.skin === 'string' ? d.data.skin : '';
            var tema = typeof d.data.tema === 'string' ? d.data.tema : '';
            window.__HEART_THEME__ = { skin: skin, tema: tema };
          })
          .catch(function () { /* theme es preferencia, no compuerta */ });
      } catch (error) { /* markup defaults apply */ }
    })();
