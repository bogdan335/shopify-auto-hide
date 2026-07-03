// shopify.js — единая точка конфигурации Shopify API
import '@shopify/shopify-api/adapters/node';
import { shopifyApi } from '@shopify/shopify-api';

export const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_products', 'write_products', 'read_inventory'],
  hostName: process.env.HOST_NAME,
  apiVersion: '2026-07',
  isEmbeddedApp: false,
});