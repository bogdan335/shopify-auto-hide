// auth.js — OAuth-установка приложения + автоматическая регистрация вебхука
import { shopifyGraphql } from './graphql.js';
import express from 'express';
import { Session } from '@shopify/shopify-api';
import { shopify } from './shopify.js';
import { upsertShop } from './db.js';

const router = express.Router();

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

// Шаг 1: мерчант открывает /auth?shop=xxx.myshopify.com → редирект на согласие
router.get('/auth', async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!isValidShopDomain(shop)) {
      return res.status(400).send('Некорректный параметр shop. Формат: xxx.myshopify.com');
    }
    await shopify.auth.begin({
      shop,
      callbackPath: '/auth/callback',
      isOnline: false, // офлайн-токен: не истекает, нужен для вебхуков
      rawRequest: req,
      rawResponse: res,
    });
  } catch (err) {
    console.error('[auth] Ошибка начала OAuth:', err.message);
    if (!res.headersSent) res.status(500).send('OAuth error');
  }
});

// Шаг 2: Shopify возвращает code → меняем на токен, сохраняем, вешаем вебхук
router.get('/auth/callback', async (req, res) => {
  try {
    const { shop, code, hmac } = req.query;
    if (!isValidShopDomain(shop) || !code || !hmac) {
      return res.status(400).send('Некорректные параметры колбэка');
    }

    // Ручной обмен кода на офлайн-токен с ретраями
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

    const session = new Session({
      id: `offline_${shop}`,
      shop,
      state: 'manual',
      isOnline: false,
      accessToken: tokenData.access_token,
    });
    await registerWebhook(session, 'INVENTORY_LEVELS_UPDATE', '/webhooks/inventory-levels-update');
    await registerWebhook(session, 'APP_UNINSTALLED', '/webhooks/app-uninstalled');

    res.redirect(`https://${shop}/admin/apps`);
  } catch (err) {
    console.error('[auth] Ошибка OAuth-колбэка:', err.message);
    if (!res.headersSent) res.status(500).send('OAuth callback error');
  }
});

async function registerWebhook(session, topic, callbackPath) {
    try {
        const data = await shopifyGraphql(session.shop, session.accessToken, WEBHOOK_CREATE_MUTATION, {
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
            console.log(`[auth] Вебхук ${topic} зарегистрирован для ${session.shop}`);
        }
    } catch (err) {
        console.error(`[auth] Не удалось зарегистрировать вебхук ${topic}:`, err.message);
    }
}

export default router;