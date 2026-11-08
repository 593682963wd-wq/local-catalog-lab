import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from './collector.mjs';
import { validateManifest } from './pipeline.mjs';
import { projectRoot, outputsRoot, saveResult, latestResult, validRunId } from './storage.mjs';

export async function startServer(port = Number(process.env.PORT || process.env.MVP_PORT || 8897)) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('MVP_PORT 不合法');
  const host = process.env.HOST || '127.0.0.1';
  // 采集器固定访问回环，指定单网卡地址会产生“页面可开、采集失败”的半可用服务。
  if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(host)) throw new Error('HOST 仅支持 127.0.0.1、localhost 或 0.0.0.0，以确保本地采集入口可达');
  let busy = false, origin, collectionOrigin;
  const files = new Map([
    ['/', ['public/index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
    ['/fixture.css', ['public/fixture.css', 'text/css; charset=utf-8']],
    ['/fixtures/shop-a.html', ['fixtures/shop-a.html', 'text/html; charset=utf-8']],
    ['/fixtures/shop-b.html', ['fixtures/shop-b.html', 'text/html; charset=utf-8']]
  ]);
  const server = http.createServer(async (req, res) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
    try {
      if (![new URL(origin).host, new URL(collectionOrigin).host].includes(req.headers.host)) return send(403, { error: 'Host 不匹配' });
      const url = new URL(req.url, origin);
      if (url.origin !== origin) return send(403, { error: '拒绝跨源请求' });
      if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true, scope: 'local-fixture-only', busy });
      if (req.method === 'GET' && url.pathname === '/api/result') return send(200, { result: await latestResult() });
      if (req.method === 'POST' && url.pathname === '/api/collect') {
        if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: '采集只接受本机工作台同源 JSON 请求' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024) return send(413, { error: '请求过大' }); }
        let parsed;
        try { parsed = JSON.parse(body); } catch { return send(400, { error: 'JSON 格式错误' }); }
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.keys(parsed).length) return send(400, { error: '不接收远程 URL、脚本或自定义采集参数' });
        if (busy) return send(409, { error: '已有采集进行中，请稍后查看结果' });
        busy = true;
        try {
          const manifest = validateManifest(JSON.parse(await readFile(path.join(projectRoot, 'fixtures/manifest.json'), 'utf8')));
          const result = await saveResult(await collect(collectionOrigin, manifest));
          return send(200, { result });
        } catch (e) {
          console.error('Collection failed:', e.message);
          return send(422, { error: e.message, previous_result_preserved: true });
        } finally { busy = false; }
      }
      if (req.method === 'GET' && ['/exports/items.json', '/exports/items.csv'].includes(url.pathname)) {
        const id = url.searchParams.get('run');
        if (!validRunId(id)) return send(400, { error: '缺少有效运行 ID' });
        const name = url.pathname.endsWith('.csv') ? 'items.csv' : 'items.json';
        const data = await readFile(path.join(outputsRoot, 'runs', id, name));
        res.setHeader('Content-Disposition', `attachment; filename="local-demo-${id}-${name}"`);
        return send(200, data, name.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/octet-stream');
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && files.has(url.pathname)) {
        const [filename, type] = files.get(url.pathname);
        return send(200, await readFile(path.join(projectRoot, filename)), type);
      }
      return send(404, { error: '未找到本地页面' });
    } catch (e) {
      return send(e.code === 'ENOENT' ? 404 : 500, { error: e.code === 'ENOENT' ? '本地文件或运行结果不存在' : '读取本地数据失败，请检查服务日志' });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host === 'localhost' ? '127.0.0.1' : host, resolve); });
  collectionOrigin = `http://127.0.0.1:${server.address().port}`;
  origin = process.env.PUBLIC_ORIGIN || collectionOrigin;
  if (new URL(origin).origin !== origin) { server.close(); throw new Error('PUBLIC_ORIGIN 必须是完整源地址，不带路径'); }
  return { server, origin };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, origin } = await startServer();
  console.log(`本地商品采集演示：${origin}（仅合成样例）`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
