// db.js — инициализация PostgreSQL и слой доступа к данным
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[db] Неожиданная ошибка простаивающего клиента pool:', err.message);
});

/**
 * Создаёт таблицы, если их нет. Вызывается один раз при старте сервера.
 */
export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS shops (
        id           SERIAL PRIMARY KEY,
        shop_url     TEXT NOT NULL UNIQUE,
        access_token TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS hidden_products (
        id         SERIAL PRIMARY KEY,
        shop_url   TEXT NOT NULL REFERENCES shops(shop_url) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        hidden_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (shop_url, product_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_hidden_products_shop
      ON hidden_products (shop_url);
    `);

    await client.query('COMMIT');
    console.log('[db] Схема БД инициализирована');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[db] Ошибка инициализации схемы:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Возвращает запись магазина (или null, если магазин не установлен).
 */
export async function getShop(shopUrl) {
  const { rows } = await pool.query(
    'SELECT id, shop_url, access_token FROM shops WHERE shop_url = $1',
    [shopUrl]
  );
  return rows[0] || null;
}

/**
 * Создаёт или обновляет магазин (используется в OAuth-колбэке).
 */
export async function upsertShop(shopUrl, accessToken) {
  const { rows } = await pool.query(
    `INSERT INTO shops (shop_url, access_token)
     VALUES ($1, $2)
     ON CONFLICT (shop_url)
     DO UPDATE SET access_token = EXCLUDED.access_token
     RETURNING id, shop_url`,
    [shopUrl, accessToken]
  );
  return rows[0];
}

/**
 * Помечает товар как скрытый нашим приложением.
 * Идемпотентно: повторная вставка не создаёт дубликат.
 */
export async function markProductHidden(shopUrl, productId) {
  await pool.query(
    `INSERT INTO hidden_products (shop_url, product_id)
     VALUES ($1, $2)
     ON CONFLICT (shop_url, product_id) DO NOTHING`,
    [shopUrl, productId]
  );
}

/**
 * Проверяет, был ли товар скрыт именно нашим приложением.
 * Это защита: мы не публикуем черновики, которые мерчант скрыл вручную.
 */
export async function isProductHiddenByApp(shopUrl, productId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM hidden_products WHERE shop_url = $1 AND product_id = $2',
    [shopUrl, productId]
  );
  return rows.length > 0;
}

/**
 * Снимает пометку "скрыт приложением" после повторной публикации.
 */
export async function unmarkProductHidden(shopUrl, productId) {
  await pool.query(
    'DELETE FROM hidden_products WHERE shop_url = $1 AND product_id = $2',
    [shopUrl, productId]
  );
}

/**
 * Корректно закрывает пул соединений при остановке сервера.
 */
export async function closeDb() {
  await pool.end();
  console.log('[db] Пул соединений закрыт');
}

export default pool;