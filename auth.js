// auth.js — OAuth-установка приложения + автоматическая регистрация вебхуков
// Весь OAuth сделан вручную через fetch: библиотечный клиент @shopify/shopify-api
// падает в этом окружении (Node 22 + Railway) с "Premature close".
import crypto from 'crypto';
import express from 'express';
import { shopifyGraphql } from './graphql.js';
import { upsertShop } from './db.js';
import { hasActiveSubscription, createSubscription } from './billing.js';

const router = express.Router();

const OAUTH_SCOPES = 'read_inventory,read_products,write_products';
const STATE_COOKIE = 'oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000; // state живёт 10 минут

const WEBHOOK_CREATE_MUTATION = `
  mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

function isValidShopDomain(shop) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop || '');
}

// ---------------------------------------------------------------------------
// Подписанный state: "значение.подпись" — подделать без секрета нельзя
// ---------------------------------------------------------------------------
function signValue(value) {
  return crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(value)
    .digest('hex');
}

function timingSafeEq(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(req) {
  const cookies = {};
  for (const pair of (req.headers.cookie || '').split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return cookies;
}

// ---------------------------------------------------------------------------
// Проверка подписи query-параметров колбэка: hmac считается по остальным
// параметрам, отсортированным по ключу (документация Shopify OAuth)
// ---------------------------------------------------------------------------
function verifyCallbackQuery(query) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(',') : rest[key]}`)
    .join('&');
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(message)
    .digest('hex');
  return timingSafeEq(digest, hmac);
}

// ---------------------------------------------------------------------------
// Шаг 1: мерчант открывает /auth?shop=xxx.myshopify.com → редирект на согласие
// ---------------------------------------------------------------------------
router.get('/auth', (req, res) => {
  try {
    const shop = req.query.shop;
    if (!isValidShopDomain(shop)) {
      return res.status(400).send('Некорректный параметр shop. Формат: xxx.myshopify.com');
    }

    // Случайный state + время выдачи; подпись не даёт подменить содержимое
    const state = `${crypto.randomBytes(16).toString('hex')}-${Date.now()}`;
    const cookieValue = `${state}.${signValue(state)}`;
    res.setHeader(
      'Set-Cookie',
      `${STATE_COOKIE}=${encodeURIComponent(cookieValue)}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`
    );

    const authorizeUrl =
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${process.env.SHOPIFY_API_KEY}` +
      `&scope=${OAUTH_SCOPES}` +
      `&redirect_uri=${encodeURIComponent(`https://${process.env.HOST_NAME}/auth/callback`)}` +
      `&state=${encodeURIComponent(state)}`;

    res.redirect(authorizeUrl);
  } catch (err) {
    console.error('[auth] Ошибка начала OAuth:', err.message);
    if (!res.headersSent) res.status(500).send('OAuth error');
  }
});

// ---------------------------------------------------------------------------
// Шаг 2: Shopify возвращает code → проверяем подпись и state, меняем на токен
// ---------------------------------------------------------------------------
router.get('/auth/callback', async (req, res) => {
  try {
    const { shop, code, state } = req.query;
    if (!isValidShopDomain(shop) || !code || !state) {
      return res.status(400).send('Некорректные параметры колбэка');
    }

    // 1. Подпись query-параметров: колбэк действительно прислал Shopify
    if (!verifyCallbackQuery(req.query)) {
      console.warn(`[auth] Невалидная подпись колбэка для ${shop}`);
      return res.status(401).send('Invalid callback signature');
    }

    // 2. State: установку начал именно этот браузер (защита от CSRF)
    const cookieValue = parseCookies(req)[STATE_COOKIE] || '';
    const lastDot = cookieValue.lastIndexOf('.');
    const cookieState = lastDot > 0 ? cookieValue.slice(0, lastDot) : '';
    const cookieSig = lastDot > 0 ? cookieValue.slice(lastDot + 1) : '';
    const stateIssuedAt = Number(cookieState.split('-')[1] || 0);

    const stateValid =
      cookieState &&
      timingSafeEq(cookieState, state) &&
      timingSafeEq(cookieSig, signValue(cookieState)) &&
      Date.now() - stateIssuedAt < STATE_TTL_MS;

    if (!stateValid) {
      console.warn(`[auth] Невалидный или просроченный state для ${shop}`);
      return res.status(403).send('Invalid OAuth state. Начните установку заново.');
    }

    // Гасим cookie: state одноразовый
    res.setHeader(
      'Set-Cookie',
      `${STATE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
    );

    // 3. Обмен кода на офлайн-токен (вручную, с ретраями)
    let tokenData = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            client_id: process.env.SHOPIFY_API_KEY,
            client_secret: process.env.SHOPIFY_API_SECRET,
            code,
          }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        tokenData = await resp.json();
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[auth] Попытка ${attempt} обмена токена не удалась: ${err.message}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    if (!tokenData?.access_token) throw lastErr || new Error('Не удалось получить токен');

    await upsertShop(shop, tokenData.access_token);
    console.log(`[auth] Приложение установлено на ${shop}`);

    await registerWebhook(shop, tokenData.access_token, 'INVENTORY_LEVELS_UPDATE', '/webhooks/inventory-levels-update');
    await registerWebhook(shop, tokenData.access_token, 'APP_UNINSTALLED', '/webhooks/app-uninstalled');

    // Биллинг: без активной подписки отправляем на страницу подтверждения
    // оплаты ($6.99/мес, 7 дней триала). Уже подписан — сразу в админку.
    try {
      if (await hasActiveSubscription(shop, tokenData.access_token)) {
        return res.redirect(`https://${shop}/admin/apps`);
      }
      const confirmationUrl = await createSubscription(shop, tokenData.access_token);
      console.log(`[auth] ${shop}: подписка создана, мерчант отправлен на подтверждение`);
      return res.redirect(confirmationUrl);
    } catch (err) {
      // Не роняем установку из-за сбоя биллинга: попробуем при следующем заходе
      console.error(`[auth] ${shop}: ошибка биллинга:`, err.message);
      return res.redirect(`https://${shop}/admin/apps`);
    }
  } catch (err) {
    console.error('[auth] Ошибка OAuth-колбэка:', err.message);
    if (!res.headersSent) res.status(500).send('OAuth callback error');
  }
});

async function registerWebhook(shop, accessToken, topic, callbackPath) {
  try {
    const data = await shopifyGraphql(shop, accessToken, WEBHOOK_CREATE_MUTATION, {
      topic,
      sub: {
        callbackUrl: `https://${process.env.HOST_NAME}${callbackPath}`,
        format: 'JSON',
      },
    });

    const errors = data?.webhookSubscriptionCreate?.userErrors || [];
    const real = errors.filter((e) => !e.message.includes('taken'));
    if (real.length > 0) {
      console.error(`[auth] Ошибки регистрации вебхука ${topic}: ${real.map((e) => e.message).join(', ')}`);
    } else {
      console.log(`[auth] Вебхук ${topic} зарегистрирован для ${shop}`);
    }
  } catch (err) {
    console.error(`[auth] Не удалось зарегистрировать вебхук ${topic}:`, err.message);
  }
}

export default router;
