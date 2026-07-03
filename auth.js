// auth.js — OAuth-установка приложения + автоматическая регистрация вебхука
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
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    await upsertShop(session.shop, session.accessToken);
    console.log(`[auth] Приложение установлено на ${session.shop}`);

    await registerInventoryWebhook(session);

    res.redirect(`https://${session.shop}/admin/apps`);
  } catch (err) {
    console.error('[auth] Ошибка OAuth-колбэка:', err.message);
    if (!res.headersSent) res.status(500).send('OAuth callback error');
  }
});

async function registerInventoryWebhook(session) {
  const client = new shopify.clients.Graphql({ session });
  try {
    const response = await client.request(WEBHOOK_CREATE_MUTATION, {
      variables: {
        topic: 'INVENTORY_LEVELS_UPDATE',
        sub: {
          callbackUrl: `https://${process.env.HOST_NAME}/webhooks/inventory-levels-update`,
          format: 'JSON',
        },
      },
    });
    const errors = response.data?.webhookSubscriptionCreate?.userErrors || [];
    // "already taken" при переустановке — не ошибка
    const real = errors.filter((e) => !e.message.includes('taken'));
    if (real.length > 0) {
      console.error(`[auth] Ошибки регистрации вебхука: ${real.map((e) => e.message).join('; ')}`);
    } else {
      console.log(`[auth] Вебхук inventory_levels/update зарегистрирован для ${session.shop}`);
    }
  } catch (err) {
    console.error('[auth] Не удалось зарегистрировать вебхук:', err.message);
  }
}

export default router;