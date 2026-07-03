// webhooks.js — приём inventory_levels/update, дебаунс и обновление статусов товаров
import express from 'express';
import crypto from 'crypto';
import { shopifyGraphql } from './graphql.js';
import {
  getShop,
  markProductHidden,
  isProductHiddenByApp,
  unmarkProductHidden,
} from './db.js';

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

  const gql = (query, variables) =>
    shopifyGraphql(shop.shop_url, shop.access_token, query, variables);

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

      res.status(200).send('OK');
      enqueueInventoryItem(shopUrl, payload.inventory_item_id);
    } catch (err) {
      console.error('[webhooks] Необработанная ошибка роута:', err.message);
      if (!res.headersSent) res.status(500).send('Internal error');
    }
  }
);

export default router;