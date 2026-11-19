import { apiGet, apiPost, uuidV4 } from './http.js';

const MERCADO_PAGO_PROVIDER = 'mercadopago';
const MERCADO_PAGO_SDK_URL = 'https://sdk.mercadopago.com/js/v2';
const sdkLoads = new Map();

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean !== '' ? clean : null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeProvider(value) {
  const provider = stringOrNull(value);
  return provider ? provider.toLowerCase() : null;
}

function quoteRows(quote) {
  if (!isObject(quote)) return [];
  if (Array.isArray(quote.currencies)) return quote.currencies;
  if (Array.isArray(quote.options)) return quote.options;
  return [];
}

function clpQuoteRow(quote) {
  return quoteRows(quote).find((row) => {
    const currency = stringOrNull(row && (row.currency || row.currency_code || row.code));
    return currency && currency.toUpperCase() === 'CLP';
  }) || null;
}

function quoteProviders(quote) {
  if (!isObject(quote)) return [];

  const providers = [];
  const topLevel = Array.isArray(quote.providers) ? quote.providers : [];
  const row = clpQuoteRow(quote);
  const rowProviders = row && Array.isArray(row.providers) ? row.providers : [];

  for (const value of [...topLevel, ...rowProviders]) {
    const provider = normalizeProvider(value);
    if (provider && !providers.includes(provider)) providers.push(provider);
  }

  return providers;
}

/**
 * Resolves the payment rail advertised by the API. The provider name alone is
 * not enough: Mercado Pago is used only when the server also exposes its
 * public key through the quote.
 *
 * @param {object|null} limits
 * @param {object|null} quote
 * @returns {{ provider: string|null, publicKey: string|null, isMercadoPago: boolean }}
 */
export function resolvePaymentRail(limits, quote) {
  const explicitProvider = normalizeProvider(limits && limits.provider);
  const selectedProvider = normalizeProvider(quote && quote.selected_provider);
  const quoteProvider = normalizeProvider(quote && quote.provider);
  const providers = quoteProviders(quote);
  const provider = explicitProvider || selectedProvider || quoteProvider || (providers.length === 1 ? providers[0] : null);
  const info = isObject(quote && quote.mercadopago) ? quote.mercadopago : {};
  const publicKey = stringOrNull(info.public_key || info.publicKey);

  return {
    provider,
    publicKey,
    isMercadoPago: provider === MERCADO_PAGO_PROVIDER && !!publicKey,
  };
}

/**
 * Fetches the server-owned quote used by the card rail.
 *
 * @param {string|null} [heart]
 * @returns {Promise<object|null>}
 */
export async function fetchPaymentQuote(heart) {
  const query = heart ? `?heart=${encodeURIComponent(heart)}` : '';
  const quote = await apiGet(`/payments/quote${query}`);

  return isObject(quote) ? quote : null;
}

/**
 * Fetches the server-owned recharge limits and current provider.
 *
 * @param {string|null} [heart]
 * @returns {Promise<object|null>}
 */
export async function fetchPaymentLimits(heart) {
  const query = heart ? `?heart=${encodeURIComponent(heart)}` : '';
  const limits = await apiGet(`/payments/limits${query}`);

  return isObject(limits) ? limits : null;
}

function normalizeVariant(raw) {
  if (!isObject(raw)) return null;

  const variantId = stringOrNull(raw.variant_id || raw.variantId || raw.id);
  const amountClp = numberOrNull(raw.amount_clp ?? raw.amountClp ?? raw.price_clp ?? raw.priceClp ?? raw.amount);

  if (!variantId || amountClp === null || amountClp <= 0) return null;

  return {
    variantId,
    amountClp: Math.round(amountClp),
    credits: numberOrNull(raw.credits),
  };
}

/**
 * Selects the server-owned variant that exactly matches the visible CLP pack.
 * A mismatched variant is never used: the API remains the price authority.
 *
 * @param {object|null} quote
 * @param {number} amount
 * @returns {{ variantId: string, amountClp: number, credits: number|null }|null}
 */
