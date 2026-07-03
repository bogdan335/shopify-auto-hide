// graphql.js — прямые GraphQL-запросы к Shopify Admin API через нативный fetch
const API_VERSION = '2026-07';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function shopifyGraphql(shop, accessToken, query, variables = {}, maxAttempts = 5) {
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const resp = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': accessToken,
                },
                body: JSON.stringify({ query, variables }),
            });

            if (resp.status === 429) {
                throw Object.assign(new Error('Throttled'), { retryable: true });
            }

            const json = await resp.json();
            
            if (json.errors && json.errors.some(e => e.message === 'Throttled')) {
                throw Object.assign(new Error('Throttled'), { retryable: true });
            }

            return json.data;
        } catch (err) {
            lastErr = err;
            if (err.retryable && attempt < maxAttempts) {
                await sleep(attempt * 500);
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}