    // Arranque sin parpadeo: la preferencia día/noche del visitante se
    // aplica ANTES del primer paint (mismo patrón que js/inline/index-1.js
    // en la landing). El accent (data-skin) lo declara el markup de cada
    // superficie y no se toca desde aquí: en este front el visitante elige
    // día o noche, el color de marca lo decide el corazón.
    (function () {
      try {
        var root = document.documentElement;
        var tema = localStorage.getItem('aj:tema');
        if (tema === 'dia' || tema === 'noche') root.dataset.tema = tema;
      } catch (error) { /* storage unavailable: markup defaults apply */ }
    })();

    window.API = (function () {
      var base = (typeof window.__API_BASE__ === 'string') ? window.__API_BASE__.trim().replace(/\/+$/, '') : '';
      return function (path) { return base + path; };
    })();
