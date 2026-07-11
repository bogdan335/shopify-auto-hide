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
// Privacy policy (обязательна для листинга в App Store)
// ---------------------------------------------------------------------------
router.get('/privacy', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — Auto-Hide Sold Out</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 680px; margin: 0 auto; padding: 40px 20px; color: #303030; line-height: 1.65; }
  h1 { font-size: 26px; margin-bottom: 4px; }
  h2 { font-size: 17px; margin: 28px 0 8px; }
  .updated { color: #616161; font-size: 13px; margin-bottom: 24px; }
  ul { padding-left: 20px; }
  a { color: #005bd3; }
</style>
</head>
<body>
<h1>Privacy Policy</h1>
<p class="updated">Auto-Hide Sold Out · Last updated: July 10, 2026</p>

<p>Auto-Hide Sold Out ("the App") automatically hides sold-out products in your
Shopify store and republishes them when restocked. We built the App to collect
as little data as possible.</p>

<h2>What we store</h2>
<ul>
  <li><strong>Your store's myshopify.com domain</strong> — to know which store the App is installed on.</li>
  <li><strong>API access tokens</strong> — to update product statuses on your behalf. Tokens are short-lived and refreshed automatically.</li>
  <li><strong>IDs of products the App has hidden</strong> — so we only republish products that the App itself hid, never drafts you created manually.</li>
  <li><strong>Your App settings</strong> — currently a single on/off preference.</li>
</ul>

<h2>What we never collect</h2>
<ul>
  <li>No customer data of any kind: no names, emails, addresses, orders, or payment details.</li>
  <li>No analytics, tracking pixels, or advertising identifiers.</li>
  <li>No staff account information.</li>
</ul>

<h2>Data deletion</h2>
<p>When you uninstall the App, all data associated with your store — domain,
tokens, settings, and the hidden-products list — is deleted automatically.
We also honor Shopify's mandatory GDPR webhooks
(<em>customers/data_request</em>, <em>customers/redact</em>, <em>shop/redact</em>);
since we store no customer data, there is nothing to disclose or redact.</p>

<h2>Data sharing</h2>
<p>We do not sell, rent, or share any data with third parties. Data is stored
with our hosting provider (Railway) in a private database and is used solely
to provide the App's functionality.</p>

<h2>Billing</h2>
<p>Subscription payments are processed entirely by Shopify's Billing API.
We never see or store your payment information.</p>

<h2>Contact</h2>
<p>Questions about this policy or your data:
<a href="mailto:balatnikowbogdan@gmail.com">balatnikowbogdan@gmail.com</a>.
We usually reply within one business day.</p>
</body>
</html>`);
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

  // Магазин не установлен или токен уже не спасти (например, пропущен
  // вебхук удаления) → на OAuth (выпрыгиваем из iframe наверх)
  const record = await getShop(shop);
  const accessToken = record ? await getFreshAccessToken(shop) : null;
  if (!record || !accessToken) {
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
  .page { max-width: 720px; margin: 0 auto; padding: 32px 16px 48px; }
  .header { display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 22px; font-weight: 700; letter-spacing: -.2px; }
  .section { padding: 20px 0; }
  .section + .section { border-top: 1px solid var(--border); }
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
  .switch input:checked + .slider { background: #34C759; }
  .switch input:checked + .slider:before { transform: translateX(18px); }
  .switch input:disabled + .slider { opacity: .5; }
  /* Статистика */
  .stat { font-size: 28px; font-weight: 700; letter-spacing: -.5px; }
  /* Таблица */
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 600; color: #8a8a8a; padding: 8px 8px; border-bottom: 1px solid var(--border); font-size: 12px; text-transform: uppercase; letter-spacing: .4px; }
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
  <div class="card" style="padding: 6px 28px;">
    <div class="section header">
      <h1>Auto-Hide Sold Out</h1>
      <span class="badge on" id="statusBadge" hidden><span class="dot"></span><span id="statusText">Active</span></span>
    </div>

    <div class="section">
      <div class="row">
        <h2>Automatically hide sold-out products</h2>
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

    <div class="section">
      <h2>Currently hidden by the app</h2>
      <div class="stat" id="hiddenCount"><div class="skeleton" style="width:40px;height:28px"></div></div>
    </div>

    <div class="section">
      <div id="productList"><div class="skeleton" style="width:100%"></div></div>
    </div>
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

      // Оптимистичное сохранение: UI переключается мгновенно,
      // запрос уходит в фоне; при ошибке откатываемся.
      let saveSeq = 0;
      toggle.addEventListener('change', () => {
        const desired = toggle.checked;
        const seq = ++saveSeq;
        renderStatus(desired);
        toast(desired ? 'Auto-hide enabled' : 'Auto-hide paused');
        api('/api/settings', {
          method: 'POST',
          body: JSON.stringify({ autoHideEnabled: desired }),
        }).catch(() => {
          if (seq !== saveSeq) return; // уже переключили ещё раз
          toggle.checked = !desired;
          renderStatus(!desired);
          toast('Could not save — try again');
        });
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
