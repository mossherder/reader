// Reader: reflowed PDF text, scroll-only, position remembered per book.
const $ = (id) => document.getElementById(id);
const bookEl = $('book');
const root = document.documentElement;

// ---------- tiny IndexedDB key/value store (holds the current book's text) ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('reader', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function idb(method, ...args) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const req = db.transaction('kv', method === 'get' ? 'readonly' : 'readwrite').objectStore('kv')[method](...args);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

// ---------- library: every book ever opened (id -> title + position), no file data ----------
const ls = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let lib = ls.get('lib', {});
let book = null;      // { id, title, blocks: [[type, text], ...] }
let els = [];         // rendered block elements, parallel to book.blocks
let pendingRestore = null;

// ---------- settings ----------
let fs = ls.get('fs', 20);
const applyFs = () => root.style.setProperty('--fs', fs + 'px');
applyFs();

const MODES = ['red', 'dark', 'light'];
const THEME = { red: '#000000', dark: '#000000', light: '#fbf7ef' };
let mode = 'red'; // always start in red
function setMode(m) {
  mode = m;
  root.dataset.mode = m;
  document.querySelector('meta[name="theme-color"]').content = THEME[m];
}

// ---------- rendering ----------
const TAG = { h: 'h2', p: 'p', s: 'div', pg: 'hr' };
function makeEl([type, text]) {
  const el = document.createElement(TAG[type] || 'p');
  if (type === 's') el.className = 'gap';
  if (text) el.textContent = text;
  return el;
}
function appendBlocks(from) {
  const frag = document.createDocumentFragment();
  for (let i = from; i < book.blocks.length; i++) {
    const el = makeEl(book.blocks[i]);
    els.push(el);
    frag.appendChild(el);
  }
  bookEl.appendChild(frag);
}
function renderAll() {
  bookEl.textContent = '';
  els = [];
  appendBlocks(0);
}

