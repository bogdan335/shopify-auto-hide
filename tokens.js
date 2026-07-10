// tokens.js — работа с истекающими offline-токенами (обязательны для
// публичных приложений). Access-токен живёт ~1 час, refresh-токен ~90 дней;
// перед каждым использованием берём живой токен, при необходимости обновляя.
import { getShop, upsertShop } from './db.js';

// Обновляем заранее, за 2 минуты до истечения
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

/**
 * Обменивает code (установка) или refresh_token (продление) на новый
 * access-токен. Возвращает { access_token, refresh_token, expires_in, ... }.
 */
export async function requestAccessToken(shop, params, maxAttempts = 3) {
  const body = new URLSearchParams({
    client_id: process.env.SHOPIFY_API_KEY,
    client_secret: process.env.SHOPIFY_API_SECRET,
    ...params,
  });

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      const data = await resp.json();
      if (!data?.access_token) throw new Error('Ответ без access_token');
      return data;
    } catch (err) {
      lastErr = err;
      console.warn(`[tokens] ${shop}: попытка ${attempt} не удалась: ${err.message}`);
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

/**
 * Сохраняет токены из ответа Shopify в БД и возвращает access-токен.
 */
export async function storeTokens(shop, tokenData) {
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000)
    : null;
  await upsertShop(shop, tokenData.access_token, tokenData.refresh_token || null, expiresAt);
  return tokenData.access_token;
}

/**
 * Возвращает живой access-токен магазина, обновляя его при необходимости.
 * null — магазина нет в БД или токен уже не спасти (нужна переустановка).
 */
export async function getFreshAccessToken(shopUrl) {
  const shop = await getShop(shopUrl);
  if (!shop) return null;

  // Токен ещё жив (с запасом) — отдаём как есть.
  // Старые записи без token_expires_at (вечные токены) тоже попадают сюда:
  // пусть API сам скажет, принимает ли он их ещё.
  const expiresAt = shop.token_expires_at ? new Date(shop.token_expires_at).getTime() : null;
  if (!expiresAt || expiresAt - Date.now() > EXPIRY_MARGIN_MS) {
    return shop.access_token;
  }

  if (!shop.refresh_token) {
    console.warn(`[tokens] ${shopUrl}: токен истёк, refresh_token отсутствует — нужна переустановка`);
    return null;
  }

  try {
    const data = await requestAccessToken(shopUrl, {
      grant_type: 'refresh_token',
      refresh_token: shop.refresh_token,
    });
    console.log(`[tokens] ${shopUrl}: access-токен обновлён`);
    return await storeTokens(shopUrl, data);
  } catch (err) {
    console.error(`[tokens] ${shopUrl}: не удалось обновить токен:`, err.message);
    return null;
  }
}
