const basePath = location.pathname.startsWith('/thinbook') ? '/thinbook' : '';
const appFetch = (url, options) => fetch(basePath + url, options);
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  read(key, fallback) { try { return JSON.parse(localStorage.getItem(`thinbook:${key}`)) ?? fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(`thinbook:${key}`, JSON.stringify(value)); return true; } catch { toast('浏览器存储空间不足，本次内容仍可阅读与导出。'); return false; } },
};
const state = { books: [], categories: [], token: '', view: 'discover', category: '全部', query: '', limit: 24, online: [], onlineQuery: '', selected: null, minutes: 10, saved: store.read('saved', []), history: store.read('history', []), reading: null, running: false, abort: null, model: 'deepseek-flash', hasKey: false,  font: store.read('font', 18), searchSequence: 0 };
let pendingBook = false, generationId = 0;
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 3500); }
function showDialog(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); }
$$('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } }));
function isSaved(book) { return state.saved.some(b => b.id === book.id || b.title === book.title && b.author === book.author); }
function cover(book, extraClass = '') {
  return `<div class="cover style-${Math.abs(Number(book.color) || 0) % 8} ${extraClass}"><span class="cover-label">THINBOOK CLASSICS<br>阅读之间</span><strong class="cover-title">${escapeHTML(book.title)}</strong><span class="cover-author">${escapeHTML(book.author)}</span><span class="cover-mark">薄 书 · 精 选</span></div>`;
}
function currentBooks() {
  let rows = state.view === 'saved' ? state.saved : state.view === 'history' ? state.history.map(r => ({ ...r.book, cacheId: r.cacheId })) : state.books;
  if (state.onlineQuery === state.query && state.query) rows = [...rows, ...state.online.filter(b => !rows.some(local => local.title === b.title && local.author === b.author))];
  if (state.category !== '全部') rows = rows.filter(b => b.category === state.category);
  if (state.query && state.onlineQuery !== state.query) {
    const q = state.query.toLocaleLowerCase(); rows = rows.filter(b => `${b.title} ${b.author} ${(b.aliases || []).join(' ')}`.toLocaleLowerCase().includes(q));
  } else if (state.query) {
    const q = state.query.toLocaleLowerCase(); rows = rows.filter(b => b.category === '在线书库' || `${b.title} ${b.author} ${(b.aliases || []).join(' ')}`.toLocaleLowerCase().includes(q));
  }
  const seriesName = state.query.toLocaleLowerCase();
  const match = rows.flatMap(book => book.series || []).find(group => group.name.toLocaleLowerCase() === seriesName);
  if (match) rows = rows.filter(book => book.series?.some(group => group.id === match.id))
    .sort((a, b) => a.series.find(group => group.id === match.id).order - b.series.find(group => group.id === match.id).order);
  return rows;
}
function renderCategories() {
  $('#categories').innerHTML = ['全部', ...state.categories].map(c => `<button class="${state.category === c ? 'active' : ''}" data-category="${escapeHTML(c)}" aria-pressed="${state.category === c}">${c}</button>`).join('');
}
function render() {
  const rows = currentBooks();
  $('#book-total').textContent = `${rows.length} 本好书`;
  $('#catalog-count').textContent = state.books.length;
  $('#saved-count').textContent = state.saved.length;
  const titles = { discover: ['发现 / 为你精选', '值得翻开的世界', 'YOUR NEXT GREAT READ'], classics: ['书库 / 经典常读', '时间留下的好书', 'THE CLASSICS COLLECTION'], saved: ['书架 / 留给自己的书', '我的书架', 'A SHELF OF YOUR OWN'], history: ['阅读 / 已经走过的世界', '最近阅读', 'WORLDS YOU HAVE VISITED'] };
  $('#breadcrumb').textContent = titles[state.view][0];
  $('#shelf-title').innerHTML = `${titles[state.view][1]}<span>精选好书，慢慢读。</span>`;
  $('#shelf-eyebrow').textContent = titles[state.view][2];
  $('#hero').hidden = state.view !== 'discover';
  $('#continue-section').hidden = state.view !== 'discover' || !state.history.length;
  if (state.history.length) $('#continue-title').textContent = state.history[0].title;
  const shown = rows.slice(0, state.limit);
  $('#book-grid').innerHTML = shown.map((book, i) => `<div class="book-card" style="animation-delay:${Math.min(i, 9) * 20}ms"><button class="book-open" data-book-index="${i}" aria-label="阅读《${escapeHTML(book.title)}》">${cover(book)}<div class="book-info"><h3>${escapeHTML(book.title)}</h3><p>${escapeHTML(book.author)}</p><p class="book-description">${escapeHTML(book.description || '打开这本书，探索它的故事与思想。')}</p><span class="book-tag">${escapeHTML(book.category)}</span></div></button><button class="card-save ${isSaved(book) ? 'saved' : ''}" data-save-index="${i}" aria-label="${isSaved(book) ? '移出书架' : '加入书架'}：${escapeHTML(book.title)}" aria-pressed="${isSaved(book)}">${isSaved(book) ? '♥' : '♡'}</button></div>`).join('');
  $('#empty-state').hidden = rows.length > 0;
  $('#empty-message').textContent = state.view === 'saved' ? '将想读的书加入书架，下次从这里继续。' : state.view === 'history' ? '读完第一本薄书，这里就有了故事。' : '试试联网找书，或添加你想读的书。';
  $('#load-more').hidden = rows.length <= state.limit;
  $$('[data-book-index]').forEach(button => button.addEventListener('click', () => {
    const book = shown[Number(button.dataset.bookIndex)];
    if (state.view === 'history') { const reading = state.history.find(r => book.cacheId ? r.cacheId === book.cacheId : r.book.id === book.id); if (reading) openReading({ ...reading, cached: true, chargedThisRequest: false }); }
    else openBook(book);
  }));
  $$('[data-save-index]').forEach(button => button.addEventListener('click', () => toggleSave(shown[Number(button.dataset.saveIndex)])));
  $$('.nav-item[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === state.view); if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
}
function toggleSave(book) {
  if (isSaved(book)) state.saved = state.saved.filter(b => !(b.id === book.id || b.title === book.title && b.author === book.author));
  else { state.saved.unshift(book); toast('已放进你的书架'); }
  store.write('saved', state.saved); render(); if ($('#book-dialog').open) updateSaveButton();
}
function updateSaveButton() { $('#save-book').textContent = isSaved(state.selected) ? '✓ 已在书架' : '＋ 加入书架'; }
function openBook(book) {
  state.selected = book; state.minutes = 10;
  $('#detail-title').textContent = book.title; $('#detail-author').textContent = book.author;
  $('#detail-category').textContent = book.category; $('#detail-cover').innerHTML = cover(book);
  $('#detail-description').textContent = book.description || '自选书籍将在提炼时核对作者与内容。';
  const group = state.books.find(item => item.id === book.id)?.series?.[0] || book.series?.[0];
  let seriesButton = $('#detail-series');
  if (!seriesButton) { seriesButton = document.createElement('button'); seriesButton.id = 'detail-series'; seriesButton.type = 'button'; seriesButton.className = 'text-button series-link'; $('#detail-description').after(seriesButton); }
  seriesButton.hidden = !group;
  seriesButton.textContent = group ? `${group.name} · ${group.order} / ${group.total}${group.relation ? ` · ${group.relation}` : ''} ↗` : '';
  seriesButton.onclick = group ? () => {
    $('#book-dialog').close(); state.view = 'classics'; state.category = '全部'; state.query = group.name;
    state.online = []; state.onlineQuery = ''; state.searchSequence++; state.limit = 24;
    $('#search-input').value = group.name; $('#search-status').textContent = ''; renderCategories(); render();
    $('#library').scrollIntoView({ behavior: 'smooth' });
  } : null;
  $('#source-text').value = ''; $('#source-file').value = ''; $('#source-complete').checked = false;
  $$('#length-options button').forEach(b => b.classList.toggle('selected', b.dataset.minutes === '10'));
  updateSaveButton(); showDialog('#book-dialog');
}
$$('[data-view]').forEach(button => button.addEventListener('click', () => {
  state.view = button.dataset.view; state.category = '全部'; state.query = ''; state.online = []; state.onlineQuery = ''; state.limit = 24; state.searchSequence++;
  $('#search-input').value = ''; $('#search-status').textContent = ''; renderCategories(); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
}));
$('#categories').addEventListener('click', event => { const button = event.target.closest('[data-category]'); if (!button) return; state.category = button.dataset.category; state.limit = 24; renderCategories(); render(); });
$('#load-more').addEventListener('click', () => { state.limit += 24; render(); });
let searchTimer;
$('#search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => {
  state.query = $('#search-input').value.trim(); state.limit = 24; state.onlineQuery = ''; state.online = []; state.searchSequence++;
  $('#search-status').textContent = ''; render();
}, 160); });
$('#search-form').addEventListener('submit', event => { event.preventDefault(); clearTimeout(searchTimer); state.query = $('#search-input').value.trim(); state.limit = 24; render(); if (!currentBooks().length && state.query) onlineSearch(); });
$('#online-search').addEventListener('click', onlineSearch);
async function onlineSearch() {
  clearTimeout(searchTimer); const query = $('#search-input').value.trim(); if (!query) { $('#search-input').focus(); toast('先输入书名或作者'); return; }
  const sequence = ++state.searchSequence; state.query = query;
  const status = $('#search-status'); status.textContent = '正在翻找 Open Library…';
  $('#online-search').disabled = true;
  try {
    const response = await appFetch(`/api/search?q=${encodeURIComponent(query)}`); const data = await response.json(); if (!response.ok) throw new Error(data.error);
    if (sequence !== state.searchSequence) return;
    state.online = data.books; state.onlineQuery = query; state.category = '全部'; state.limit = 30;
    status.textContent = data.notice || (data.books.length ? `来自 ${data.source} · 本次找到 ${data.books.length} 本` : '在线书库暂无匹配，可以直接添加书名与作者。');
    renderCategories(); render();
  } catch (error) { if (sequence === state.searchSequence) status.textContent = error.message || '联网搜索失败，请稍后重试。'; }
  finally { $('#online-search').disabled = false; }
}
async function openSettings() {
  $('#settings-status').textContent = '正在读取 DSH 配置…'; showDialog('#settings-dialog');
  try {
    const response = await appFetch('/api/bootstrap'); const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    Object.assign(state, { hasKey: data.settings.hasKey, model: data.settings.model });
    $('#model').value = state.model; updateKeyDot();
    $('#settings-status').textContent = state.hasKey ? 'DSH 配置已就绪。' : '请在 DSH 中配置 DeepSeek API Key，并将默认模型设为 DeepSeek 官方模型。';
  } catch { $('#settings-status').textContent = '无法读取 DSH 配置，请检查服务是否仍在运行。'; }
}
$('#settings-open').addEventListener('click', openSettings); $('#settings-avatar').addEventListener('click', openSettings);
function updateKeyDot() { $('#key-dot').classList.toggle('connected', state.hasKey); }
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault(); await openSettings();
  if (state.hasKey && pendingBook) { pendingBook = false; $('#settings-dialog').close(); showDialog('#book-dialog'); }
});
function openCustom() { $('#custom-form').reset(); showDialog('#custom-dialog'); }
$('#import-open').addEventListener('click', openCustom); $('#empty-add').addEventListener('click', openCustom);
$('#custom-form').addEventListener('submit', event => { event.preventDefault(); const title = $('#custom-title').value.trim(), author = $('#custom-author').value.trim(); if (!title || !author) return; $('#custom-dialog').close(); openBook({ id: `custom-${title}-${author}`, title, author, category: '自选书籍', color: 2 }); });
$('#length-options').addEventListener('click', event => { const button = event.target.closest('[data-minutes]'); if (!button) return; state.minutes = Number(button.dataset.minutes); $$('#length-options button').forEach(b => b.classList.toggle('selected', b === button)); });
$('#source-file').addEventListener('change', async event => { const file = event.target.files[0]; if (!file) return; if (file.size > 2400000) { toast('文件过大，请截取部分原文。'); event.target.value = ''; return; } const text = await file.text(); if (text.length > 600000) { toast('原文超过 60 万字，请分段导入。'); return; } $('#source-text').value = text; toast(`已导入 ${text.length.toLocaleString()} 字`); });
$('#save-book').addEventListener('click', () => toggleSave(state.selected));
$('#read-book').addEventListener('click', startReading);
function requestHeaders() { return { 'Content-Type': 'application/json', 'X-Thinbook-Token': state.token }; }
function setReaderMode(mode) { $('#reader').hidden = false; document.body.style.overflow = 'hidden'; $('#reader-loading').hidden = mode !== 'loading'; $('#reader-article').hidden = mode !== 'article'; $('#reader-error').hidden = mode !== 'error'; $('#export-reading').disabled = mode !== 'article'; $('#reader').scrollTop = 0; $('#reading-progress').style.width = '0'; }
async function startReading() {
  if (state.running) return;
  if (!state.hasKey && !state.history.some(r => r.book.title === state.selected.title && r.book.author === state.selected.author && r.minutes === state.minutes && r.cacheId)) { pendingBook = true; $('#book-dialog').close(); openSettings(); toast('请先在 DSH 中配置 Key，然后刷新配置。'); return; }
  const thisGeneration = ++generationId;
  const book = state.selected, minutes = state.minutes, sourceText = $('#source-text').value.trim(), sourceComplete = $('#source-complete').checked;
  $('#book-dialog').close(); state.running = true; state.abort = new AbortController(); state.reading = null;
  setReaderMode('loading'); $('#loading-stage').textContent = '正在连接 DeepSeek Harness…'; $('#activity').textContent = `${book.title} · 约 ${minutes} 分钟阅读`;
  let received = false;
  try {
    const response = await appFetch('/api/generate', { method: 'POST', headers: requestHeaders(), body: JSON.stringify({ book, minutes, sourceText, sourceComplete }), signal: state.abort.signal });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || '请求失败。'); }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    const handleLine = line => {
      if (!line.trim() || thisGeneration !== generationId) return; const event = JSON.parse(line);
      if (event.type === 'status') $('#loading-stage').textContent = event.message;
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'result') { received = true; openReading({ ...event.reading, progress: 0 }); saveReading(state.reading); if (event.reading.cacheWarning) toast(event.reading.cacheWarning); }
    };
    while (true) { const { done, value } = await reader.read(); if (done) { buffer += decoder.decode(); break; } buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) handleLine(line); }
    if (buffer.trim()) handleLine(buffer);
    if (!received) throw new Error('连接中断，正文尚未完成，请重试。');
  } catch (error) {
    if (error.name !== 'AbortError' && thisGeneration === generationId) { setReaderMode('error'); $('#error-message').textContent = error.message || '连接失败，请重试。'; }
  } finally { if (thisGeneration === generationId) { state.running = false; state.abort = null; } }
}
function safeUrl(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
// Only a small, escaped Markdown subset is rendered. Raw HTML and remote images are never inserted.
function inline(text) {
  return escapeHTML(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/`([^`]+)`/g, '<code>$1</code>');
}
function markdown(text) {
  return String(text).replace(/\r/g, '').split(/\n\s*\n/).map(block => {
    if (/^#{1,3} /.test(block)) { const level = Math.min(block.match(/^#+/)[0].length + 1, 3); return `<h${level}>${inline(block.replace(/^#+\s*/, ''))}</h${level}>`; }
    if (/^>/.test(block)) return `<blockquote>${inline(block.replace(/^> ?/gm, '')).replace(/\n/g, '<br>')}</blockquote>`;
    if (/^[-*] /m.test(block) && block.split('\n').every(line => /^[-*] /.test(line))) return `<ul>${block.split('\n').map(line => `<li>${inline(line.slice(2))}</li>`).join('')}</ul>`;
    if (/^\d+[.)] /m.test(block) && block.split('\n').every(line => /^\d+[.)] /.test(line))) return `<ol>${block.split('\n').map(line => `<li>${inline(line.replace(/^\d+[.)] /, ''))}</li>`).join('')}</ol>`;
    return `<p>${inline(block).replace(/\n/g, '<br>')}</p>`;
  }).join('');
}
async function openReading(reading) {
  if (reading?.cacheId && !reading.body) {
    try { const response = await appFetch(`/api/readings/${encodeURIComponent(reading.cacheId)}`); const data = await response.json(); if (!response.ok) throw new Error(data.error); reading = { ...reading, ...data.reading, progress: reading.progress || 0 }; }
    catch(error) { toast(error.message || '本地缓存读取失败'); return; }
  }
  if (!reading?.body) return; state.reading = reading;
  const historyIndex = state.history.findIndex(r => r.cacheId && r.cacheId === reading.cacheId);
  if (historyIndex >= 0) state.history[historyIndex] = reading;
  setReaderMode('article'); $('#reader-basis').textContent = `${reading.basis} · THINBOOK`;
  $('#reader-title').textContent = reading.title;
  $('#reader-meta').textContent = `${reading.author}  /  ${reading.body.length.toLocaleString()} 字  /  约 ${Math.max(1, Math.round(reading.body.length / 350))} 分钟`;
  const cost = reading.cost;
  const costText = cost?.minUsd != null && cost?.maxUsd != null ? `生成费用估算 US$${cost.minUsd.toFixed(4)}–${cost.maxUsd.toFixed(4)}${cost.searchCalls ? '（含搜索参考估算）' : ''}` : '生成费用：暂无可靠用量估算';
  const chargeText = reading.cached ? '本次读取本地缓存 · API 费用 US$0 · ' : reading.cacheWarning ? '' : '已缓存至项目本地 · ';
  $('#reader-meta').innerHTML += `<small class="reading-cost" title="${escapeHTML(cost?.note || '')}">${chargeText}${costText}</small>`;
  $('#reader-body').innerHTML = markdown(reading.body); $('#reader-coverage').textContent = reading.coverage;
  $('#sources-list').innerHTML = (reading.sources || []).filter(s => safeUrl(s.url)).map(s => `<li><a href="${escapeHTML(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${escapeHTML(s.title)} ↗</a></li>`).join('');
  $('#reader-sources').hidden = !$('#sources-list').children.length;
  $('#reader-body').style.setProperty('--reading-font', `${state.font}px`);
  requestAnimationFrame(() => { const node = $('#reader'); node.scrollTop = (node.scrollHeight - node.clientHeight) * (reading.progress || 0); });
}
function saveReading(reading) {
  state.history = [reading, ...state.history.filter(r => !(r.book.id === reading.book.id && r.minutes === reading.minutes))].slice(0, 20);
  store.write('history', state.history); render();
}
let progressTimer;
$('#reader').addEventListener('scroll', () => {
  const node = $('#reader'), progress = node.scrollTop / Math.max(1, node.scrollHeight - node.clientHeight);
  $('#reading-progress').style.width = `${Math.min(progress * 100, 100)}%`;
  if (!state.reading) return; state.reading.progress = progress;
  clearTimeout(progressTimer); progressTimer = setTimeout(() => store.write('history', state.history), 500);
}, { passive: true });
function leaveReader() { generationId++; state.abort?.abort(); state.abort = null; state.running = false; $('#reader').hidden = true; document.body.style.overflow = ''; if (state.reading) store.write('history', state.history); render(); }
$('#reader-back').addEventListener('click', leaveReader); $('#cancel-reading').addEventListener('click', leaveReader); $('#finish-reading').addEventListener('click', leaveReader);
$('#retry-reading').addEventListener('click', () => { leaveReader(); openBook(state.selected); });
$('#continue-button').addEventListener('click', () => { if (state.history[0]) openReading({ ...state.history[0], cached: true, chargedThisRequest: false }); });
function changeFont(amount) { state.font = Math.max(14, Math.min(26, state.font + amount)); $('#reader-body').style.setProperty('--reading-font', `${state.font}px`); store.write('font', state.font); }
$('#font-down').addEventListener('click', () => changeFont(-1)); $('#font-up').addEventListener('click', () => changeFont(1));
$('#export-reading').addEventListener('click', () => {
  const r = state.reading; if (!r) return;
  const text = `# ${r.title}\n\n${r.author} · ${r.basis}\n\n${r.body}\n\n---\n\n${r.coverage}\n\n${(r.sources || []).map(s => `- ${s.title}: ${s.url}`).join('\n')}\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `${r.title.replace(/[\\/:*?"<>|]/g, '_')}-薄书.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener('keydown', event => { if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && !$$('dialog').some(d => d.open) && $('#reader').hidden) { event.preventDefault(); $('#search-input').focus(); } if (event.key === 'Escape' && !$('#reader').hidden) leaveReader(); });
async function init() {
  try {
    const response = await appFetch('/api/bootstrap'); if (!response.ok) throw new Error(); const data = await response.json();
    state.books = data.books; state.categories = data.categories; state.token = data.token;
    state.hasKey = data.settings.hasKey; state.model = data.settings.model;
    if (data.lanUrls?.length) { $('#lan-address').hidden = false; $('#lan-address').innerHTML = `同一局域网继续阅读：${data.lanUrls.map(url => `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(url)}</a>`).join(' · ')}`; }
    // Discard malformed browser data rather than preventing startup.
    state.saved = Array.isArray(state.saved) ? state.saved.filter(b => b && typeof b.title === 'string' && typeof b.author === 'string') : [];
    state.history = Array.isArray(state.history) ? state.history.filter(r => r?.book && typeof r.body === 'string' && r.title && r.author) : [];
    state.history = [...(data.readings || []).map(r => ({ ...r, progress: state.history.find(old => old.cacheId === r.cacheId)?.progress || 0 })), ...state.history.filter(r => !r.cacheId)];
    // Discard keys left by older browser versions; DSH owns credentials now.
    try { sessionStorage.removeItem('thinbook:key'); localStorage.removeItem('thinbook:key'); } catch {}
    renderCategories(); render(); updateKeyDot();
  } catch { $('#search-status').textContent = '本地服务未连接，请使用启动脚本打开薄书。'; }
}
init();
