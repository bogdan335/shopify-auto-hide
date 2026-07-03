// webhooks.js — приём inventory_levels/update, дебаунс и обновление статусов товаров
import express from 'express';
import crypto from 'crypto';
import '@shopify/shopify-api/adapters/node';
import { shopifyApi, ApiVersion, Session } from '@shopify/shopify-api';
import {
  getShop,
  markProductHidden,
  isProductHiddenByApp,
  unmarkProductHidden,
} from './db.js';

const router = express.Router();

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_products', 'write_products', 'read_inventory'],
  hostName: process.env.HOST_NAME,
  apiVersion: '2026-07',
  isEmbeddedApp: true,
});

// ---------------------------------------------------------------------------
// Дебаунс: Shopify шлёт отдельный webhook на КАЖДУЮ позицию инвентаря.
// При массовом обновлении (импорт CSV, синк со склада) прилетают сотни
// событий за секунды. Копим inventory_item_id по каждому магазину и
// обрабатываем пачкой через 30 секунд тишины.
// ---------------------------------------------------------------------------
const DEBOUNCE_MS = 30_000;

/** @type {Map<string, { timer: NodeJS.Timeout, itemIds: Set<string> }>} */
const pendingBatches = new Map();

function enqueueInventoryItem(shopUrl, inventoryItemId) {
  let batch = pendingBatches.get(shopUrl);

  if (!batch) {
    batch = { timer: null, itemIds: new Set() };
    pendingBatches.set(shopUrl, batch);
  }

  batch.itemIds.add(String(inventoryItemId));

  // Сдвигаем таймер: пока идёт поток событий — ждём
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
// Верификация HMAC — обязательна, иначе любой может дёргать эндпоинт
// ---------------------------------------------------------------------------
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
// GraphQL-хелперы с ретраями при троттлинге
// ---------------------------------------------------------------------------
function buildGraphqlClient(shopUrl, accessToken) {
  const session = new Session({
    id: `offline_${shopUrl}`,
    shop: shopUrl,
    state: 'offline',
    isOnline: false,
    accessToken,
  });
  return new shopify.clients.Graphql({ session });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function graphqlWithRetry(client, query, variables = {}, maxAttempts = 4) {
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const response = await client.request(query, { variables });
      return response.data;
    } catch (err) {
      lastError = err;
      const isThrottled =
        err?.graphQLErrors?.some((e) => e?.extensions?.code === 'THROTTLED') ||
        err?.response?.code === 429;

      if (isThrottled && attempt < maxAttempts) {
        const backoff = 1000 * 2 ** attempt; // 2s, 4s, 8s
        console.warn(`[webhooks] Троттлинг API, повтор через ${backoff}мс (попытка ${attempt})`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Основная логика: inventory_item_id → товары → скрыть/показать
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

  const client = buildGraphqlClient(shop.shop_url, shop.access_token);

  // Собираем уникальные товары по всем изменённым позициям инвентаря
  /** @type {Map<string, { status: string, totalInventory: number, tracksInventory: boolean }>} */
  const products = new Map();

  const gids = inventoryItemIds.map((id) => `gid://shopify/InventoryItem/${id}`);

  for (const idsChunk of chunk(gids, 100)) {
    const data = await graphqlWithRetry(client, INVENTORY_ITEMS_QUERY, { ids: idsChunk });

    for (const node of data?.nodes || []) {
      const product = node?.variant?.product;
      if (!product) continue; // вариант/товар мог быть удалён
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

  // Обрабатываем товары последовательно с небольшой паузой — бережём rate limit
  for (const [productGid, info] of products) {
    try {
      // Товары без трекинга инвентаря не трогаем
      if (info.tracksInventory === false) continue;

      const soldOut = info.totalInventory <= 0;

      if (soldOut && info.status === 'ACTIVE') {
        await setProductStatus(client, productGid, 'DRAFT');
        await markProductHidden(shopUrl, productGid);
        console.log(`[webhooks] ${shopUrl}: скрыт ${productGid} (sold out)`);
      } else if (!soldOut && info.status === 'DRAFT') {
        // Публикуем ТОЛЬКО то, что скрыли мы сами
        const hiddenByApp = await isProductHiddenByApp(shopUrl, productGid);
        if (hiddenByApp) {
          await setProductStatus(client, productGid, 'ACTIVE');
          await unmarkProductHidden(shopUrl, productGid);
          console.log(`[webhooks] ${shopUrl}: опубликован ${productGid} (restock)`);
        }
      }

      await sleep(250);
    } catch (err) {
      // Ошибка одного товара не должна ронять весь батч
      console.error(`[webhooks] ${shopUrl}: ошибка обновления ${productGid}:`, err.message);
    }
  }
}

async function setProductStatus(client, productGid, status) {
  const data = await graphqlWithRetry(client, PRODUCT_UPDATE_MUTATION, {
    input: { id: productGid, status },
  });

  const userErrors = data?.productUpdate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join('; '));
  }
}

// ---------------------------------------------------------------------------
// Роут вебхука. ВАЖНО: express.raw — HMAC считается по сырому телу
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
        console.warn(`[webhooks] Невалидный HMAC от ${shopUrl || 'неизвестного источника'}`);
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

      // Отвечаем сразу — Shopify ждёт 200 в течение 5 секунд,
      // иначе начинает ретраить и в итоге удаляет подписку
      res.status(200).send('OK');

      enqueueInventoryItem(shopUrl, payload.inventory_item_id);
    } catch (err) {
      console.error('[webhooks] Необработанная ошибка роута:', err.message);
      if (!res.headersSent) res.status(500).send('Internal error');
    }
  }
);

export default router;