// Puerta de consentimiento para la analítica del sitio.
//
// GTM se carga únicamente cuando existe una autorización explícita y guardada.
// El snippet inline de dataLayer sigue siendo el responsable de preparar la
// cola; este archivo no modifica ni agrega eventos a esa cola.

(() => {
  const GTM_ID = 'GTM-KMM54N62';
  const STORAGE_KEY = 'atscv_analytics_consent';
  const GRANTED = 'granted';
  const DENIED = 'denied';
  const GTM_SRC = `https://www.googletagmanager.com/gtm.js?id=${GTM_ID}`;

  let banner = null;
  let decision = readDecision();
  let gtmWasLoaded = false;

  function readDecision() {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      return value === GRANTED || value === DENIED ? value : null;
    } catch (error) {
      // En modo privado el almacenamiento puede fallar. La página sigue
      // funcionando y volveremos a preguntar en la próxima carga.
      return null;
    }
  }

  function writeDecision(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch (error) {
      // La decisión sigue vigente durante esta visita aunque no se pueda
      // guardar para la próxima.
    }
  }

  function clearDecision() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      // Sin almacenamiento disponible no hay una decisión persistida que borrar.
    }
  }

  function loadGtm() {
    const existing = document.querySelector(`script[src="${GTM_SRC}"]`);
    if (existing) {
      gtmWasLoaded = true;
      return;
    }

    const script = document.createElement('script');
    script.async = true;
    script.src = GTM_SRC;
    document.head.appendChild(script);
    gtmWasLoaded = true;
  }

  function syncBodySpace() {
    if (!banner || !document.body) return;

    const height = Math.ceil(banner.getBoundingClientRect().height);
    document.body.style.setProperty('--analytics-consent-space', `${height + 32}px`);
  }

  function showBanner(moveFocus = false) {
    if (!banner) {
      banner = createBanner();
      document.body.appendChild(banner);
    }

    banner.hidden = false;
    document.body.classList.add('analytics-consent-open');
    syncBodySpace();

    if (moveFocus) {
      window.requestAnimationFrame(() => {
        banner.querySelector('[data-analytics-consent="granted"]')?.focus();
      });
    }
  }

  function hideBanner() {
    if (!banner) return;

    banner.hidden = true;
    document.body.classList.remove('analytics-consent-open');
    document.body.style.removeProperty('--analytics-consent-space');
  }

  function decide(value) {
    decision = value;
    writeDecision(value);
    hideBanner();

    if (value === GRANTED) {
      loadGtm();
      return;
    }

    // Si GTM ya estaba activo, una recarga limpia garantiza que no siga
    // enviando señales después de que la persona elija continuar sin analítica.
    if (gtmWasLoaded) {
      window.location.reload();
    }
  }

  function createBanner() {
    const aside = document.createElement('aside');
    aside.id = 'analytics-consent-banner';
    aside.className = 'analytics-consent-banner';
    aside.setAttribute('role', 'region');
    aside.setAttribute('aria-label', 'Preferencias de analítica del sitio');
    aside.setAttribute('aria-labelledby', 'analytics-consent-title');
    aside.setAttribute('aria-describedby', 'analytics-consent-description');

    const content = document.createElement('div');
    content.className = 'analytics-consent-banner__content';

    const copy = document.createElement('div');
    const title = document.createElement('h2');
    title.id = 'analytics-consent-title';
    title.className = 'analytics-consent-banner__title';
    title.textContent = 'Ayúdanos a mejorar el sitio';

    const description = document.createElement('p');
    description.id = 'analytics-consent-description';
    description.className = 'analytics-consent-banner__description';
    description.textContent = 'Usamos cookies de analítica (Google Analytics) para entender cómo se usa el sitio y mejorarlo. No identificamos tu cuenta, tu CV ni tus documentos, y puedes seguir usando todo el servicio sin autorizarlas.';

    const privacyLink = document.createElement('a');
    privacyLink.className = 'analytics-consent-banner__link';
    privacyLink.textContent = 'Saber más sobre privacidad';

    // En la portada el enlace abre el modal legal; en el resto de páginas
    // lleva a la portada, donde vive la explicación completa.
    const privacyTrigger = document.querySelector('[data-legal-modal="privacidad"]');
    if (privacyTrigger) {
      privacyLink.href = '#';
      privacyLink.addEventListener('click', (event) => {
        event.preventDefault();
        privacyTrigger.click();
      });
    } else {
      privacyLink.href = 'https://atscv.djlabs.cl/';
    }

    copy.append(title, description, privacyLink);

    const actions = document.createElement('div');
    actions.className = 'analytics-consent-banner__actions';

    const grantButton = document.createElement('button');
    grantButton.type = 'button';
    grantButton.className = 'analytics-consent-banner__button analytics-consent-banner__button--primary';
    grantButton.dataset.analyticsConsent = GRANTED;
    grantButton.textContent = 'Autorizar analítica';

    const denyButton = document.createElement('button');
    denyButton.type = 'button';
    denyButton.className = 'analytics-consent-banner__button analytics-consent-banner__button--secondary';
    denyButton.dataset.analyticsConsent = DENIED;
    denyButton.textContent = 'Continuar sin analítica';

    grantButton.addEventListener('click', () => decide(GRANTED));
    denyButton.addEventListener('click', () => decide(DENIED));

    actions.append(grantButton, denyButton);
    content.append(copy, actions);
    aside.appendChild(content);

    return aside;
  }

  function wirePreferencesButton() {
    const button = document.getElementById('btn-analytics-preferences');
    if (!button || button.dataset.analyticsPreferencesWired === 'true') return;

    button.dataset.analyticsPreferencesWired = 'true';
    button.addEventListener('click', () => {
      const panel = button.closest('[data-legal-panel]');
      const closeButton = panel?.querySelector('[data-legal-close]');
      closeButton?.click();
      window.__atscvConsent.reset();
    });
  }

  function init() {
    if (!document.body) return;

    wirePreferencesButton();

    if (decision === GRANTED) {
      loadGtm();
      return;
    }

    if (decision === DENIED) return;

    showBanner();
  }

  // API mínima para que el modal legal vuelva a ofrecer la elección.
  window.__atscvConsent = Object.freeze({
    reset() {
      clearDecision();
      decision = null;
      showBanner(true);
    },
  });

  window.addEventListener('resize', syncBodySpace);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
