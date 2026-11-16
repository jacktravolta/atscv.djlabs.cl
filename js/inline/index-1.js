    // No-flash theme boot: apply the visitor's stored tema before any
    // stylesheet paints. The accent (skin) is NOT a visitor preference:
    // it is declared in the markup (data-skin) and stays there, so the
    // brand colour is identical before and after the page finishes
    // loading. js/theme.js then wires the on-screen controls.
    (function () {
      try {
        // root = the ELEMENT (documentElement.dataset here would be the
        // DOMStringMap itself, and root.dataset.* inside it would write a
        // bogus data-dataset-* attribute — the reload-reverts-to-default
        // bug). The skin is NOT a visitor preference: the markup declares
        // it (data-skin) and the REST /ui/theme route no longer repaints
        // it after the first paint.
        var root = document.documentElement;
        var tema = localStorage.getItem('aj:tema');
        if (tema === 'dia' || tema === 'noche') root.dataset.tema = tema;
      } catch (error) { /* storage unavailable: markup defaults apply */ }
    })();
