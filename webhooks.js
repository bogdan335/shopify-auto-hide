// webhooks.js — приём inventory_levels/update, дебаунс и обновление статусов товаров
import express from 'express';
import crypto from 'crypto';
import { shopifyGraphql } from './graphql.js';
import {
  getShop,
  markProductHidden,
  isProductHiddenByApp,
  unmarkProductHidden,
  deleteShop,
} from './db.js';
import { hasActiveSubscription, invalidateSubscriptionCache } from './billing.js';
import { getFreshAccessToken } from './tokens.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Дебаунс: копим inventory_item_id по магазину, обрабатываем после 30с тишины
// ---------------------------------------------------------------------------
const DEBOUNCE_MS = 30_000;
const pendingBatches = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueueInventoryItem(shopUrl, inventoryItemId) {
  let batch = pendingBatches.get(shopUrl);
  if (!batch) {
    batch = { timer: null, itemIds: new Set() };
    pendingBatches.set(shopUrl, batch);
  }
  batch.itemIds.add(String(inventoryItemId));
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    const itemIds = [...batch.itemIds];
    pendingBatches.delete(shopUrl);
    processBatch(shopUrl, itemIds).catch((err) => {
      console.error(`[webhooks] Ошибка обработки батча для ${shopUrl}:`, err.message);
    });
  }, DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Верификация HMAC
// ---------------------------------------------------------------------------
// Временная диагностика: помогает отличить свежие события от ретраев старых
// доставок (Shopify ретраит неудачные вебхуки несколько часов)
function logHmacFailure(req, shopUrl) {
  const body = req.body;
  const isBuf = Buffer.isBuffer(body);
  const bodyLen = isBuf ? body.length : -1;
  const bodyPreview = isBuf ? body.toString('utf8', 0, 120) : `не Buffer: ${typeof body}`;
  const secret = process.env.SHOPIFY_API_SECRET;
  const computed = isBuf
    ? crypto.createHmac('sha256', secret).update(body).digest('base64')
    : 'n/a';
  // Проверяем гипотезу: в env-переменной прицепился пробел/перенос строки
  const computedTrimmed = isBuf
    ? crypto.createHmac('sha256', secret.trim()).update(body).digest('base64')
    : 'n/a';
  const trimmedMatches = computedTrimmed === req.get('X-Shopify-Hmac-Sha256');
  console.warn(
    `[webhooks] Невалидный HMAC от ${shopUrl || 'неизвестного источника'}: ` +
      `topic=${req.get('X-Shopify-Topic')}, ` +
      `triggered_at=${req.get('X-Shopify-Triggered-At')}, ` +
      `api_version=${req.get('X-Shopify-API-Version')}, ` +
      `content_type=${req.get('Content-Type')}, ` +
      `content_encoding=${req.get('Content-Encoding') || 'none'}, ` +
      `content_length=${req.get('Content-Length')}, ` +
      `actual_body_bytes=${bodyLen}, ` +
      `computed_hmac_prefix=${computed.slice(0, 10)}, ` +
      `received_hmac_prefix=${(req.get('X-Shopify-Hmac-Sha256') || '').slice(0, 10)}, ` +
      `secret_len=${secret.length}, secret_trimmed_len=${secret.trim().length}, ` +
      `trimmed_matches=${trimmedMatches}, ` +
      `body_preview=${JSON.stringify(bodyPreview)}`
  );
}

function verifyWebhookHmac(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(rawBody)
    .digest('base64');
  const digestBuffer = Buffer.from(digest, 'utf8');
  const headerBuffer = Buffer.from(hmacHeader, 'utf8');
  if (digestBuffer.length !== headerBuffer.length) return false;
  return crypto.timingSafeEqual(digestBuffer, headerBuffer);
}

// ---------------------------------------------------------------------------
// GraphQL-запросы
// ---------------------------------------------------------------------------
const INVENTORY_ITEMS_QUERY = `
  query InventoryItemsToProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        variant {
          product {
            id
            status
            totalInventory
            tracksInventory
          }
        }
      }
    }
  }
`;

const PRODUCT_UPDATE_MUTATION = `
  mutation SetProductStatus($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id status }
      userErrors { field message }
    }
  }
`;