export function selectMercadoPagoVariant(quote, amount) {
  const row = clpQuoteRow(quote);
  const rowVariants = row && (Array.isArray(row.variants) ? row.variants : Array.isArray(row.prices) ? row.prices : []);
  const rootVariants = quote && Array.isArray(quote.variants) ? quote.variants : [];
  const rawVariants = rowVariants.length > 0 ? rowVariants : rootVariants;
  const targetAmount = Math.round(Number(amount));
  const variants = rawVariants.map(normalizeVariant).filter(Boolean);
  const match = variants.find((variant) => variant.amountClp === targetAmount);

  if (match) return match;

  const rootVariantId = stringOrNull(quote && (quote.variant_id || quote.variantId));
  const rootAmount = numberOrNull(quote && (quote.amount_clp ?? quote.amountClp ?? quote.price_clp ?? quote.priceClp));

  if (rootVariantId && rootAmount === targetAmount) {
    return {
      variantId: rootVariantId,
      amountClp: targetAmount,
      credits: numberOrNull(quote.credits),
    };
  }

  return null;
}

function mercadoPagoBuilder(publicKey) {
  if (typeof window === 'undefined' || typeof window.MercadoPago !== 'function') return null;

  try {
    const sdk = new window.MercadoPago(publicKey);
    return sdk && typeof sdk.bricks === 'function' ? sdk.bricks() : null;
  } catch (_) {
    return null;
  }
}

/**
 * Loads the official Bricks SDK once per public key.
 *
 * @param {string} publicKey
 * @returns {Promise<object|null>}
 */
export function loadMercadoPagoSdk(publicKey) {
  const key = stringOrNull(publicKey);
  if (!key || typeof document === 'undefined') return Promise.resolve(null);

  const ready = mercadoPagoBuilder(key);
  if (ready) return Promise.resolve(ready);
  if (sdkLoads.has(key)) return sdkLoads.get(key);

  const load = new Promise((resolve) => {
    let settled = false;
    const finish = (builder) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(builder);
    };
    const timer = setTimeout(() => finish(null), 12000);
    const script = document.createElement('script');
    script.src = MERCADO_PAGO_SDK_URL;
    script.async = true;
    script.onload = () => finish(mercadoPagoBuilder(key));
    script.onerror = () => finish(null);
    document.head.appendChild(script);
  }).then((builder) => {
    sdkLoads.delete(key);
    return builder;
  });

  sdkLoads.set(key, load);
  return load;
}

/**
 * Mounts the Card Payment Brick with its own payment button hidden. The
 * product button remains the only way to start a payment.
 *
 * @param {{ target: string, publicKey: string, amount: number, email?: string|null, onReady?: Function, onError?: Function }} options
 * @returns {Promise<object|null>}
 */
export async function mountMercadoPagoBrick({
  target,
  publicKey,
  amount,
  email,
  onReady,
  onError,
}) {
  const builder = await loadMercadoPagoSdk(publicKey);
  if (!builder) return null;

  const initialization = { amount: Math.round(Number(amount)) };

  if (stringOrNull(email)) {
    initialization.payer = {
      email: stringOrNull(email),
      identification: { type: 'RUT' },
    };
  }

  try {
    return await builder.create('cardPayment', target, {
      initialization,
      callbacks: {
        onReady: () => {
          if (typeof onReady === 'function') onReady();
        },
        onSubmit: () => Promise.resolve(),
        onError: (error) => {
          if (typeof onError === 'function') onError(error);
        },
      },
      customization: {
        visual: { hidePaymentButton: true },
      },
      locale: 'es-CL',
    });
  } catch (error) {
    if (typeof onError === 'function') onError(error);
    return null;
  }
}

function extractCardToken(data) {
  if (typeof data === 'string') return stringOrNull(data);
  if (!isObject(data)) return null;

  const source = isObject(data.paymentSource) ? data.paymentSource : null;
  const card = isObject(data.card) ? data.card : source && isObject(source.card) ? source.card : null;
  const candidates = [
    card && card.token,
    card && card.id,
    source && source.token,
    typeof data.paymentSource === 'string' ? data.paymentSource : null,
    data.token,
    data.card_token,
    data.cardToken,
  ];

  for (const candidate of candidates) {
    const token = stringOrNull(candidate);
    if (token) return token;
  }

  return null;
}

