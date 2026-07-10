// billing.js — подписка $6.99/мес с 7-дневным триалом через Billing API
import { shopifyGraphql } from './graphql.js';

const PLAN_NAME = 'Auto-Hide Sold Out';
const PLAN_PRICE = 6.99;
const TRIAL_DAYS = 14;

// По умолчанию подписки ТЕСТОВЫЕ (без реальных денег). Реальный биллинг
// включается только явным BILLING_TEST=false на Railway перед сабмитом.
const IS_TEST = process.env.BILLING_TEST !== 'false';

const ACTIVE_SUBSCRIPTIONS_QUERY = `
  query ActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
      }
    }
  }
`;

const SUBSCRIPTION_CREATE_MUTATION = `
  mutation CreateSubscription(
    $name: String!
    $returnUrl: URL!
    $test: Boolean
    $trialDays: Int
    $lineItems: [AppSubscriptionLineItemInput!]!
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      test: $test
      trialDays: $trialDays
      lineItems: $lineItems
    ) {
      confirmationUrl
      appSubscription { id status }
      userErrors { field message }
    }
  }
`;

// Кэш статуса подписки: не дёргаем API на каждый батч вебхуков
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 часов
const subscriptionCache = new Map(); // shop → { active, checkedAt }

export function invalidateSubscriptionCache(shop) {
  subscriptionCache.delete(shop);
}

/**
 * Есть ли у магазина активная подписка (с кэшем на 6 часов).
 */
export async function hasActiveSubscription(shop, accessToken) {
  const cached = subscriptionCache.get(shop);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.active;
  }

  const data = await shopifyGraphql(shop, accessToken, ACTIVE_SUBSCRIPTIONS_QUERY);
  const subs = data?.currentAppInstallation?.activeSubscriptions || [];
  const active = subs.some((s) => s.status === 'ACTIVE');

  subscriptionCache.set(shop, { active, checkedAt: Date.now() });
  return active;
}

/**
 * Создаёт подписку и возвращает confirmationUrl — страницу Shopify,
 * где мерчант подтверждает оплату. После подтверждения Shopify
 * вернёт его на returnUrl.
 */
export async function createSubscription(shop, accessToken) {
  const data = await shopifyGraphql(shop, accessToken, SUBSCRIPTION_CREATE_MUTATION, {
    name: PLAN_NAME,
    returnUrl: `https://${shop}/admin/apps`,
    test: IS_TEST,
    trialDays: TRIAL_DAYS,
    lineItems: [
      {
        plan: {
          appRecurringPricingDetails: {
            price: { amount: PLAN_PRICE, currencyCode: 'USD' },
            interval: 'EVERY_30_DAYS',
          },
        },
      },
    ],
  });

  const result = data?.appSubscriptionCreate;
  const errors = result?.userErrors || [];
  if (errors.length > 0) {
    throw new Error(`appSubscriptionCreate: ${errors.map((e) => e.message).join('; ')}`);
  }
  if (!result?.confirmationUrl) {
    throw new Error('appSubscriptionCreate не вернул confirmationUrl');
  }

  invalidateSubscriptionCache(shop);
  return result.confirmationUrl;
}
