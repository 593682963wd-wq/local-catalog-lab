import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { aggregate, csvCell, parsePrice, toCsv, validateManifest } from '../src/pipeline.mjs';
import { collect, localOrigin } from '../src/collector.mjs';
import { startServer } from '../src/server.mjs';

const manifest = JSON.parse(await readFile(new URL('../fixtures/manifest.json', import.meta.url)));
const row = (overrides = {}) => ({ item_id: 'test-1', title: '原创模板', price: '19.90', category: '办公素材', shop_id: 'demo-a', shop_name: 'A', row_index: 1, source_url: 'http://127.0.0.1:1234/fixtures/shop-a.html#row-1', ...overrides });

test('金额使用分，面议、负数、指数和模糊小数不能成为有效价格', () => {
  assert.equal(parsePrice('￥ 19.90'), 1990);
  assert.equal(parsePrice('0.01'), 1);
  for (const p of ['面议', '-2', '1e3', '1.234', '', 'NaN']) assert.equal(parsePrice(p), null);
});

test('跨店去重保留所有来源；原始、异常、重复与唯一商品可对账', () => {
  const result = aggregate([row(), row({ shop_id: 'demo-b', row_index: 2 }), row({ item_id: 'bad', price: '面议' })], manifest);
  assert.deepEqual(result.summary, { shops: 2, input_rows: 3, invalid_rows: 1, valid_rows: 2, duplicate_rows: 1, unique_items: 1, candidates: 1, excluded: 0, conflicts: 0 });
  assert.deepEqual(result.items[0].shops, ['demo-a', 'demo-b']);
  assert.equal(result.items[0].occurrences.length, 2);
  assert.equal(result.sample_only, true);
});

test('同 ID 不同金额强制转人工冲突，不能静默覆盖为候选', () => {
  const result = aggregate([row(), row({ shop_id: 'demo-b', price: '25.00' })], manifest);
  assert.equal(result.items[0].review_status, 'conflict');
  assert.equal(result.summary.candidates, 0);
  assert.equal(result.items[0].occurrences[1].raw.price, '25.00');
});

test('筛选边界包含端点；排除词、类别和缺失标题分开处理', () => {
  const result = aggregate([
    row({ item_id: 'low', price: '10.00' }), row({ item_id: 'high', price: '100.00' }),
    row({ item_id: 'below', price: '9.99' }), row({ item_id: 'word', title: '缺货模板' }),
    row({ item_id: 'category', category: '家居' }), row({ item_id: 'empty', title: '' })
  ], manifest);
  assert.equal(result.summary.candidates, 2);
  assert.equal(result.summary.excluded, 3);
  assert.equal(result.summary.invalid_rows, 1);
});

test('来源和单店上限失败时拒绝整批结果，不截断数据', () => {
  for (const source of ['https://www.goofish.com/shop', '/fixtures/../secret.html', 'file:///etc/passwd']) {
    const bad = structuredClone(manifest); bad.shops[0].path = source;
    assert.throws(() => validateManifest(bad), /禁止远程/);
  }
  const limited = structuredClone(manifest); limited.max_items_per_shop = 1;
  assert.throws(() => aggregate([row(), row({ item_id: 'test-2' })], limited), /超过单店/);
  for (const url of ['https://127.0.0.1:8897', 'http://localhost:8897', 'http://127.0.0.1:8897/path', 'http://127.0.0.1:8897/?x=1']) assert.throws(() => localOrigin(url));
});

test('CSV 可保留引号换行，公式文本被转为普通文本', () => {
  const result = aggregate([row({ title: '  =HYPERLINK("x")\n演示' })], manifest);
  const csv = toCsv(result);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")\n演示"'));
  assert.equal(csvCell('  =1+1'), '"\'  =1+1"');
  assert.ok(csv.includes('"19.90"'));
});

test('本机 API 拒绝跨源写、任意参数、超长请求、非法导出路径', async () => {
  const { server, origin } = await startServer(0);
  try {
    const post = (body, headers = {}) => fetch(origin + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body });
    assert.equal((await post('{}', { origin: 'https://example.invalid' })).status, 403);
    assert.equal((await post('{"url":"https://example.invalid"}')).status, 400);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post(' '.repeat(1100))).status, 413);
    assert.equal((await fetch(origin + '/exports/items.csv?run=../../secret')).status, 400);
    const wrongHostStatus = await new Promise((resolve, reject) => {
      http.get(origin + '/healthz', { headers: { host: 'evil.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(wrongHostStatus, 403);
    assert.equal((await fetch(origin + '/.git/config')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('浏览器拒绝结构变化、超限、跨源资源和跨源跳转；无外部读取', async t => {
  let html = '', redirect = '', externalHits = 0;
  const trap = http.createServer((req, res) => { externalHits++; res.end('unexpected'); });
  trap.listen(0, '127.0.0.1'); await once(trap, 'listening');
  const external = `http://127.0.0.1:${trap.address().port}`;
  const server = http.createServer((req, res) => {
    if (redirect) { res.writeHead(302, { location: redirect }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const one = structuredClone(manifest); one.shops = [one.shops[0]]; one.max_items_per_shop = 1;
  const product = '<li data-product data-item-id="x"><span data-title>模板</span><span data-price>10</span><span data-category>办公素材</span></li>';
  const list = content => `<ol data-product-list data-schema="local-products-v1">${content}</ol>`;
  try {
    await t.test('结构失配', async () => { html = '<p>登录页或结构已变化</p>'; await assert.rejects(collect(origin, one), /结构不匹配/); });
    await t.test('超出上限', async () => { html = list(product + product); await assert.rejects(collect(origin, one), /超过单店上限/); });
    await t.test('跨源样式请求', async () => { html = `<link rel="stylesheet" href="${external}/style.css">` + list(product); await assert.rejects(collect(origin, one), /非本机资源/); });
    await t.test('跨源跳转', async () => { redirect = external + '/login'; await assert.rejects(collect(origin, one)); });
    assert.equal(externalHits, 0, '网络拦截必须发生在请求发出前');
  } finally {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => trap.close(resolve))]);
  }
});
