import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { aggregate, validateManifest } from './pipeline.mjs';

export function localOrigin(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('采集服务必须为带端口的 http://127.0.0.1');
  return url.origin;
}

export async function collect(baseUrl, manifest) {
  const origin = localOrigin(baseUrl);
  validateManifest(manifest);
  const channel = process.env.MVP_BROWSER_CHANNEL || 'chromium';
  if (!['chrome', 'chromium'].includes(channel)) throw new Error('浏览器仅支持 chrome 或 chromium');
  const browser = await chromium.launch({ headless: true, ...(channel === 'chrome' ? { channel } : {}) });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
    let blocked = 0;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin || request.method() !== 'GET') { blocked++; return route.abort('blockedbyclient'); }
      // route.continue() 的自动重定向不保证再次经过路由拦截。
      // 先读取同源响应且禁止重定向，再交给浏览器解析 DOM。
      try {
        const response = await route.fetch({ maxRedirects: 0, timeout: 12000 });
        if (response.status() >= 300 && response.status() < 400) {
          blocked++;
          return route.abort('blockedbyclient');
        }
        return route.fulfill({ response });
      } catch {
        blocked++;
        return route.abort('failed');
      }
    });
    const rows = [], pages = [];
    const page = await context.newPage();
    for (const shop of manifest.shops) {
      const url = origin + shop.path;
      const response = await page.goto(url, { waitUntil: 'load', timeout: 12000 });
      if (!response?.ok() || page.url() !== url) throw new Error(`${shop.name} 页面失败或发生跳转，未提交结果`);
      if (await page.locator('[data-product-list][data-schema="local-products-v1"]').count() !== 1) throw new Error(`${shop.name} 页面结构不匹配；停止，不猜测真实平台选择器`);
      const extracted = await page.locator('[data-product-list] [data-product]').evaluateAll(elements => elements.map((el, index) => ({ item_id: el.getAttribute('data-item-id'), title: el.querySelector('[data-title]')?.textContent, price: el.querySelector('[data-price]')?.textContent, category: el.querySelector('[data-category]')?.textContent, row_index: index + 1 })));
      if (extracted.length > manifest.max_items_per_shop) throw new Error(`${shop.name} 超过单店上限，停止，不截断冒充完整`);
      if (blocked) throw new Error('页面请求了非本机资源，已拦截并停止采集');
      rows.push(...extracted.map(row => ({ ...row, shop_id: shop.id, shop_name: shop.name, source_url: `${url}#row-${row.row_index}` })));
      pages.push({ shop_id: shop.id, shop_name: shop.name, url, rows: extracted.length, http_status: response.status(), sha256: createHash('sha256').update(await response.body()).digest('hex') });
    }
    return aggregate(rows, manifest, pages);
  } finally { await browser.close(); }
}
