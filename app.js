// app.js — embedded страница настроек (открывается внутри админки Shopify)
// и её API. Авторизация API — session-токены App Bridge (JWT HS256).
import crypto from 'crypto';
import express from 'express';
import { getShop, setAutoHideEnabled, listHiddenProducts } from './db.js';
import { getFreshAccessToken } from './tokens.js';
import { shopifyGraphql } from './graphql.js';

const router = express.Router();

function isValidShopDomain(shop) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop || '');
}

// ---------------------------------------------------------------------------
// Проверка session-токена App Bridge: JWT, подписанный секретом приложения.
// Возвращает домен магазина или null.
// ---------------------------------------------------------------------------
function verifySessionToken(token) {
  try {
    const [headerB64, payloadB64, sigB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !sigB64) return null;

    const expected = crypto
      .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');
    const sigBuf = Buffer.from(sigB64, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;
    if (payload.aud !== process.env.SHOPIFY_API_KEY) return null;

    const shop = String(payload.dest || '').replace(/^https:\/\//, '');
    return isValidShopDomain(shop) ? shop : null;
  } catch {
    return null;
  }
}

// Middleware для API-роутов: достаёт магазин из Authorization: Bearer <jwt>
async function requireSession(req, res, next) {
  const auth = req.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const shopUrl = verifySessionToken(token);
  if (!shopUrl) return res.status(401).json({ error: 'Invalid session token' });

  const shop = await getShop(shopUrl);
  if (!shop) return res.status(404).json({ error: 'Shop not installed' });

  req.shopRecord = shop;
  next();
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
router.get('/api/settings', requireSession, async (req, res) => {
  res.json({
    shop: req.shopRecord.shop_url,
    autoHideEnabled: req.shopRecord.auto_hide_enabled !== false,
  });
});

router.post('/api/settings', requireSession, async (req, res) => {
  const enabled = Boolean(req.body?.autoHideEnabled);
  await setAutoHideEnabled(req.shopRecord.shop_url, enabled);
  console.log(`[app] ${req.shopRecord.shop_url}: автоскрытие ${enabled ? 'включено' : 'на паузе'}`);
  res.json({ autoHideEnabled: enabled });
});

const PRODUCT_TITLES_QUERY = `
  query ProductTitles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id title status }
    }
  }
`;

router.get('/api/hidden-products', requireSession, async (req, res) => {
  const shopUrl = req.shopRecord.shop_url;
  const rows = await listHiddenProducts(shopUrl);
  if (rows.length === 0) return res.json({ products: [] });

  // Подтягиваем названия товаров из Shopify (best effort)
  const titles = new Map();
  try {
    const accessToken = await getFreshAccessToken(shopUrl);
    if (accessToken) {
      const data = await shopifyGraphql(shopUrl, accessToken, PRODUCT_TITLES_QUERY, {
        ids: rows.map((r) => r.product_id),
      });
      for (const node of data?.nodes || []) {
        if (node?.id) titles.set(node.id, { title: node.title, status: node.status });
      }
    }
  } catch (err) {
    console.warn(`[app] ${shopUrl}: не удалось получить названия товаров:`, err.message);
  }

  const storeHandle = shopUrl.replace('.myshopify.com', '');
  const products = rows.map((r) => {
    const numericId = r.product_id.split('/').pop();
    const info = titles.get(r.product_id);
    return {
      id: r.product_id,
      title: info?.title || `Product ${numericId}`,
      status: info?.status || 'DRAFT',
      hiddenAt: r.hidden_at,
      adminUrl: `https://admin.shopify.com/store/${storeHandle}/products/${numericId}`,
    };
  });

  res.json({ products });
});

// ---------------------------------------------------------------------------
// Embedded страница (корень приложения в админке)
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const shop = req.query.shop;

  // Прямое открытие без параметров магазина — показать инструкцию
  if (!isValidShopDomain(shop)) {
    return res
      .status(200)
      .send('Auto-Hide Sold Out. Установка: /auth?shop=your-store.myshopify.com');
  }

  // Магазин не установлен → на OAuth (выпрыгиваем из iframe наверх)
  const record = await getShop(shop);
  if (!record) {
    return res.send(
      `<!DOCTYPE html><html><body>
        <script>window.open(${JSON.stringify(`https://${process.env.HOST_NAME}/auth?shop=${shop}`)}, '_top');</script>
      </body></html>`
    );
  }

  // Embedded-страница обязана разрешить встраивание в iframe админки
  res.setHeader(
    'Content-Security-Policy',
    `frame-ancestors https://${shop} https://admin.shopify.com;`
  );
  res.send(renderAppPage());
});

function renderAppPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="shopify-api-key" content="${process.env.SHOPIFY_API_KEY}">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<title>Auto-Hide Sold Out</title>
<style>
  :root {
    --bg: #f1f1f1; --card: #ffffff; --text: #303030; --subtext: #616161;
    --border: #e3e3e3; --green: #29845a; --green-bg: #cdfee1;
    --amber: #8a6116; --amber-bg: #ffea8a; --accent: #303030;
    --radius: 12px; --shadow: 0 1px 0 rgba(26,26,26,.07);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text); font-size: 13px; line-height: 1.5;
  }
  .page { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .header h1 { font-size: 20px; font-weight: 700; letter-spacing: -.2px; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 550;
  }
  .badge .dot { width: 7px; height: 7px; border-radius: 50%; }
  .badge.on  { background: var(--green-bg); color: var(--green); }
  .badge.on .dot { background: var(--green); }
  .badge.off { background: var(--amber-bg); color: var(--amber); }
  .badge.off .dot { background: var(--amber); }
  .card {
    background: var(--card); border-radius: var(--radius);
    box-shadow: var(--shadow); border: 1px solid var(--border);
    padding: 16px; margin-bottom: 16px;
  }
  .card h2 { font-size: 14px; font-weight: 650; margin-bottom: 4px; }
  .muted { color: var(--subtext); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  /* Тумблер */
  .switch { position: relative; width: 40px; height: 22px; flex: none; cursor: pointer; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; inset: 0; border-radius: 999px;
    background: #cccccc; transition: background .15s;
  }
  .slider:before {
    content: ""; position: absolute; width: 18px; height: 18px; border-radius: 50%;
    left: 2px; top: 2px; background: #fff; transition: transform .15s;
    box-shadow: 0 1px 2px rgba(0,0,0,.25);
  }
  .switch input:checked + .slider { background: var(--accent); }
  .switch input:checked + .slider:before { transform: translateX(18px); }
  .switch input:disabled + .slider { opacity: .5; cursor: wait; }
  /* Статистика */
  .stat { font-size: 28px; font-weight: 700; letter-spacing: -.5px; }
  /* Таблица */
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 550; color: var(--subtext); padding: 8px 8px; border-bottom: 1px solid var(--border); font-size: 12px; }
  td { padding: 10px 8px; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  td a { color: #005bd3; text-decoration: none; font-weight: 500; }
  td a:hover { text-decoration: underline; }
  .empty { text-align: center; padding: 32px 16px; color: var(--subtext); }
  .empty .icon { font-size: 28px; margin-bottom: 8px; }
  .skeleton { height: 14px; border-radius: 4px; background: linear-gradient(90deg,#eee 25%,#f7f7f7 50%,#eee 75%); background-size: 200% 100%; animation: sh 1.2s infinite; }
  @keyframes sh { to { background-position: -200% 0; } }
  .toast {
    position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(80px);
    background: #303030; color: #fff; padding: 10px 16px; border-radius: 8px;
    font-size: 13px; transition: transform .25s; z-index: 10;
  }
  .toast.show { transform: translateX(-50%) translateY(0); }
  .footer { text-align: center; color: var(--subtext); font-size: 12px; margin-top: 24px; }
  .footer a { color: #005bd3; text-decoration: none; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>Auto-Hide Sold Out</h1>
    <span class="badge on" id="statusBadge" hidden><span class="dot"></span><span id="statusText">Active</span></span>
  </div>

  <div class="card">
    <div class="row">
      <div>
        <h2>Automatically hide sold-out products</h2>
        <p class="muted">When total inventory across all locations reaches zero, the product
        is set to Draft. As soon as it's restocked, it goes back to Active — automatically.</p>
      </div>
      <label class="switch">
        <input type="checkbox" id="autoHideToggle" disabled>
        <span class="slider"></span>
      </label>
    </div>
    <p class="muted" id="pauseNote" style="margin-top:8px" hidden>
      Paused: new sold-outs stay visible. Products already hidden by the app will still
      be re-published when restocked.
    </p>
  </div>

  <div class="card">
    <h2>Currently hidden by the app</h2>
    <div class="stat" id="hiddenCount"><div class="skeleton" style="width:40px;height:28px"></div></div>
    <p class="muted">These products are in Draft and will return to Active on restock.</p>
  </div>

  <div class="card">
    <h2 style="margin-bottom:8px">Hidden products</h2>
    <div id="productList"><div class="skeleton" style="width:100%"></div></div>
  </div>

  <div class="footer">
    Questions or ideas? <a href="mailto:balatnikowbogdan@gmail.com">Get in touch</a> — we reply fast.
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
(function () {
  const $ = (id) => document.getElementById(id);

  async function api(path, options = {}) {
    const token = await window.shopify.idToken();
    const resp = await fetch(path, {
      ...options,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2200);
  }

  function renderStatus(enabled) {
    const badge = $('statusBadge');
    badge.hidden = false;
    badge.className = 'badge ' + (enabled ? 'on' : 'off');
    $('statusText').textContent = enabled ? 'Active' : 'Paused';
    $('pauseNote').hidden = enabled;
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderProducts(products) {
    $('hiddenCount').textContent = String(products.length);
    const box = $('productList');
    if (products.length === 0) {
      box.innerHTML = '<div class="empty"><div class="icon">✨</div>' +
        'Nothing is hidden right now — everything in your store is in stock.</div>';
      return;
    }
    const rows = products.map((p) =>
      '<tr><td><a href="' + p.adminUrl + '" target="_top">' + escapeHtml(p.title) + '</a></td>' +
      '<td class="muted">' + formatDate(p.hiddenAt) + '</td></tr>'
    ).join('');
    box.innerHTML = '<table><thead><tr><th>Product</th><th>Hidden since</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  async function init() {
    try {
      const settings = await api('/api/settings');
      const toggle = $('autoHideToggle');
      toggle.checked = settings.autoHideEnabled;
      toggle.disabled = false;
      renderStatus(settings.autoHideEnabled);

      toggle.addEventListener('change', async () => {
        toggle.disabled = true;
        try {
          const result = await api('/api/settings', {
            method: 'POST',
            body: JSON.stringify({ autoHideEnabled: toggle.checked }),
          });
          renderStatus(result.autoHideEnabled);
          toast(result.autoHideEnabled ? 'Auto-hide enabled' : 'Auto-hide paused');
        } catch (err) {
          toggle.checked = !toggle.checked;
          toast('Could not save — try again');
        } finally {
          toggle.disabled = false;
        }
      });

      const data = await api('/api/hidden-products');
      renderProducts(data.products);
    } catch (err) {
      toast('Failed to load. Refresh the page.');
    }
  }

  init();
})();
</script>
</body>
</html>`;
}

export default router;