/**
 * Keeps only the opaque token and the metadata documented by the Brick. Card
 * number, security code and expiry stay inside Mercado Pago's secure fields.
 *
 * @param {object|null} data
 * @param {string|null} [fallbackEmail]
 * @returns {{ token: string, issuerId: string, paymentMethodId: string, installments: number, payer: object }|null}
 */
export function normalizeMercadoPagoCardData(data, fallbackEmail = null) {
  if (!isObject(data)) return null;

  const token = extractCardToken(data);
  const issuerId = stringOrNull(data.issuer_id || data.issuerId);
  const paymentMethodId = stringOrNull(data.payment_method_id || data.paymentMethodId);
  const installments = numberOrNull(data.installments);
  const payer = isObject(data.payer) ? data.payer : null;
  const email = stringOrNull((payer && payer.email) || fallbackEmail);
  const rawIdentification = payer && isObject(payer.identification) ? payer.identification : {
    type: (payer && payer.identificationType) || data.identificationType || data.identification_type,
    number: (payer && payer.identificationNumber) || data.identificationNumber || data.identification_number,
  };
  const identificationType = stringOrNull(rawIdentification.type);
  const identificationNumber = stringOrNull(rawIdentification.number);

  if (!token || !issuerId || !paymentMethodId || installments === null || installments < 1 || !email
    || !identificationType || !identificationNumber) {
    return null;
  }

  return {
    token,
    issuerId,
    paymentMethodId,
    installments: Math.round(installments),
    payer: {
      email,
      identification: {
        type: identificationType.toUpperCase(),
        number: identificationNumber,
      },
    },
  };
}

/**
 * Normalizes the card-order response while keeping optional fields optional.
 *
 * @param {object|null} data
 * @returns {object|null}
 */
export function normalizeCardOrder(data) {
  const source = isObject(data) && isObject(data.order) ? data.order : data;
  if (!isObject(source)) return null;

  return {
    orderId: stringOrNull(source.order_id || source.orderId || source.id),
    providerOrderId: stringOrNull(source.provider_order_id || source.providerOrderId),
    providerPaymentId: stringOrNull(source.provider_payment_id || source.providerPaymentId),
    status: String(source.status || '').toUpperCase(),
    statusDetail: stringOrNull(source.status_detail || source.statusDetail),
    credits: numberOrNull(source.credits),
    amountClp: numberOrNull(source.amount_clp || source.amountClp),
    redirectUrl: stringOrNull(source.redirect_url || source.redirectUrl),
  };
}

/**
 * Creates a card order with the opaque Brick token only.
 *
 * @param {{ variantId: string, cardData: object, heart?: string|null }} options
 * @returns {Promise<object|null>}
 */
export async function createCardOrder({ variantId, cardData, heart }) {
  const body = {
    variant_id: variantId,
    card_token: cardData.token,
    provider: MERCADO_PAGO_PROVIDER,
    issuer_id: cardData.issuerId,
    payment_method_id: cardData.paymentMethodId,
    installments: cardData.installments,
    payer: {
      email: cardData.payer.email,
      identification: cardData.payer.identification,
    },
    legal_consent: {
      terms: true,
      privacy: true,
    },
  };

  if (heart) body.heart = heart;

  const payload = await apiPost(
    '/payments/orders/card',
    body,
    { 'Idempotency-Key': uuidV4() },
    { fallbackMessage: 'No pudimos iniciar el pago con tarjeta. Inténtalo nuevamente en un momento, por favor.' },
  );

  return normalizeCardOrder(payload);
}

