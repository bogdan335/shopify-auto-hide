// server.js — точка входа приложения
import 'dotenv/config';
import express from 'express';
import { initDb, closeDb } from './db.js';
import webhooksRouter from './webhooks.js';
import authRouter from './auth.js';
import appRouter from './app.js';
const REQUIRED_ENV = [
  'DATABASE_URL',
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'HOST_NAME',
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`[server] Отсутствуют переменные окружения: ${missing.join(', ')}`);
    process.exit(1);
  }
}

async function main() {
  validateEnv();
  await initDb();

  const app = express();
  app.disable('x-powered-by');

  // Роутер вебхуков монтируется ДО express.json():
  // ему нужно сырое тело запроса для проверки HMAC
  app.use(webhooksRouter);
  app.use(authRouter);
  app.use(express.json());
  // Embedded страница настроек и её API (нужен разобранный JSON)
  app.use(appRouter);

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
  });

  // Централизованный обработчик ошибок
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[server] Ошибка middleware:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => {
    console.log(`[server] Auto-Hide Sold Out запущен на порту ${port}`);
  });

  // Graceful shutdown: дорабатываем текущие запросы, закрываем пул БД
  const shutdown = async (signal) => {
    console.log(`[server] Получен ${signal}, останавливаемся...`);
    server.close(async () => {
      try {
        await closeDb();
      } catch (err) {
        console.error('[server] Ошибка при закрытии БД:', err.message);
      }
      process.exit(0);
    });
    // Форс-выход, если за 10 секунд не завершились
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled rejection:', reason);
  });
}

main().catch((err) => {
  console.error('[server] Фатальная ошибка запуска:', err.message);
  process.exit(1);
});