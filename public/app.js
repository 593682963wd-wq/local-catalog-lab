const $ = id => document.getElementById(id);
let result = null, selectedShop = 'all';
// 后发起的采集优先，迟到的初始化快照不能覆盖新结果。
let resultGeneration = 0;
const labels = { candidate: '待人工复核', excluded: '规则排除', conflict: '内容冲突' };
const element = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };

function setStatus(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function exportState() {
  for (const format of ['csv', 'json']) {
    const link = $(`export-${format}`);
    link.classList.toggle('disabled', !result);
    link.setAttribute('aria-disabled', String(!result));
    if (result) link.href = `/exports/items.${format}?run=${encodeURIComponent(result.run_id)}`;
    else link.removeAttribute('href');
  }
}
function render() {
  exportState();
  for (const [id, key] of [['input','input_rows'],['unique','unique_items'],['candidate','candidates'],['duplicate','duplicate_rows']]) $(`metric-${id}`).textContent = result?.summary[key] ?? '—';
  $('count-all').textContent = result?.summary.input_rows ?? '—';
  for (const shop of ['demo-a','demo-b']) $(`count-${shop}`).textContent = result?.shop_counts[shop] ?? '—';
  $('run-time').textContent = result ? `最近运行 ${new Date(result.captured_at).toLocaleString('zh-CN', { hour12: false })}` : '尚未运行';
  const query = $('search').value.trim().toLowerCase(), state = $('state').value;
  const filtered = (result?.items || []).filter(i => (selectedShop === 'all' || i.shops.includes(selectedShop)) && (state === 'all' || state === i.review_status) && (!query || `${i.title} ${i.item_id}`.toLowerCase().includes(query)));
  $('visible-count').textContent = `${filtered.length} 件商品`;
  $('items').replaceChildren();
  for (const item of filtered) {
    const row = element('tr'), title = element('td');
    title.append(element('span', item.title, 'item-title'), element('span', item.item_id, 'item-id'));
    const price = element('td', `¥${(item.price_cents / 100).toFixed(2)}`, 'price');
    const shops = element('td', item.shops.map(s => s === 'demo-a' ? 'A' : 'B').join(' · ') + ` / ${item.occurrences.length} 处`, 'shop-names');
    const status = element('td'); status.append(element('span', labels[item.review_status], `badge ${item.review_status}`));
    const action = element('td'), button = element('button', '查看', 'detail-button');
    button.type = 'button'; button.dataset.id = item.item_id; button.setAttribute('aria-label', `查看来源：${item.title}`); action.append(button);
    row.append(title, price, shops, status, action); $('items').append(row);
  }
  $('empty').hidden = filtered.length > 0;
  $('empty').querySelector('h3').textContent = result ? '没有匹配的商品。' : '先采集，再逐项复核。';
  $('empty').querySelector('p').textContent = result ? '试试清空搜索，或切换店铺与筛选状态。' : '运行本地演示，结果会出现在这里。';
  $('invalids').hidden = !result?.invalid.length;
  $('invalid-summary').textContent = `查看 ${result?.invalid.length || 0} 条异常记录（未计入有效商品）`;
  $('invalid-list').replaceChildren(...(result?.invalid || []).map(i => element('li', `${i.shop_name} · 第 ${i.row_index} 行 · ${i.item_id || '无 ID'}：${i.errors.join('；')}`)));
  $('result-foot').textContent = result ? `本次规则排除 ${result.summary.excluded} 件，内容冲突 ${result.summary.conflicts} 件。所有金额、商品和店铺均为虚构样例；待复核不代表商品合格或收益。` : '所有金额、商品和店铺均为虚构演示数据。';
}

async function run() {
  ++resultGeneration;
  $('collect').disabled = true;
  $('collect').textContent = '正在采集本地样例…';
  result = null; render();
  setStatus('正在依次读取两家本地店铺，并检查字段与重复记录…');
  try {
    const response = await fetch('/api/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json();
    if (!response.ok || !data.result) throw new Error(data.error || '本地服务未返回有效结果');
    result = data.result;
    setStatus(`本次完成：${result.summary.input_rows} 行 → ${result.summary.unique_items} 件有效去重商品；${result.summary.invalid_rows} 条异常已隔离。`);
  } catch (e) { setStatus(`本次采集失败：${e.message}。请修复后重新运行；历史文件仍保留。`, true); }
  finally { $('collect').disabled = false; $('collect').textContent = '重新运行演示 ↗'; render(); }
}

$('collect').addEventListener('click', run);
$('search').addEventListener('input', render);
$('state').addEventListener('change', render);
document.querySelectorAll('[data-shop]').forEach(button => {
  button.setAttribute('aria-pressed', button.dataset.shop === 'all' ? 'true' : 'false');
  button.addEventListener('click', () => {
    selectedShop = button.dataset.shop;
    document.querySelectorAll('[data-shop]').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
    render();
  });
});
$('items').addEventListener('click', event => {
  const button = event.target.closest('button[data-id]');
  if (!button || !result) return;
  const item = result.items.find(i => i.item_id === button.dataset.id);
  $('detail-title').textContent = item.title;
  $('detail-meta').textContent = `${item.item_id} · 样例价格 ¥${(item.price_cents / 100).toFixed(2)} · ${item.category}`;
  $('detail-reasons').replaceChildren(...item.reasons.map(text => element('li', text)));
  $('detail-sources').replaceChildren(...item.occurrences.map(o => {
    const li = element('li', `${o.shop_name} · 第 ${o.row_index} 行 `);
    const url = new URL(o.source_url);
    if (url.origin === location.origin && /^\/fixtures\/[a-z0-9-]+\.html$/.test(url.pathname)) {
      const a = element('a', '打开本机原始行'); a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; li.append(a);
    } else li.append(element('span', '（此来源来自其他本机运行端口，请按原运行地址启动后查看）'));
    li.append(element('span', `原始字段：${o.raw.title} / ${o.raw.price} / ${o.raw.category}`, 'raw'));
    return li;
  }));
  $('detail').showModal();
});
$('close-detail').addEventListener('click', () => $('detail').close());

const initialGeneration = resultGeneration;
try {
  const response = await fetch('/api/result');
  if (!response.ok) throw new Error('本地结果读取失败');
  const data = await response.json();
  if (initialGeneration === resultGeneration) {
    result = data.result;
    if (result) setStatus('已载入上次完成的样例结果。可重新运行，再查看本次输出。');
  }
} catch (e) {
  if (initialGeneration === resultGeneration) setStatus(`${e.message}。可尝试运行演示重新生成。`, true);
}
render();
