import { randomUUID } from 'node:crypto';

export function parsePrice(text) {
  const value = String(text ?? '').trim().replace(/^[¥￥]\s*/, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function validateManifest(manifest) {
  if (manifest?.schema !== 'local-products-v1' || manifest.sample_only !== true) throw new Error('只支持 local-products-v1 本地样例');
  if (!Number.isInteger(manifest.max_items_per_shop) || manifest.max_items_per_shop < 1 || manifest.max_items_per_shop > 3000) throw new Error('单店演示上限必须为 1–3000');
  if (!Array.isArray(manifest.shops) || !manifest.shops.length || manifest.shops.length > 10) throw new Error('店铺数量必须为 1–10');
  const ids = new Set();
  for (const shop of manifest.shops) {
    if (!/^[a-z0-9-]{1,40}$/.test(shop.id) || ids.has(shop.id) || typeof shop.name !== 'string' || !shop.name.trim()) throw new Error('店铺 ID 或名称不合法');
    if (!/^\/fixtures\/[a-z0-9-]+\.html$/.test(shop.path)) throw new Error('禁止远程或任意文件来源；只接受本地 fixture HTML');
    ids.add(shop.id);
  }
  const r = manifest.rules;
  if (!r || !Number.isSafeInteger(r.min_price_cents) || !Number.isSafeInteger(r.max_price_cents) || r.min_price_cents < 0 || r.max_price_cents < r.min_price_cents) throw new Error('筛选价格范围不合法');
  for (const key of ['categories', 'excluded_terms']) {
    if (!Array.isArray(r[key]) || !r[key].length || r[key].some(x => typeof x !== 'string' || !x.trim())) throw new Error('筛选规则必须提供非空文本列表');
  }
  return manifest;
}

export function aggregate(rows, manifest, pageReceipts = []) {
  validateManifest(manifest);
  const invalid = [], map = new Map();
  const shopCounts = Object.fromEntries(manifest.shops.map(s => [s.id, 0]));
  let duplicates = 0;
  for (const row of rows) {
    if (!Object.hasOwn(shopCounts, row.shop_id)) throw new Error('出现未登记店铺');
    if (++shopCounts[row.shop_id] > manifest.max_items_per_shop) throw new Error('超过单店演示上限，结果未提交');
    const title = String(row.title ?? '').trim(), category = String(row.category ?? '').trim();
    const price_cents = parsePrice(row.price);
    const errors = [];
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(row.item_id ?? '')) errors.push('商品 ID 缺失或格式不合法');
    if (!title) errors.push('标题缺失');
    if (price_cents === null) errors.push('价格无法解析为精确金额');
    if (!category) errors.push('类别缺失');
    if (errors.length) { invalid.push({ ...row, errors }); continue; }
    const occurrence = { shop_id: row.shop_id, shop_name: row.shop_name, source_url: row.source_url, row_index: row.row_index, raw: { title, price: row.price, category } };
    const previous = map.get(row.item_id);
    if (previous) {
      duplicates++;
      previous.occurrences.push(occurrence);
      if (!previous.shops.includes(row.shop_id)) previous.shops.push(row.shop_id);
      if (previous.title !== title || previous.price_cents !== price_cents || previous.category !== category) previous.conflict = true;
    } else {
      map.set(row.item_id, { item_id: row.item_id, title, price_cents, currency: 'CNY', category, shops: [row.shop_id], occurrences: [occurrence], conflict: false });
    }
  }
  const items = [...map.values()].map(item => {
    const reasons = [], r = manifest.rules;
    if (item.price_cents < r.min_price_cents || item.price_cents > r.max_price_cents) reasons.push('价格超出演示筛选范围');
    if (!r.categories.includes(item.category)) reasons.push('类别不在演示筛选范围');
    for (const term of r.excluded_terms) if (item.title.includes(term)) reasons.push(`标题包含「${term}」`);
    if (item.conflict) reasons.push('同 ID 内容冲突，需人工核对所有来源');
    const review_status = item.conflict ? 'conflict' : reasons.length ? 'excluded' : 'candidate';
    return { ...item, review_status, reasons: reasons.length ? reasons : ['满足演示规则，仍需人工核验授权、质量与履约'] };
  });
  const summary = { shops: manifest.shops.length, input_rows: rows.length, invalid_rows: invalid.length, valid_rows: rows.length - invalid.length, duplicate_rows: duplicates, unique_items: items.length, candidates: items.filter(i => i.review_status === 'candidate').length, excluded: items.filter(i => i.review_status === 'excluded').length, conflicts: items.filter(i => i.review_status === 'conflict').length };
  return { schema: 'local-collection-result-v1', run_id: randomUUID(), captured_at: new Date().toISOString(), sample_only: true, scope: '本地虚构样例，非闲鱼实采，非收益或合格率证明', summary, rules: manifest.rules, shop_counts: shopCounts, pages: pageReceipts, items, invalid };
}

export function csvCell(value) {
  let text = String(value ?? '');
  // 防止 Excel/WPS 将不可信文本作为公式执行，包括前置空白的公式。
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function toCsv(result) {
  const headers = ['sample_only', 'item_id', 'title', 'price_cny', 'category', 'shop_ids', 'review_status', 'reasons', 'source_urls', 'run_id'];
  const lines = result.items.map(i => [true, i.item_id, i.title, (i.price_cents / 100).toFixed(2), i.category, i.shops.join('|'), i.review_status, i.reasons.join('；'), i.occurrences.map(o => o.source_url).join('|'), result.run_id]);
  return '\uFEFF' + [headers, ...lines].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