// ---------- position ----------
function topIndex() {
  const y = window.scrollY;
  let lo = 0, hi = els.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (els[mid].offsetTop <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function getPos() {
  if (!els.length) return null;
  const i = topIndex(), el = els[i];
  const f = Math.min(1, Math.max(0, (window.scrollY - el.offsetTop) / (el.offsetHeight || 1)));
  return { i, f };
}
function setPos(p) {
  if (!p || !els.length) return;
  const el = els[Math.min(p.i, els.length - 1)];
  window.scrollTo(0, el.offsetTop + p.f * el.offsetHeight);
}
function savePos() {
  if (!book || pendingRestore) return;
  const p = getPos();
  if (!p) return;
  const max = document.documentElement.scrollHeight - innerHeight;
  lib[book.id] = { ...lib[book.id], title: book.title, i: p.i, f: p.f,
    pct: max > 0 ? Math.round((scrollY / max) * 100) : 0, t: Date.now() };
  ls.set('lib', lib);
}
let saveTimer;
addEventListener('scroll', () => { clearTimeout(saveTimer); saveTimer = setTimeout(savePos, 300); }, { passive: true });
addEventListener('pagehide', savePos);
document.addEventListener('visibilitychange', () => document.hidden && savePos());

// ---------- PDF -> reflowable blocks ----------
let pdfjs;
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('./vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const isPageNum = (t) => /^\s*(page\s*)?[\divxlc]{1,6}\s*$/i.test(t);
const ENDS = /[.!?:;"”’)\]…—–]\s*$/;

function pageToBlocks(items) {
  // 1. group text items into lines
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const x = it.transform[4], y = it.transform[5];
    const h = it.height || Math.hypot(it.transform[2], it.transform[3]) || 10;
    if (cur && Math.abs(y - cur.y) > h * 0.6) { lines.push(cur); cur = null; }
    if (!cur) cur = { text: '', x, y, h: 0, r: x };
    cur.text += it.str;
    cur.h = Math.max(cur.h, h);
    cur.x = Math.min(cur.x, x);
    cur.r = Math.max(cur.r, x + (it.width || 0));
    if (it.hasEOL) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);
  let L = lines.filter((l) => l.text.trim());
  // drop page numbers at top/bottom
  if (L.length && isPageNum(L[0].text)) L.shift();
  if (L.length && isPageNum(L[L.length - 1].text)) L.pop();
  if (!L.length) return [];

  // 2. page metrics
  const bodyH = median(L.map((l) => l.h));
  const gaps = [];
  for (let k = 1; k < L.length; k++) { const g = L[k - 1].y - L[k].y; if (g > 0) gaps.push(g); }
  const gap = median(gaps) || bodyH * 1.2;
  const left = median(L.filter((l) => Math.abs(l.h - bodyH) < bodyH * 0.2).map((l) => l.x)) || Math.min(...L.map((l) => l.x));
  const right = Math.max(...L.map((l) => l.r));

  // Lines that reach the right margin only wrapped; lines that stop short were broken on purpose.
  // Justified text hits the margin almost exactly, so a tight threshold works; ragged-right needs slack.
  const full = L.filter((l) => l.r > right - bodyH * 0.5).length;
  const shortBy = full > L.length * 0.5 ? bodyH * 1.2 : bodyH * 3;

  // 3. lines -> paragraphs / headings / scene gaps
  const blocks = [];
  let para = null, prev = null;
  const flush = () => { if (para) blocks.push(['p', para.replace(/[ \t]+/g, ' ').trim()]); para = null; };
  for (const l of L) {
    const text = l.text.replace(/\s+/g, ' ').trim();
    const dy = prev ? prev.y - l.y : 0;
    if (prev && dy > gap * 2.2 && (para || (blocks.length && blocks[blocks.length - 1][0] === 'p'))) { flush(); blocks.push(['s', '']); } // scene break / blank line
    if (l.h > bodyH * 1.25 && text.length < 120) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last[0] === 'h' && prev && prev.h > bodyH * 1.25) last[1] += ' ' + text;
      else blocks.push(['h', text]);
      prev = l;
      continue;
    }
    const short = prev && prev.r < right - shortBy;
    const newPara = !para || !prev ||
      dy > gap * 1.45 ||                       // vertical gap
      l.x - left > bodyH * 0.8 ||              // indented first line
      (short && ENDS.test(prev.text));         // previous line ended short at a sentence end
    if (newPara) { flush(); para = text; }
    else if (short) para += '\n' + text;       // author's line break (verse, letters, lists)
    else if (/[A-Za-z]-$/.test(para) && /^[a-z]/.test(text)) para = para.slice(0, -1) + text; // de-hyphenate
    else para += ' ' + text;
    prev = l;
  }
  flush();
  while (blocks.length && blocks[blocks.length - 1][0] === 's') blocks.pop();
  return blocks.filter((b) => b[0] === 's' || b[1]);
}

async function openFile(file) {
  if (!file) return;
  savePos();
  status('Opening…');
  const lib_ = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  let pdf;
  try {
    pdf = await lib_.getDocument({ data, isEvalSupported: false }).promise;
  } catch (e) {
    status('Could not open that PDF', 3000);
    return;
  }
  const id = pdf.fingerprints[0];
  const title = file.name.replace(/\.pdf$/i, '');
  book = { id, title, blocks: [] };
  bookEl.textContent = '';
  els = [];
  showEmpty(false);
  window.scrollTo(0, 0);
  const known = lib[id];
  pendingRestore = known ? { i: known.i, f: known.f } : null;
  ls.set('cur', id);

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    page.cleanup();
    const blocks = pageToBlocks(tc.items);
    const from = book.blocks.length;
    // join a paragraph that continues across the page break (skipping the marker we left after it)
    let li = from - 1;
    if (li >= 0 && book.blocks[li][0] === 'pg') li--;
    const last = book.blocks[li];
    if (last && last[0] === 'p' && blocks[0] && blocks[0][0] === 'p' &&
        !ENDS.test(last[1]) && /^[a-z(“"'‘,;]/.test(blocks[0][1])) {
      const next = blocks.shift()[1];
      last[1] = /[A-Za-z]-$/.test(last[1]) ? last[1].slice(0, -1) + next : last[1] + ' ' + next;
      els[li].textContent = last[1];
    }
    // page break marker (placed after any paragraph carried over from the previous page)
    if (from && book.blocks[from - 1][0] !== 'pg') book.blocks.push(['pg', '']);
    book.blocks.push(...blocks);
    appendBlocks(from);
    if (pendingRestore && els.length > pendingRestore.i + 1) { setPos(pendingRestore); pendingRestore = null; }
    if (n % 10 === 0 || n === pdf.numPages) status(`Loading ${Math.round((n / pdf.numPages) * 100)}%`);
  }
  pdf.destroy();
  if (book.blocks.length && book.blocks[book.blocks.length - 1][0] === 'pg') { book.blocks.pop(); els.pop().remove(); }
  if (pendingRestore) { setPos(pendingRestore); pendingRestore = null; }

  if (!book.blocks.length) {
    status('No text found — scanned PDFs aren’t supported yet', 4000);
    showEmpty(true);
    return;
  }
  await idb('put', book, 'book');
  status('', 0);
  savePos();
}

// ---------- UI ----------
let statusTimer;
function status(msg, ms) {
  const el = $('status');
  clearTimeout(statusTimer);
  el.textContent = msg;
  el.hidden = !msg;
  if (ms !== undefined) statusTimer = setTimeout(() => (el.hidden = true), ms);
}
function showEmpty(on) {
  $('empty').hidden = !on;
  if (!on) return;
  const ul = $('recent');
  ul.textContent = '';
  Object.values(lib).sort((a, b) => b.t - a.t).slice(0, 5).forEach((b) => {
    const li = document.createElement('li');
    li.textContent = `${b.title} · ${b.pct ?? 0}%`;
    ul.appendChild(li);
  });
}
function changeFs(d) {
  const p = getPos();
  fs = Math.min(40, Math.max(12, fs + d));
  applyFs();
  ls.set('fs', fs);
  setPos(p);
}

const pick = () => $('file').click();
$('file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
$('openBig').addEventListener('click', pick);
$('open').addEventListener('click', pick);
$('smaller').addEventListener('click', () => changeFs(-2));
$('bigger').addEventListener('click', () => changeFs(2));
$('mode').addEventListener('click', () => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]));
$('toggle').addEventListener('click', () => {
  const open = $('row').hidden;
  $('row').hidden = !open;
  $('tools').classList.toggle('open', open);
  $('toggle').setAttribute('aria-expanded', open);
  $('toggle').setAttribute('aria-label', open ? 'Hide tools' : 'Show tools');
});

// ---------- start ----------
setMode('red');
(async () => {
  try { book = await idb('get', 'book'); } catch { book = null; }
  if (!book) return showEmpty(true);
  renderAll();
  const p = lib[book.id];
  if (p) setPos(p);
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