function chunk(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

async function processBatch(shopUrl, inventoryItemIds) {
  const shop = await getShop(shopUrl);
  if (!shop) {
    console.warn(`[webhooks] Магазин ${shopUrl} не найден в БД, батч пропущен`);
    return;
  }

  // Живой access-токен (обновится сам, если истёк)
  const accessToken = await getFreshAccessToken(shopUrl);
  if (!accessToken) {
    console.warn(`[webhooks] ${shopUrl}: нет валидного токена, батч пропущен`);
    return;
  }

  // Без активной подписки (или триала) товары не трогаем
  if (!(await hasActiveSubscription(shopUrl, accessToken))) {
    console.log(`[webhooks] ${shopUrl}: нет активной подписки, батч пропущен`);
    return;
  }

  const gql = (query, variables) =>
    shopifyGraphql(shopUrl, accessToken, query, variables);

  const products = new Map();
  const gids = inventoryItemIds.map((id) => `gid://shopify/InventoryItem/${id}`);

  for (const idsChunk of chunk(gids, 100)) {
    const data = await gql(INVENTORY_ITEMS_QUERY, { ids: idsChunk });
    for (const node of data?.nodes || []) {
      const product = node?.variant?.product;
      if (!product) continue;
      products.set(product.id, {
        status: product.status,
        totalInventory: product.totalInventory,
        tracksInventory: product.tracksInventory,
      });
    }
  }

  console.log(
    `[webhooks] ${shopUrl}: батч из ${inventoryItemIds.length} позиций → ${products.size} товаров`
  );

  for (const [productGid, info] of products) {
    try {
      if (info.tracksInventory === false) continue;

      const soldOut = info.totalInventory <= 0;

      // Пауза (тумблер в настройках) останавливает только скрытие новых
      // sold-out; возврат при пополнении работает всегда, чтобы товары
      // не застревали в Draft.
      if (soldOut && info.status === 'ACTIVE' && shop.auto_hide_enabled === false) {
        continue;
      }

      if (soldOut && info.status === 'ACTIVE') {
        await setProductStatus(gql, productGid, 'DRAFT');
        await markProductHidden(shopUrl, productGid);
        console.log(`[webhooks] ${shopUrl}: скрыт ${productGid} (sold out)`);
      } else if (!soldOut && info.status === 'DRAFT') {
        const hiddenByApp = await isProductHiddenByApp(shopUrl, productGid);
        if (hiddenByApp) {
          await setProductStatus(gql, productGid, 'ACTIVE');
          await unmarkProductHidden(shopUrl, productGid);
          console.log(`[webhooks] ${shopUrl}: опубликован ${productGid} (restock)`);
        }
      }

      await sleep(250);
    } catch (err) {
      console.error(`[webhooks] ${shopUrl}: ошибка обновления ${productGid}:`, err.message);
    }
  }
}

async function setProductStatus(gql, productGid, status) {
  const data = await gql(PRODUCT_UPDATE_MUTATION, {
    input: { id: productGid, status },
  });
  const userErrors = data?.productUpdate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join('; '));
  }
}

// ---------------------------------------------------------------------------
// Роут вебхука (raw body для HMAC)
// ---------------------------------------------------------------------------
router.post(
  '/webhooks/inventory-levels-update',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    try {
      const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
      const shopUrl = req.get('X-Shopify-Shop-Domain');
      const topic = req.get('X-Shopify-Topic');

      if (!verifyWebhookHmac(req.body, hmacHeader)) {
        logHmacFailure(req, shopUrl);
        return res.status(401).send('Invalid HMAC');
      }
      if (topic !== 'inventory_levels/update' || !shopUrl) {
        return res.status(400).send('Bad request');
      }

      let payload;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch {
        return res.status(400).send('Invalid JSON');
      }
      if (payload?.inventory_item_id == null) {
        return res.status(400).send('Missing inventory_item_id');
      }

      res.status(200).send('OK');
      enqueueInventoryItem(shopUrl, payload.inventory_item_id);
    } catch (err) {
      console.error('[webhooks] Необработанная ошибка роута:', err.message);
      if (!res.headersSent) res.status(500).send('Internal error');
    }
  }
);

// ---------------------------------------------------------------------------
// Роут вебхука app/uninstalled: мерчант удалил приложение → чистим БД
// ---------------------------------------------------------------------------
router.post(
  '/webhooks/app-uninstalled',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
      const shopUrl = req.get('X-Shopify-Shop-Domain');
      const topic = req.get('X-Shopify-Topic');

      if (!verifyWebhookHmac(req.body, hmacHeader)) {
        logHmacFailure(req, shopUrl);
        return res.status(401).send('Invalid HMAC');
      }
      if (topic !== 'app/uninstalled' || !shopUrl) {
        return res.status(400).send('Bad request');
      }

      res.status(200).send('OK');

      const batch = pendingBatches.get(shopUrl);
      if (batch) {
        clearTimeout(batch.timer);
        pendingBatches.delete(shopUrl);
      }

      await deleteShop(shopUrl);
      invalidateSubscriptionCache(shopUrl);
      console.log(`[webhooks] ${shopUrl}: приложение удалено, запись очищена из БД`);
    } catch (err) {
      console.error('[webhooks] Ошибка обработки app/uninstalled:', err.message);
      if (!res.headersSent) res.status(500).send('Internal error');
    }
  }
);

// ---------------------------------------------------------------------------
// GDPR/compliance-вебхуки (обязательны для ревью App Store).
// Их нельзя зарегистрировать через API — URL прописывается в Dev Dashboard,
// все три топика ведут на этот endpoint. Данных покупателей мы не храним,
// поэтому по customers/* делать нечего; по shop/redact подчищаем магазин.
// ---------------------------------------------------------------------------
const COMPLIANCE_TOPICS = new Set([
  'customers/data_request',
  'customers/redact',
  'shop/redact',
]);

router.post(
  '/webhooks/compliance',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
      const shopUrl = req.get('X-Shopify-Shop-Domain');
      const topic = req.get('X-Shopify-Topic');

      // Ревью Shopify проверяет: невалидная подпись должна получать 401
      if (!verifyWebhookHmac(req.body, hmacHeader)) {
        logHmacFailure(req, shopUrl);
        return res.status(401).send('Invalid HMAC');
      }
      if (!COMPLIANCE_TOPICS.has(topic) || !shopUrl) {
        return res.status(400).send('Bad request');
      }

      res.status(200).send('OK');
      console.log(`[webhooks] ${shopUrl}: compliance-вебхук ${topic} обработан`);

      // shop/redact: окончательная зачистка данных магазина (идемпотентно —
      // app/uninstalled обычно уже всё удалил)
      if (topic === 'shop/redact') {
        await deleteShop(shopUrl);
      }
    } catch (err) {
      console.error('[webhooks] Ошибка обработки compliance-вебхука:', err.message);
      if (!res.headersSent) res.status(500).send('Internal error');
    }
  }
);

export default router;