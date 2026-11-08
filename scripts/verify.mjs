import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';
import { projectRoot } from '../src/storage.mjs';

const evidence = process.env.SCREENSHOT_DIR || path.join(projectRoot, 'work/verification');
await mkdir(evidence, { recursive: true });
const ownServer = !process.env.MVP_VERIFY_URL;
const started = ownServer ? await startServer(0) : null;
const origin = started?.origin || process.env.MVP_VERIFY_URL;
const browser = await chromium.launch({ headless: true, args: ['--window-size=1440,1000'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const errors = [], expectedErrors = [], checks = [];
let injectingFailure = false;
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() !== 'error') return;
  if (injectingFailure && message.location().url === origin + '/api/collect' && message.text().includes('422')) expectedErrors.push(message.text());
  else errors.push(message.text());
});
const pass = name => checks.push({ name, passed: true });
try {
  // 首屏与初始空状态通过请求替身隔离已有历史，不修改原始样例或结果。
  await page.route('**/api/result', route => route.fulfill({ json: { result: null } }));
  await page.goto(origin);
  await page.getByRole('heading', { name: '把商品列表，整理成可检查的结果。' }).waitFor();
  await page.getByRole('heading', { name: '先采集，再逐项复核。' }).waitFor();
  assert.equal(await page.locator('#export-csv').getAttribute('aria-disabled'), 'true');
  pass('首屏与空状态：脚本成功执行，导出尚未启用');
  await page.locator('#collect').click();
  await page.getByText('本次完成：14 行 → 10 件有效去重商品；2 条异常已隔离。', { exact: true }).waitFor();
  assert.equal(await page.locator('#items tr').count(), 10);
  assert.equal(await page.locator('#metric-candidate').textContent(), '5');
  pass('真实采集：2店14行，2异常，2重复，10唯一，5待复核');
  await page.screenshot({ path: path.join(evidence, 'desktop.png'), fullPage: false });
  await page.locator('[data-shop="demo-b"]').click();
  assert.equal(await page.locator('#items tr').count(), 6);
  await page.locator('#state').selectOption('candidate');
  assert.equal(await page.locator('#items tr').count(), 4);
  await page.locator('#search').fill('周计划');
  assert.equal(await page.locator('#items tr').count(), 1);
  await page.getByRole('button', { name: '查看来源：周计划手账模板', exact: true }).click();
  assert.equal(await page.locator('#detail').evaluate(el => el.open), true);
  assert.equal(await page.locator('#detail-sources li').count(), 1);
  const [popup] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: '打开本机原始行', exact: true }).click()]);
  await popup.waitForLoadState('load');
  assert.ok(popup.url().endsWith('/fixtures/shop-b.html#row-4'));
  assert.equal(await popup.locator('#row-4 [data-title]').textContent(), '周计划手账模板');
  await popup.close();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#detail').evaluate(el => el.open), false);
  assert.equal(await page.locator('button[data-id="demo-009"]').evaluate(el => el === document.activeElement), true);
  pass('店铺/状态/搜索组合筛选，来源原行弹窗，Esc关闭与焦点恢复');
  await page.locator('#search').fill('没有这样的商品');
  await page.getByRole('heading', { name: '没有匹配的商品。' }).waitFor();
  pass('无匹配搜索显示可恢复空状态');
  for (const format of ['json', 'csv']) {
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator(`#export-${format}`).click()]);
    const filename = path.join(evidence, `download.${format}`);
    await download.saveAs(filename);
    const data = await readFile(filename, 'utf8');
    if (format === 'json') {
      const result = JSON.parse(data); assert.equal(result.items.length, 10); assert.equal(result.sample_only, true);
    } else { assert.equal(data.trim().split('\r\n').length, 11); assert.ok(data.includes('"39.00"')); }
  }
  pass('CSV/JSON下载：始终导出本批全部10件，未被当前零匹配过滤截断');
  await page.locator('#search').fill('');
  await page.locator('[data-shop="all"]').click();
  await page.locator('#state').selectOption('all');
  await page.locator('#invalid-summary').click();
  assert.equal(await page.locator('#invalid-list li').count(), 2);
  pass('异常详情显示2条，未混入有效商品');
  // 明确的故障注入，只模拟浏览器收到失败响应，不接触平台或原始文件。
  injectingFailure = true;
  await page.route('**/api/collect', route => route.fulfill({ status: 422, json: { error: '演示故障注入', previous_result_preserved: true } }));
  await page.locator('#collect').click();
  await page.locator('#status.error').waitFor();
  assert.equal(await page.locator('#items tr').count(), 0);
  assert.equal(await page.locator('#export-csv').getAttribute('aria-disabled'), 'true');
  assert.equal(expectedErrors.length, 1, '只有故障注入对应的422资源错误是预期错误');
  pass('模拟失败：不把旧结果冒充本次成功，导出禁用且可重试');
  injectingFailure = false;
  await page.unroute('**/api/collect');
  await page.locator('#collect').click();
  await page.getByText('本次完成：14 行 → 10 件有效去重商品；2 条异常已隔离。', { exact: true }).waitFor();
  pass('失败后重新执行真实采集恢复成功');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.rules summary').click();
  assert.equal(await page.locator('.rules').evaluate(el => el.open), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.ok(await page.locator('#state').evaluate(el => el.getBoundingClientRect().width) >= 120);
  await page.locator('.rules summary').click();
  // 商品表在自身容器滚动；移动端复核按钮可达。
  await page.locator('.table-scroll').evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await page.locator('button[data-id="demo-001"]').click();
  assert.equal(await page.locator('#detail').evaluate(el => el.open), true);
  assert.equal(await page.locator('#detail-sources li').count(), 2);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.table-scroll').evaluate(el => { el.scrollLeft = 0; });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(evidence, 'mobile.png'), fullPage: false });
  pass('390×844手机：规则可展开、表格独立滚动、来源详情可操作、页面无横向溢出');
  assert.deepEqual(errors, []);
  pass('桌面/手机无非预期脚本或控制台错误，减少动效模式可运行；故障注入422单列');
  const report = { checked_at: new Date().toISOString(), origin, browser: browser.version(), viewports: ['1440x1000', '390x844'], browser_route: 'Browser/control-chrome skill not listed; user explicitly allowed standalone Playwright', checks, errors, expected_errors_from_injection: expectedErrors, screenshots: ['desktop.png', 'mobile.png'], limitations: ['手机为Chrome视口模拟，非真机', '无真实闲鱼实采或平台能力验证', '错误状态为明确的本机响应故障注入'] };
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: checks.length, errors, evidence }, null, 2));
} finally {
  await browser.close();
  if (started) await new Promise(resolve => started.server.close(resolve));
}