const REJECTION_MESSAGES = Object.freeze({
  CC_REJECTED_INSUFFICIENT_AMOUNT: 'La tarjeta no tenía fondos disponibles para esta compra. Puedes probar con otra tarjeta o volver a intentarlo más tarde.',
  CC_REJECTED_BAD_FILLED_CARD_NUMBER: 'El número de tarjeta parece incompleto. Revísalo e inténtalo nuevamente.',
  CC_REJECTED_BAD_FILLED_SECURITY_CODE: 'El código de seguridad parece incompleto. Revísalo e inténtalo nuevamente.',
  CC_REJECTED_BAD_FILLED_DATE: 'La fecha de vencimiento parece incompleta. Revísala e inténtalo nuevamente.',
  CC_REJECTED_3DS_MANDATORY: 'Tu banco pide una verificación adicional. Complétala en la página del banco antes de continuar.',
  PENDING_CHALLENGE: 'Tu banco pide una verificación adicional. Complétala en la página del banco antes de continuar.',
  CC_REJECTED_DUPLICATED_PAYMENT: 'Este pago ya estaba registrado. Revisa tu saldo antes de intentar nuevamente.',
  CC_REJECTED_HIGH_RISK: 'No pudimos completar el pago por una revisión de seguridad. No se acreditó ningún crédito; puedes probar con otra tarjeta.',
  REJECTED_BY_BANK: 'El banco no aprobó esta operación. No se acreditó ningún crédito; puedes probar con otra tarjeta.',
  CC_REJECTED_OTHER_REASON: 'No pudimos completar el pago y no se acreditó ningún crédito. Puedes intentarlo nuevamente cuando quieras.',
});

const PAYMENT_OUTCOMES = Object.freeze({
  APPROVED: {
    kind: 'approved',
    title: 'Tu pago fue aprobado',
    message: 'Los créditos ya están en tu billetera.',
  },
  AUTHORIZED: {
    kind: 'pending',
    title: 'Tu pago está en revisión',
    message: 'La operación fue autorizada y los créditos se acreditarán cuando el banco confirme el pago.',
  },
  IN_PROCESS: {
    kind: 'pending',
    title: 'Tu pago está en revisión',
    message: 'La operación está en camino y los créditos se acreditarán cuando el pago sea confirmado.',
  },
  PENDING: {
    kind: 'pending',
    title: 'Tu pago está en revisión',
    message: 'Estamos confirmando el pago; los créditos aparecerán en tu billetera cuando sea aprobado.',
  },
  REJECTED: {
    kind: 'rejected',
    title: 'No pudimos completar el pago',
    message: 'No se acreditó ningún crédito. Puedes intentarlo nuevamente cuando quieras.',
  },
  FAILED: {
    kind: 'rejected',
    title: 'No pudimos completar el pago',
    message: 'No se acreditó ningún crédito. Puedes intentarlo nuevamente cuando quieras.',
  },
  CANCELED: {
    kind: 'canceled',
    title: 'El pago no se completó',
    message: 'No se acreditó ningún crédito. Puedes volver a intentarlo cuando quieras.',
  },
  CANCELLED: {
    kind: 'canceled',
    title: 'El pago no se completó',
    message: 'No se acreditó ningún crédito. Puedes volver a intentarlo cuando quieras.',
  },
});

/**
 * Converts a gateway state into calm, actionable buyer-facing copy. Raw
 * provider codes never reach the product UI.
 *
 * @param {string|null} status
 * @param {string|null} statusDetail
 * @returns {{ kind: string, title: string, message: string }}
 */
export function paymentOutcome(status, statusDetail) {
  const state = String(status || '').toUpperCase();
  const detail = String(statusDetail || '').toUpperCase();
  const rejection = REJECTION_MESSAGES[detail];

  if (rejection) {
    return {
      kind: detail === 'PENDING_CHALLENGE' || detail === 'CC_REJECTED_3DS_MANDATORY' ? 'pending' : 'rejected',
      title: detail === 'PENDING_CHALLENGE' || detail === 'CC_REJECTED_3DS_MANDATORY'
        ? 'Tu banco pide una verificación adicional'
        : 'No pudimos completar el pago',
      message: rejection,
    };
  }

  const outcome = PAYMENT_OUTCOMES[state] || PAYMENT_OUTCOMES.PENDING;
  return outcome;
}
