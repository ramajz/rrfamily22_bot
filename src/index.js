import { Hono } from 'hono';

const app = new Hono();

// ============ Config ============
// Whitelist: Telegram ID -> nama
const WHITELIST = {
  '205154026': 'Rama',
  '1958041532': 'Istri',
};

const DEFAULT_CATEGORIES = {
  keluarga: ['Makan', 'Transport', 'Kebutuhan', 'Cicilan', 'Pendidikan', 'Kesehatan', 'Hiburan', 'Lainnya'],
  pribadi: ['Jajan', 'Transport', 'Invest', 'Project', 'Lainnya'],
};
const INCOME_CATEGORIES = ['Gaji', 'Side Income'];

const BUDGET_DEFAULTS = {
  keluarga: 6800000,
  pribadi: 1500000,
};

// ============ In-Memory State (per user) ============
// { lastUndoId: number|null, awaitingDeleteSearch: boolean, awaitingBudgetScope: string|null, awaitingCategoryName: boolean }
const userState = {};

function getState(userId) {
  if (!userState[userId]) {
    userState[userId] = { lastUndoId: null, awaitingDeleteSearch: false, awaitingBudgetScope: null, awaitingCategoryName: false, awaitingEditNominal: null, awaitingCategoryRename: null, awaitingDraftDate: false, awaitingDraftItem: null, awaitingEditItem: null, awaitingEditDate: null };
  }
  return userState[userId];
}

// ============ Telegram Helpers ============
async function sendMessage(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  return res.json();
}

async function editMessageKb(env, chatId, messageId, text, inlineKeyboard) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: inlineKeyboard }),
  });
  return res.json();
}

async function sendMessageKb(env, chatId, text, inlineKeyboard) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: inlineKeyboard }),
  });
  return res.json();
}

async function answerCallback(env, callbackId, text) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  });
}

async function sendDocument(env, chatId, filename, fileContent, caption) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`;
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const LF = '\r\n';
  const parts = [];
  parts.push(`--${boundary}${LF}Content-Disposition: form-data; name="chat_id"${LF}${LF}${chatId}`);
  parts.push(`--${boundary}${LF}Content-Disposition: form-data; name="document"; filename="${filename}"${LF}Content-Type: text/csv${LF}${LF}${fileContent}`);
  if (caption) parts.push(`--${boundary}${LF}Content-Disposition: form-data; name="caption"${LF}${LF}${caption}`);
  parts.push(`--${boundary}--${LF}`);
  const body = parts.join(LF);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  return res.json();
}

// ============ Utilities ============
function isWhitelisted(userId) {
  return String(userId) in WHITELIST;
}

function rupiah(n) {
  return 'Rp' + Number(n).toLocaleString('id-ID');
}

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function parseAmount(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  let m = s.match(/^(\d+(?:[.,]\d+)?)\s*(rb|k|jt|j|ribu|juta)?$/);
  if (!m) return null;
  let num = parseFloat(m[1].replace(',', '.'));
  const unit = m[2];
  if (unit === 'rb' || unit === 'k' || unit === 'ribu') num *= 1000;
  if (unit === 'jt' || unit === 'j' || unit === 'juta') num *= 1000000;
  return Math.round(num);
}

// ============ D1 Category Functions ============
async function seedCategories(db) {
  // Seed default categories from code into D1 (INSERT OR IGNORE)
  for (const [scope, cats] of Object.entries(DEFAULT_CATEGORIES)) {
    for (const name of cats) {
      await db.prepare(
        'INSERT OR IGNORE INTO categories (scope, name, type, is_default) VALUES (?, ?, ?, 1)'
      ).bind(scope, name, 'expense').run();
    }
  }
}

async function getCategories(db, scope, typeFilter = 'expense') {
  let query = 'SELECT name FROM categories WHERE scope = ?';
  const params = [scope];
  if (typeFilter) {
    query += ' AND type = ?';
    params.push(typeFilter);
  }
  query += ' ORDER BY id';
  const rows = await db.prepare(query).bind(...params).all();
  if (rows.results.length === 0 && typeFilter === 'expense') {
    // Empty → seed defaults first, then re-read
    await seedCategories(db);
    const retry = await db.prepare(query).bind(...params).all();
    return retry.results.map(r => r.name);
  }
  return rows.results.map(r => r.name);
}

async function getIncomeCategories(db, scope) {
  return getCategories(db, scope, 'income');
}

async function addCategoryToDb(db, scope, name) {
  await db.prepare(
    'INSERT OR IGNORE INTO categories (scope, name, type, is_default) VALUES (?, ?, ?, 0)'
  ).bind(scope, name, 'expense').run();
}

async function renameCategoryInDb(db, scope, oldName, newName) {
  const result = await db.prepare(
    'UPDATE categories SET name = ? WHERE scope = ? AND name = ? AND type = ?'
  ).bind(newName, scope, oldName, 'expense').run();
  return result.meta?.changes > 0;
}

async function deleteCategoryFromDb(db, scope, name) {
  const result = await db.prepare(
    'DELETE FROM categories WHERE scope = ? AND name = ? AND type = ? AND is_default = 0'
  ).bind(scope, name, 'expense').run();
  return result.meta?.changes > 0;
}

// ============ D1 Draft Functions ============
async function saveDraft(env, userId, data) {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO pending_input (telegram_id, action, scope, category, data) VALUES (?, ?, ?, ?, ?)'
  ).bind(userId, 'catat_draft', data.scope || 'keluarga', data.category || 'Lainnya', JSON.stringify(data)).run();
}

async function getDraft(env, userId) {
  const row = await env.DB.prepare('SELECT * FROM pending_input WHERE telegram_id = ? AND action = ?')
    .bind(userId, 'catat_draft').first();
  if (!row) return null;
  try { return { ...row, parsed: JSON.parse(row.data || '{}') }; } catch { return null; }
}

async function deleteDraft(env, userId) {
  await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ? AND action = ?')
    .bind(userId, 'catat_draft').run();
}

function regexParse(text) {
  // Try to parse: "[item] [amount]"
  // Examples: "mie apong 50rb", "bensin 75rb", "listrik 350.000"
  const s = text.trim().toLowerCase().replace(/[\n\r\t]+/g, ' ').replace(/\s+/g, ' ');

  // Pattern: everything before the amount = item
  // Amount patterns: 50rb, 50k, 50ribu, 50.000, 50000, 1jt, 1juta
  const amountPatterns = [
    /(\d+(?:[.,]\d+)?)\s*(rb|k|ribu)\b/,
    /(\d+(?:[.,]\d+)?)\s*(jt|j|juta)\b/,
    /rp\.?\s*(\d+(?:[.,]\d+)?)\b/,
    /(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?)\b/,  // 35.000 or 350.000
    /(\d+)\b/
  ];

  let amount = null;
  let amountEnd = s.length;

  for (const pat of amountPatterns) {
    const m = s.match(pat);
    if (m) {
      amount = parseAmount(m[0]);
      if (amount) {
        amountEnd = s.indexOf(m[0]);
        break;
      }
    }
  }

  if (!amount || amountEnd === 0) return null;

  // Item = text before amount
  let item = s.substring(0, amountEnd).trim();
  // Clean up common prefixes
  item = item.replace(/^(beli|bayar|buat|isi|isi ulang|top up|transfer)\s+/i, '');
  item = item.replace(/\s+/g, ' ').trim();

  if (!item || item.length < 2) return null;

  // Income keywords map the transaction to income categories.
  const incomeMatch = /^(gaji|pendapatan|income|pemasukan|masuk|terima|honor|bonus|fee)\b/i.test(item);
  const type = incomeMatch ? 'income' : 'expense';
  if (incomeMatch) {
    item = item.replace(/^(gaji|pendapatan|income|pemasukan|masuk|terima|honor|bonus|fee)\s*/i, '').trim() || 'Pendapatan';
  }

  // Capitalize first letter
  item = item.charAt(0).toUpperCase() + item.slice(1);

  return { item, amount, type };
}

async function regexCategoryPicker(db, scope) {
  const expenseCats = await getCategories(db, scope, 'expense');
  const incomeCats = await getCategories(db, scope, 'income');
  const kb = { inline_keyboard: [] };
  let row = [];

  // Income categories first
  for (const c of incomeCats) {
    row.push({ text: `⬆️ ${c}`, callback_data: `draft_set_cat_${c}` });
    if (row.length === 3) { kb.inline_keyboard.push(row); row = []; }
  }
  if (row.length) kb.inline_keyboard.push(row);

  // Separator
  kb.inline_keyboard.push([{ text: '— Pengeluaran —', callback_data: 'noop' }]);

  // Expense categories
  row = [];
  for (const c of expenseCats) {
    row.push({ text: c, callback_data: `draft_set_cat_${c}` });
    if (row.length === 3) { kb.inline_keyboard.push(row); row = []; }
  }
  if (row.length) kb.inline_keyboard.push(row);
  kb.inline_keyboard.push([{ text: '🔙 Kembali', callback_data: 'draft_back' }]);
  return kb;
}

function parseDate(str) {
  if (!str) return todayStr();
  const s = String(str).trim().toLowerCase();
  if (s === 'kemarin') {
    const d = nowWIB();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  let m = s.match(/(\d+)\s*hari\s*(yang\s*)?lalu/);
  if (m) {
    const d = nowWIB();
    d.setDate(d.getDate() - parseInt(m[1], 10));
    return d.toISOString().slice(0, 10);
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const year = nowWIB().getFullYear();
    return `${year}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  return todayStr();
}

function nowWIB() {
  const d = new Date();
  d.setHours(d.getHours() + 7);
  return d;
}

function todayStr() {
  return nowWIB().toISOString().slice(0, 10);
}

async function matchCategory(db, word, scope) {
  if (!word) return null;
  const w = word.toLowerCase();
  const cats = [...(await getCategories(db, scope)), ...INCOME_CATEGORIES];
  const found = cats.find(c => c.toLowerCase() === w || c.toLowerCase().startsWith(w) || w.startsWith(c.toLowerCase()));
  return found || null;
}

function daysInMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

// ============ AI Functions ============
async function callAI(env, { system, user, model, visionBase64 }) {
  const primary = { endpoint: env.AI_ENDPOINT, key: env.AI_API_KEY, model };
  const fallback = { endpoint: env.CC_ENDPOINT, key: env.CC_API_KEY, model: model.includes('MiniMax') ? env.CC_VISION_MODEL : env.CC_MODEL };

  const content = visionBase64
    ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${visionBase64}` } }]
    : user;

  let lastErr = null;
  for (const p of [primary, fallback]) {
    if (!p.endpoint || !p.key || !p.model) continue;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch(p.endpoint + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${p.key}` },
        body: JSON.stringify({
          model: p.model,
          messages: [{ role: 'system', content: system }, { role: 'user', content }],
          temperature: 0,
          max_tokens: 200,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const err = await res.text();
        lastErr = new Error(`AI error (${p.endpoint}): ${err.slice(0, 150)}`);
        continue;
      }
      const data = await res.json();
      const contentOut = data.choices?.[0]?.message?.content || '{}';
      try {
        const parsed = JSON.parse(contentOut.replace(/```json|```/g, '').trim());
        return { parsed, provider: p.endpoint };
      } catch {
        lastErr = new Error(`JSON parse gagal dari ${p.endpoint}: ${contentOut.slice(0, 100)}`);
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Semua provider AI gagal');
}

// AI Parse — now with action detection for intent routing
async function aiParse(env, text, defaultScope) {
  const keluargaCats = await getCategories(env.DB, 'keluarga');
  const pribadiCats = await getCategories(env.DB, 'pribadi');
  const catList = [...new Set([...keluargaCats, ...pribadiCats])].join(', ');
  const system = `Kamu adalah asisten keuangan keluarga. Analisis pesan user (bahasa Indonesia) dan jawab HANYA JSON:

{
  "action": "catat|riwayat|sisa|budget|kategori|export|rekap|analisis|unknown",
  "scope": "keluarga|pribadi|null",
  "type": "income|expense",
  "amount": <int rupiah>,
  "category": "<nama kategori>",
  "item": "<nama produk/merk, atau null>",
  "date": "YYYY-MM-DD|null",
  "original_text": "<teks asli user>"
}

Aturan action:
- Jika ada nominal/harga → action="catat". Contoh: "makan 25rb", "gaji 3jt"
- Jika user mau lihat riwayat → action="riwayat". Contoh: "riwayat", "histori"
- Jika user mau tahu sisa budget → action="sisa". Contoh: "sisa budget", "budget tinggal berapa"
- Jika user mau lihat/ubah budget → action="budget". Contoh: "budget berapa"
- Jika user mau lihat kategori → action="kategori". Contoh: "kategori apa aja"
- Jika user mau export → action="export". Contoh: "export", "download csv"
- Jika user mau analisis/rekap → action="rekap". Contoh: "analisis", "rekap"
- Jika gak jelas → action="unknown"

Aturan untuk action=catat:
- amount wajib. "25rb"=25000, "1jt"=1000000, "1,5jt"=1500000.
- scope: null jika tidak jelas (default "${defaultScope}").
- "gaji", "masuk", "terima" = income. Sisanya expense.
- category: cocokkan ke daftar: ${catList}. Jika gak cocok → "Lainnya".
- item: NAMA PRODUK/MERK jika disebut. "pampers sweety 55rb" → item="pampers sweety". "makan 25rb" → null.
- date: "kemarin" = tanggal kemarin. null = hari ini.

KATEGORI YANG TERSEDIA:
Keluarga: ${keluargaCats.join(', ')}
Pribadi: ${pribadiCats.join(', ')}
Income: ${INCOME_CATEGORIES.join(', ')}

Jangan tambahkan teks lain, HANYA JSON.`;

  const { parsed } = await callAI(env, {
    system,
    user: text,
    model: env.AI_MODEL || 'deepseek-v4-flash',
  });
  return parsed;
}

// AI Parse STRUK (foto/gambar via MiniMax-M3, fallback mimo)
async function aiParseStruk(env, imageBase64, defaultScope) {
  const system = `Kamu adalah parser struk belanja. Lihat gambar struk, ekstrak SEMUA item, jawab HANYA JSON:
{
  "type": "income|expense",
  "amount": <int rupiah, TOTAL belanja>,
  "category": "<kategori: Makan|Transport|Kebutuhan|Cicilan|Pendidikan|Kesehatan|Hiburan|Lainnya>",
  "date": "YYYY-MM-DD|null",
  "items": [
    {"name": "<nama produk/merk>", "amount": <int rupiah>},
    {"name": "...", "amount": <int>}
  ]
}
Aturan:
- amount = total yang dibayar (angka paling besar di bagian bawah struk, biasanya TOTAL).
- items: BREAKDOWN SEMUA produk yang dibeli dengan harga masing-masing. PENTING: jangan gabung, satu produk = satu entry.
- Jika struk punya banyak item, masukkan semuanya. Harga satuan × qty = amount item.
- Jika total di struk TIDAK SAMA dengan jumlah items (misal ada diskon/pajak), amount tetap total asli struk; items tetap rincian produk.
- Jika bukan struk belanja (misal transfer/QRIS, struk bensin 1 item), items cukup 1 entry.
- Jika gambar bukan struk sama sekali, items=[] dan amount=0.
- category: Makan untuk restoran/minimarket makanan, Kebutuhan untuk belanja bulanan/sembako.
- date: null jika tidak tertera jelas.
- Jangan tambahkan teks lain, HANYA JSON.`;

  const { parsed } = await callAI(env, {
    system,
    user: 'Baca struk ini.',
    model: env.AI_VISION_MODEL || 'MiniMax-M3',
    visionBase64: imageBase64,
  });
  return parsed;
}

// AI rekap naratif bulanan
async function aiRekap(env, month, summary) {
  const system = `Kamu adalah analis keuangan keluarga. Berikut ringkasan transaksi bulan ${month}. Buat analisis singkat (maks 200 kata) dalam bahasa Indonesia santai tapi informatif: pola pengeluaran, kategori paling besar, saran hemat yang actionable. Jangan sebutkan "berdasarkan data" berulang-ulang.`;
  const res = await fetch(env.AI_ENDPOINT + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify({
      model: env.AI_MODEL || 'deepseek-v4-flash',
      messages: [{ role: 'system', content: system }, { role: 'user', content: summary }],
      temperature: 0.7,
      max_tokens: 400,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('AI rekap error: ' + err.slice(0, 200));
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || 'Gak bisa bikin analisis.';
}

// ============ Database Operations ============
async function handleCatat(env, userId, scope, type, amount, category, note, date, item) {
  await env.DB.prepare(
    'INSERT INTO transactions (user_id, scope, type, amount, category, note, tx_date, item) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(userId, scope, type, amount, category, note || null, date || todayStr(), item || null).run();
}

async function getSisa(env, scope) {
  const month = todayStr().slice(0, 7);
  const res = await env.DB.prepare(
    `SELECT type, COALESCE(SUM(amount),0) AS total FROM transactions WHERE scope = ? AND tx_date LIKE ? GROUP BY type`
  ).bind(scope, month + '%').all();
  let income = 0, expense = 0;
  for (const r of res.results || []) {
    if (r.type === 'income') income = r.total;
    else expense = r.total;
  }
  const b = await env.DB.prepare('SELECT amount FROM budgets WHERE scope = ?').bind(scope).first();
  return { income, expense, sisa: income - expense, budget: b?.amount || null };
}

async function getRekap(env, scope, days) {
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  const fromStr = from.toISOString().slice(0, 10);
  const res = await env.DB.prepare(
    `SELECT category, type, COALESCE(SUM(amount),0) AS total FROM transactions WHERE scope = ? AND tx_date >= ? GROUP BY category, type ORDER BY total DESC`
  ).bind(scope, fromStr).all();
  return res.results || [];
}

async function checkBudgetAlert(env, scope, amount) {
  const month = todayStr().slice(0, 7);
  const b = await env.DB.prepare('SELECT amount FROM budgets WHERE scope = ?').bind(scope).first();
  const budget = b?.amount || BUDGET_DEFAULTS[scope];
  if (!budget) return null;

  const spent = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE scope = ? AND type = 'expense' AND tx_date LIKE ?`
  ).bind(scope, month + '%').first();

  const total = (spent?.total || 0) + amount;
  const pct = (total / budget) * 100;

  if (pct >= 100) return `⚠️ <b>OVER BUDGET!</b> ${scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'}: ${rupiah(total)} dari ${rupiah(budget)} (${pct.toFixed(0)}%)`;
  if (pct >= 80) return `🟡 ${scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'}: sudah ${rupiah(total)} dari ${rupiah(budget)} (${pct.toFixed(0)}%) — hampir habis!`;
  return null;
}

// Search transactions for delete flow
async function searchTransactions(env, userId, query) {
  const amount = parseAmount(query);
  const keywords = query.replace(/\d+\s*(rb|k|jt|j|ribu|juta)?/gi, '').trim().toLowerCase().split(/\s+/).filter(Boolean);

  let sql = 'SELECT * FROM transactions WHERE user_id = ?';
  const params = [userId];

  if (keywords.length) {
    const conditions = [];
    for (const kw of keywords) {
      conditions.push('(LOWER(category) LIKE ? OR LOWER(item) LIKE ? OR LOWER(note) LIKE ?)');
      params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
    }
    sql += ` AND (${conditions.join(' AND ')})`;
  }

  if (amount) {
    // If we have keywords, amount is a secondary filter; otherwise primary
    if (!keywords.length) {
      sql += ' AND amount >= ? AND amount <= ?';
      params.push(Math.round(amount * 0.7), Math.round(amount * 1.3));
    }
  }

  sql += ' ORDER BY tx_date DESC, id DESC LIMIT 10';

  const res = await env.DB.prepare(sql).bind(...params).all();
  return res.results || [];
}

// ============ UI Keyboard Builders ============
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📊 Riwayat', callback_data: 'riwayat_1' }, { text: '💰 Sisa Budget', callback_data: 'sisa' }],
      [{ text: '⚙️ Settings', callback_data: 'settings' }],
    ],
  };
}

function postTransactionKeyboard(txId) {
  return {
    inline_keyboard: [
      [
        { text: '↩️ Undo', callback_data: `undo_${txId}` },
        { text: '🏷️ Ubah Kategori', callback_data: `ubah_kategori_${txId}` },
        { text: '💰 Sisa', callback_data: 'sisa' },
      ],
      [{ text: '🏠 Menu', callback_data: 'menu_main' }],
    ],
  };
}

function settingsKeyboard(scope) {
  const otherScope = scope === 'keluarga' ? 'pribadi' : 'keluarga';
  const otherLabel = otherScope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
  return {
    inline_keyboard: [
      [{ text: '📦 Budget', callback_data: 'budget' }, { text: '🏷️ Kategori', callback_data: 'kategori' }],
      [{ text: `🔄 Ganti ke ${otherLabel}`, callback_data: `switch_scope_${otherScope}` }],
      [{ text: '📋 Riwayat Lengkap', callback_data: 'riwayat_1' }],
      [{ text: '📥 Export CSV', callback_data: 'export_csv' }],
      [{ text: '❌ Hapus Transaksi', callback_data: 'hapus_start' }],
      [{ text: '🏠 Menu', callback_data: 'menu_main' }],
    ],
  };
}

async function categoryPickerKeyboard(db, txId, scope, type = 'expense') {
  const cats = type === 'income' ? await getIncomeCategories(db, scope) : await getCategories(db, scope, 'expense');
  const kb = { inline_keyboard: [] };
  let row = [];
  for (const c of cats) {
    row.push({ text: c, callback_data: `pilih_kategori_${txId}_${c}` });
    if (row.length === 2) {
      kb.inline_keyboard.push(row);
      row = [];
    }
  }
  if (row.length) kb.inline_keyboard.push(row);
  kb.inline_keyboard.push([{ text: '❌ Batal', callback_data: 'menu_main' }]);
  return kb;
}

function riwayatKeyboard(page, maxPage) {
  const nav = [];
  if (page > 1) nav.push({ text: '⬅️ Prev', callback_data: `riwayat_${page - 1}` });
  if (page < maxPage) nav.push({ text: 'Next ➡️', callback_data: `riwayat_${page + 1}` });
  const kb = { inline_keyboard: [] };
  if (nav.length) kb.inline_keyboard.push(nav);
  kb.inline_keyboard.push([{ text: '🏠 Menu', callback_data: 'menu_main' }]);
  return kb;
}

function budgetMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✏️ Ubah Keluarga', callback_data: 'set_budget_keluarga' },
        { text: '✏️ Ubah Pribadi', callback_data: 'set_budget_pribadi' },
      ],
      [{ text: '⬅️ Kembali', callback_data: 'settings' }],
    ],
  };
}

function categoryManagementKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Tambah Kategori', callback_data: 'kategori_add' }],
      [{ text: '✏️ Edit/Rename', callback_data: 'kategori_edit_list' }],
      [{ text: '🗑️ Hapus Kategori', callback_data: 'kategori_hapus_list' }],
      [{ text: '⬅️ Kembali', callback_data: 'settings' }],
    ],
  };
}

async function categoryEditKeyboard(db, scope) {
  const cats = await getCategories(db, scope);
  const kb = { inline_keyboard: [] };
  let row = [];
  for (const c of cats) {
    row.push({ text: c, callback_data: `kategori_edit_${scope}_${c}` });
    if (row.length === 2) { kb.inline_keyboard.push(row); row = []; }
  }
  if (row.length) kb.inline_keyboard.push(row);
  kb.inline_keyboard.push([{ text: '⬅️ Kembali', callback_data: 'kategori' }]);
  return kb;
}

async function categoryHapusKeyboard(db, scope) {
  const cats = await getCategories(db, scope);
  const kb = { inline_keyboard: [] };
  let row = [];
  for (const c of cats) {
    row.push({ text: '🗑️ ' + c, callback_data: `kategori_hapus_${scope}_${c}` });
    if (row.length === 2) { kb.inline_keyboard.push(row); row = []; }
  }
  if (row.length) kb.inline_keyboard.push(row);
  kb.inline_keyboard.push([{ text: '⬅️ Kembali', callback_data: 'kategori' }]);
  return kb;
}

function deleteSearchResultKeyboard(transactions) {
  const kb = { inline_keyboard: [] };
  for (const tx of transactions) {
    const icon = tx.type === 'income' ? '⬆️' : '⬇️';
    const sc = tx.scope === 'keluarga' ? '🏠' : '🙋';
    const label = `${sc} ${icon} #${tx.id} ${tx.item || tx.category} ${rupiah(tx.amount)} · ${tx.tx_date}`.slice(0, 60);
    kb.inline_keyboard.push([{ text: label, callback_data: `hapus_yes_${tx.id}` }]);
  }
  kb.inline_keyboard.push([{ text: '❌ Batal', callback_data: 'settings' }]);
  return kb;
}

function draftKeyboard(scope, type = 'expense') {
  const scopeLabel = scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
  const typeLabel = type === 'income' ? '⬆️ Pendapatan' : '⬇️ Pengeluaran';
  return {
    inline_keyboard: [
      [{ text: `Jenis: ${typeLabel}`, callback_data: 'draft_switch_type' }],
      [{ text: '🏷️ Kategori', callback_data: 'draft_pick_cat' }],
      [{ text: `🔄 ${scopeLabel}`, callback_data: 'draft_switch_scope' }],
      [
        { text: '📅 Kemarin', callback_data: 'draft_date_kemarin' },
        { text: '📅 Tanggal Lain', callback_data: 'draft_date_custom' },
      ],
      [
        { text: '✅ Simpan', callback_data: 'draft_save' },
        { text: '❌ Batal', callback_data: 'draft_cancel' },
      ],
    ],
  };
}

function draftCategoryKeyboard(scope) {
  return { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'draft_back' }]] };
}

// ============ Screen Renderers ============
async function showMainMenu(env, chatId) {
  const text =
    `<b>🤖 RRfamily Bot</b>\n` +
    `Catat keuangan dengan mudah.\n\n` +
    `Kirim nominal, nanti AI paham sendiri.\n\n` +
    `Contoh:\n` +
    `• <code>makan 25rb</code>\n` +
    `• <code>gaji 3.5jt</code>\n` +
    `• <code>bensin 50rb kemarin</code>`;
  return sendMessageKb(env, chatId, text, mainMenuKeyboard());
}

async function showSisaBudget(env, chatId) {
  const bulan = nowWIB().toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
  let out = `💰 <b>Sisa Budget (${bulan})</b>\n\n`;

  for (const sc of ['keluarga', 'pribadi']) {
    const s = await getSisa(env, sc);
    const label = sc === 'keluarga' ? '👨‍👩‍👧‍👦 Keluarga' : '🙋 Pribadi';
    const budget = s.budget || BUDGET_DEFAULTS[sc];
    const pct = budget > 0 ? (s.expense / budget) * 100 : 0;
    const sisa = budget - s.expense;
    const status = sisa < 0 ? '⚠️' : (pct >= 80 ? '🟡' : '✅');

    out += `<b>${label}</b>\n`;
    out += `Budget: ${rupiah(budget)}\n`;
    out += `Terpakai: ${rupiah(s.expense)} (${pct.toFixed(0)}%)\n`;
    out += `Sisa: <b>${status} ${rupiah(sisa)}</b>\n\n`;
  }

  return sendMessageKb(env, chatId, out.trim(), {
    inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu_main' }]],
  });
}

async function showRiwayat(env, chatId, userId, page = 1) {
  const PER_PAGE = 10;
  page = Math.max(1, page);
  const offset = (page - 1) * PER_PAGE;

  const totalRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?').bind(userId).first();
  const total = totalRow?.c || 0;
  const maxPage = Math.max(1, Math.ceil(total / PER_PAGE));

  if (!total) {
    return sendMessageKb(env, chatId, '📭 Belum ada transaksi.\n\nKetik nominal buat mulai, contoh: <code>makan 25rb</code>', mainMenuKeyboard());
  }

  const rows = await env.DB.prepare(
    'SELECT id, scope, type, amount, category, item, tx_date, note FROM transactions WHERE user_id = ? ORDER BY tx_date DESC, id DESC LIMIT ? OFFSET ?'
  ).bind(userId, PER_PAGE, offset).all();

  let out = `📒 <b>Riwayat (hal ${page}/${maxPage}, total ${total})</b>\n\nPilih transaksi untuk edit/hapus:`;

  // Build buttons per item
  const txButtons = [];
  for (const r of rows.results || []) {
    const icon = r.type === 'income' ? '⬆️' : '⬇️';
    const sc = r.scope === 'keluarga' ? '🏠' : '🙋';
    const label = `${sc} ${icon} ${r.item || r.category} ${rupiah(r.amount)}`;
    txButtons.push([{ text: label, callback_data: `tx_detail_${r.id}` }]);
  }

  const nav = [];
  if (page > 1) nav.push({ text: '⬅️ Prev', callback_data: `riwayat_${page - 1}` });
  if (page < maxPage) nav.push({ text: 'Next ➡️', callback_data: `riwayat_${page + 1}` });

  const kb = { inline_keyboard: [...txButtons] };
  if (nav.length) kb.inline_keyboard.push(nav);
  kb.inline_keyboard.push([{ text: '🏠 Menu', callback_data: 'menu_main' }]);

  return sendMessageKb(env, chatId, out.trim(), kb);
}

async function showSettings(env, chatId, userId) {
  const userRow = await env.DB.prepare('SELECT scope FROM users WHERE telegram_id = ?').bind(userId).first();
  const scope = userRow?.scope || 'keluarga';
  const scopeLabel = scope === 'keluarga' ? '👨‍👩‍👧‍👦 Keluarga' : '🙋 Pribadi';

  const text = `⚙️ <b>Settings</b>\n\nDompet aktif: ${scopeLabel}`;
  return sendMessageKb(env, chatId, text, settingsKeyboard(scope));
}

async function showCategoryPicker(env, chatId, txId, scope) {
  return sendMessageKb(env, chatId, '🏷️ Pilih kategori baru:', await categoryPickerKeyboard(env.DB, txId, scope));
}

async function showBudgetMenu(env, chatId) {
  let out = '📦 <b>Budget Bulanan</b>\n\n';
  for (const sc of ['keluarga', 'pribadi']) {
    const b = await env.DB.prepare('SELECT amount FROM budgets WHERE scope = ?').bind(sc).first();
    const budget = b?.amount || BUDGET_DEFAULTS[sc];
    const label = sc === 'keluarga' ? '👨‍👩‍👧‍👦 Keluarga' : '🙋 Pribadi';
    out += `${label}: <b>${rupiah(budget)}</b>/bulan\n`;
  }
  out += '\nPilih dompet yang mau diubah:';
  return sendMessageKb(env, chatId, out, budgetMenuKeyboard());
}

async function showCategoryManagement(env, chatId) {
  let out = '🏷️ <b>Kategori</b>\n\n';
  for (const sc of ['keluarga', 'pribadi']) {
    const label = sc === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
    const cats = await getCategories(env.DB, sc);
    out += `<b>${label}</b>: ${cats.join(', ')}\n`;
  }
  return sendMessageKb(env, chatId, out, categoryManagementKeyboard());
}

async function showDeleteSearchPrompt(env, chatId) {
  return sendMessage(env, chatId, '🔍 Ketik deskripsi transaksi yang mau dihapus.\n\nContoh: <code>makan</code>, <code>25rb</code>, atau <code>makan 25rb</code>');
}

// ============ Callback Handler ============
async function handleCallback(env, cb) {
  const chatId = cb.message.chat.id;
  const userId = String(cb.from.id);
  const data = cb.data || '';

  if (!isWhitelisted(userId)) {
    await answerCallback(env, cb.id, 'Bukan untuk kamu');
    return;
  }

  const st = getState(userId);

  // Reset any pending state when user clicks a button
  st.awaitingDeleteSearch = false;
  st.awaitingBudgetScope = null;
  st.awaitingCategoryName = false;
  st.awaitingEditNominal = null;
  st.awaitingCategoryRename = null;
  st.awaitingDraftDate = false;
  st.awaitingDraftItem = null;
  st.awaitingEditItem = null;
  st.awaitingEditDate = null;

  // ---- TX Detail (edit/hapus dari riwayat) ----
  if (data.startsWith('tx_detail_')) {
    const txId = parseInt(data.replace('tx_detail_', ''));
    const tx = await env.DB.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').bind(txId, userId).first();
    if (!tx) return sendMessage(env, chatId, '❌ Transaksi gak ditemukan.');
    const icon = tx.type === 'income' ? '⬆️' : '⬇️';
    const sc = tx.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
    const detail = `📋 <b>Transaksi #${tx.id}</b>\n\n${sc} · ${icon} ${tx.category}\nItem: ${tx.item || '-'}\nNominal: <b>${rupiah(tx.amount)}</b>\nTanggal: ${tx.tx_date}\nNote: ${tx.note || '-'}`;
    return sendMessageKb(env, chatId, detail, {
      inline_keyboard: [
        [{ text: '✏️ Edit Kategori', callback_data: `ubah_kategori_${tx.id}` }],
        [{ text: '✏️ Edit Nominal', callback_data: `edit_nominal_${tx.id}` }],
        [{ text: '✏️ Edit Item', callback_data: `edit_item_${tx.id}` }],
        [{ text: '📅 Edit Tanggal', callback_data: `edit_tanggal_${tx.id}` }],
        [{ text: '🗑️ Hapus', callback_data: `hapus_tx_${tx.id}` }],
        [{ text: '🔙 Kembali', callback_data: 'riwayat_1' }]
      ]
    });
  }

  // ---- Edit Nominal ----
  if (data.startsWith('edit_nominal_')) {
    const txId = parseInt(data.replace('edit_nominal_', ''));
    st.awaitingEditNominal = txId;
    return sendMessage(env, chatId, `💰 Ketik nominal baru untuk #${txId}:\nContoh: <code>35rb</code> atau <code>75000</code>`);
  }

  // ---- Edit Item ----
  if (data.startsWith('edit_item_')) {
    const txId = parseInt(data.replace('edit_item_', ''));
    st.awaitingEditItem = txId;
    return sendMessage(env, chatId, `📝 Ketik nama item baru untuk #${txId}:`);
  }

  // ---- Edit Tanggal ----
  if (data.startsWith('edit_tanggal_')) {
    const txId = parseInt(data.replace('edit_tanggal_', ''));
    st.awaitingEditDate = txId;
    return sendMessage(env, chatId, `📅 Ketik tanggal baru untuk #${txId}:\nFormat: <code>DD/MM</code> atau <code>YYYY-MM-DD</code>\nContoh: <code>15/08</code>`);
  }

  // ---- Hapus dari riwayat ----
  if (data.startsWith('hapus_tx_') && !data.startsWith('hapus_tx_confirm_')) {
    const txId = parseInt(data.replace('hapus_tx_', ''));
    const tx = await env.DB.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').bind(txId, userId).first();
    if (!tx) return sendMessage(env, chatId, '❌ Transaksi gak ditemukan.');
    return sendMessageKb(env, chatId,
      `🗑️ Hapus transaksi ini?\n\n${tx.item || tx.category} · ${rupiah(tx.amount)} · ${tx.tx_date}`,
      { inline_keyboard: [
        [{ text: '✅ Ya, Hapus', callback_data: `hapus_tx_confirm_${tx.id}` }],
        [{ text: '❌ Batal', callback_data: 'riwayat_1' }]
      ]}
    );
  }

  if (data.startsWith('hapus_tx_confirm_')) {
    const txId = parseInt(data.replace('hapus_tx_confirm_', ''));
    await env.DB.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').bind(txId, userId).run();
    return sendMessageKb(env, chatId, '🗑️ Transaksi dihapus.', mainMenuKeyboard());
  }

  // ---- Main Menu ----
  if (data === 'menu_main') {
    await answerCallback(env, cb.id, 'Menu');
    return showMainMenu(env, chatId);
  }

  // ---- Riwayat ----
  if (data.startsWith('riwayat_')) {
    const page = parseInt(data.replace('riwayat_', '')) || 1;
    await answerCallback(env, cb.id, `Hal ${page}`);
    return showRiwayat(env, chatId, userId, page);
  }

  // ---- Sisa Budget ----
  if (data === 'sisa') {
    await answerCallback(env, cb.id, 'Budget');
    return showSisaBudget(env, chatId);
  }

  // ---- Settings ----
  if (data === 'settings') {
    await answerCallback(env, cb.id, 'Settings');
    return showSettings(env, chatId, userId);
  }

  // ---- Switch Scope ----
  if (data.startsWith('switch_scope_')) {
    const newScope = data.replace('switch_scope_', '');
    if (newScope !== 'keluarga' && newScope !== 'pribadi') {
      await answerCallback(env, cb.id, 'Invalid');
      return;
    }
    await env.DB.prepare(
      'INSERT INTO users (telegram_id, name, scope) VALUES (?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET scope = ?'
    ).bind(userId, WHITELIST[userId], newScope, newScope).run();
    const label = newScope === 'keluarga' ? '👨‍👩‍👧‍👦 Keluarga' : '🙋 Pribadi';
    await answerCallback(env, cb.id, `Dompet: ${label}`);
    return sendMessageKb(env, chatId, `✅ Dompet aktif: <b>${label}</b>\nSemua transaksi berikutnya masuk ke ${label}.`, settingsKeyboard(newScope));
  }

  // ---- Undo ----
  if (data.startsWith('undo_')) {
    const txId = parseInt(data.replace('undo_', ''));
    if (!txId || st.lastUndoId !== txId) {
      await answerCallback(env, cb.id, 'Undo tidak tersedia');
      return sendMessage(env, chatId, '❌ Undo tidak tersedia lagi untuk transaksi ini.');
    }
    // Delete the transaction
    const tx = await env.DB.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').bind(txId, userId).first();
    if (!tx) {
      st.lastUndoId = null;
      await answerCallback(env, cb.id, 'Tidak ditemukan');
      return sendMessage(env, chatId, `❌ Transaksi #${txId} tidak ditemukan.`);
    }
    await env.DB.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').bind(txId, userId).run();
    st.lastUndoId = null;
    await answerCallback(env, cb.id, 'Di-undo');
    const icon = tx.type === 'income' ? '⬆️' : '⬇️';
    const sc = tx.scope === 'keluarga' ? '🏠' : '🙋';
    return sendMessageKb(env, chatId, `↩️ Transaksi #${txId} dihapus.\n${sc} ${icon} ${tx.item || tx.category}: ${rupiah(tx.amount)}`, mainMenuKeyboard());
  }

  // ---- Ubah Kategori ----
  if (data.startsWith('ubah_kategori_')) {
    const txId = parseInt(data.replace('ubah_kategori_', ''));
    const tx = await env.DB.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').bind(txId, userId).first();
    if (!tx) {
      await answerCallback(env, cb.id, 'Tidak ditemukan');
      return sendMessage(env, chatId, `❌ Transaksi #${txId} tidak ditemukan.`);
    }
    await answerCallback(env, cb.id, 'Pilih kategori');
    return showCategoryPicker(env, chatId, txId, tx.scope);
  }

  // ---- Pilih Kategori ----
  if (data.startsWith('pilih_kategori_')) {
    // Format: pilih_kategori_{id}_{category} — category may contain underscores
    const rest = data.replace('pilih_kategori_', '');
    const firstUnderscore = rest.indexOf('_');
    if (firstUnderscore === -1) {
      await answerCallback(env, cb.id, 'Error');
      return;
    }
    const txId = parseInt(rest.slice(0, firstUnderscore));
    const newCategory = rest.slice(firstUnderscore + 1);

    const tx = await env.DB.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').bind(txId, userId).first();
    if (!tx) {
      await answerCallback(env, cb.id, 'Tidak ditemukan');
      return sendMessage(env, chatId, `❌ Transaksi #${txId} tidak ditemukan.`);
    }
    await env.DB.prepare('UPDATE transactions SET category = ? WHERE id = ?').bind(newCategory, txId).run();
    await answerCallback(env, cb.id, `Kategori: ${newCategory}`);
    return sendMessage(env, chatId, `✅ Kategori #${txId} diubah ke <b>${newCategory}</b>.`);
  }

  // ---- Regex Catat: Save category to draft ----
  if (data.startsWith('regex_cat_')) {
    // Legacy handler for old format - redirect to draft
    await answerCallback(env, cb.id, 'OK');
    return showMainMenu(env, chatId);
  }

  // ---- Hapus Start ----
  if (data === 'hapus_start') {
    st.awaitingDeleteSearch = true;
    await answerCallback(env, cb.id, 'Cari transaksi');
    return showDeleteSearchPrompt(env, chatId);
  }

  // ---- Hapus Yes ----
  if (data.startsWith('hapus_yes_')) {
    const txId = parseInt(data.replace('hapus_yes_', ''));
    const tx = await env.DB.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').bind(txId, userId).first();
    if (!tx) {
      await answerCallback(env, cb.id, 'Tidak ditemukan');
      return sendMessage(env, chatId, `❌ Transaksi #${txId} tidak ditemukan.`);
    }
    await env.DB.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').bind(txId, userId).run();
    // Clear undo if this was the last undo-able transaction
    if (st.lastUndoId === txId) st.lastUndoId = null;
    await answerCallback(env, cb.id, 'Dihapus');
    const icon = tx.type === 'income' ? '⬆️' : '⬇️';
    const sc = tx.scope === 'keluarga' ? '🏠' : '🙋';
    return sendMessageKb(env, chatId, `🗑️ Transaksi #${txId} dihapus.\n${sc} ${icon} ${tx.item || tx.category}: ${rupiah(tx.amount)} · ${tx.tx_date}`, settingsKeyboard(tx.scope));
  }

  // ---- Budget ----
  if (data === 'budget') {
    await answerCallback(env, cb.id, 'Budget');
    return showBudgetMenu(env, chatId);
  }

  // ---- Set Budget ----
  if (data.startsWith('set_budget_')) {
    const scope = data.replace('set_budget_', '');
    if (scope !== 'keluarga' && scope !== 'pribadi') {
      await answerCallback(env, cb.id, 'Invalid');
      return;
    }
    st.awaitingBudgetScope = scope;
    await answerCallback(env, cb.id, 'Set budget');
    const label = scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
    return sendMessage(env, chatId, `💰 Budget <b>${label}</b> berapa?\n\nKetik nominal, contoh: <code>7jt</code> atau <code>1500rb</code>`);
  }

  // ---- Cancel catat ----
  if (data === 'cancel_catat') {
    st.pendingItem = null;
    await answerCallback(env, cb.id, 'Dibatalkan');
    return sendMessageKb(env, chatId, '🗑️ Catatan dibatalkan.', mainMenuKeyboard());
  }

  // ---- Pilih tanggal untuk regex catat ----
  if (data.startsWith('regex_date_')) {
    // Format: regex_date_{scope}_{amount}_{relativeDate}
    const rest = data.replace('regex_date_', '');
    const parts = rest.split('_');
    const relativeDate = parts.pop();
    const amount = parseInt(parts.pop());
    const scope = parts.join('_');
    const item = st.pendingItem || 'item';
    const date = parseDate(relativeDate);
    const cats = await getCategories(env.DB, scope);
    const kb = { inline_keyboard: [] };
    let row = [];
    for (const c of cats) {
      row.push({ text: c, callback_data: `regex_cat_${scope}_${c}_${amount}_${date}` });
      if (row.length === 3) { kb.inline_keyboard.push(row); row = []; }
    }
    if (row.length) kb.inline_keyboard.push(row);
    kb.inline_keyboard.push([{ text: '❌ Batal', callback_data: 'cancel_catat' }]);
    await answerCallback(env, cb.id, 'Tanggal: kemarin');
    return sendMessageKb(env, chatId, `📅 <b>Kemarin</b> · ${item} · ${rupiah(amount)}\n\nPilih kategori:`, kb);
  }

  // ---- Kategori ----
  if (data === 'kategori') {
    await answerCallback(env, cb.id, 'Kategori');
    return showCategoryManagement(env, chatId);
  }

  // ---- Kategori Add ----
  if (data === 'kategori_add') {
    st.awaitingCategoryName = true;
    await answerCallback(env, cb.id, 'Tambah kategori');
    return sendMessage(env, chatId, '📝 Ketik nama kategori baru:\n\nContoh: <code>dana darurat</code> atau <code>gift</code>');
  }

  // ---- Kategori Edit List ----
  if (data === 'kategori_edit_list') {
    await answerCallback(env, cb.id, 'Edit kategori');
    const keluargaCats = await getCategories(env.DB, 'keluarga');
    const pribadiCats = await getCategories(env.DB, 'pribadi');
    let out = '✏️ <b>Edit Kategori</b>\n\n🏠 Keluarga:\n';
    out += keluargaCats.join(', ') + '\n\n🙋 Pribadi:\n';
    out += pribadiCats.join(', ') + '\n\nPilih kategori yang mau di-rename:';
    const kb = { inline_keyboard: [] };
    for (const sc of ['keluarga', 'pribadi']) {
      const cats = sc === 'keluarga' ? keluargaCats : pribadiCats;
      const label = sc === 'keluarga' ? '🏠' : '🙋';
      for (const c of cats) {
        kb.inline_keyboard.push([{ text: `${label} ${c}`, callback_data: `kategori_edit_${sc}_${c}` }]);
      }
    }
    kb.inline_keyboard.push([{ text: '⬅️ Kembali', callback_data: 'kategori' }]);
    return sendMessageKb(env, chatId, out, kb);
  }

  // ---- Kategori Edit ----
  if (data.startsWith('kategori_edit_') && !data.endsWith('_list')) {
    const parts = data.replace('kategori_edit_', '').split('_');
    const scope = parts[0];
    const oldName = parts.slice(1).join('_');
    st.awaitingCategoryRename = { scope, oldName };
    await answerCallback(env, cb.id, oldName);
    return sendMessage(env, chatId, `✏️ Rename "<b>${oldName}</b>" ke apa?\n\nKetik nama baru:`);
  }

  // ---- Kategori Hapus List ----
  if (data === 'kategori_hapus_list') {
    await answerCallback(env, cb.id, 'Hapus kategori');
    const keluargaCats = await getCategories(env.DB, 'keluarga');
    const pribadiCats = await getCategories(env.DB, 'pribadi');
    let out = '🗑️ <b>Hapus Kategori</b>\n\nPilih kategori yang mau dihapus:';
    const kb = { inline_keyboard: [] };
    for (const sc of ['keluarga', 'pribadi']) {
      const cats = sc === 'keluarga' ? keluargaCats : pribadiCats;
      const label = sc === 'keluarga' ? '🏠' : '🙋';
      for (const c of cats) {
        kb.inline_keyboard.push([{ text: `🗑️ ${label} ${c}`, callback_data: `kategori_hapus_${sc}_${c}` }]);
      }
    }
    kb.inline_keyboard.push([{ text: '⬅️ Kembali', callback_data: 'kategori' }]);
    return sendMessageKb(env, chatId, out, kb);
  }

  // ---- Kategori Hapus ----
  if (data.startsWith('kategori_hapus_') && !data.endsWith('_list')) {
    const parts = data.replace('kategori_hapus_', '').split('_');
    const scope = parts[0];
    const catName = parts.slice(1).join('_');
    // Remove from D1
    const deleted = await deleteCategoryFromDb(env.DB, scope, catName);
    if (deleted) {
      await answerCallback(env, cb.id, 'Dihapus');
      return sendMessage(env, chatId, `🗑️ Kategori "<b>${catName}</b>" dihapus dari ${scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'}.`);
    }
    await answerCallback(env, cb.id, 'Gak ditemukan');
    return sendMessage(env, chatId, `❌ Kategori "${catName}" gak ditemukan atau kategori default.`);
  }

  // ---- Export CSV ----
  if (data === 'export_csv') {
    await answerCallback(env, cb.id, 'Export...');
    return handleExport(env, chatId, userId, todayStr().slice(0, 7));
  }

  // ---- Draft: Save transaction ----
  if (data === 'draft_save') {
    const draft = await getDraft(env, userId);
    if (!draft || !draft.parsed.amount) {
      await answerCallback(env, cb.id, 'Error');
      return sendMessageKb(env, chatId, '❌ Draft tidak ditemukan.', mainMenuKeyboard());
    }
    const d = draft.parsed;
    await handleCatat(env, userId, d.scope, d.type || 'expense', d.amount, d.category, `regex: ${d.item || d.category}`, d.date, d.item || null);
    await deleteDraft(env, userId);
    const newTx = await env.DB.prepare('SELECT id FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1').bind(userId).first();
    if (newTx) st.lastUndoId = newTx.id;
    const scopeLabel = d.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
    const icon = d.type === 'income' ? '⬆️' : '⬇️';
    let reply = `✅ Dicatat!\n${scopeLabel} · ${icon} ${d.category} · <b>${rupiah(d.amount)}</b>\n${d.item ? 'Item: ' + d.item + '\n' : ''}📅 ${d.date}`;
    const alert = await checkBudgetAlert(env, d.scope, d.amount);
    if (alert) reply += '\n\n' + alert;
    await answerCallback(env, cb.id, 'Tersimpan');
    return sendMessageKb(env, chatId, reply, postTransactionKeyboard(newTx?.id || 0));
  }

  // ---- Draft: Cancel ----
  if (data === 'draft_cancel') {
    await deleteDraft(env, userId);
    await answerCallback(env, cb.id, 'Dibatalkan');
    return sendMessageKb(env, chatId, '🗑️ Catatan dibatalkan.', mainMenuKeyboard());
  }

  // ---- Draft: Switch type (income/expense) ----
  if (data === 'draft_switch_type') {
    const draft = await getDraft(env, userId);
    if (!draft) { await answerCallback(env, cb.id, 'Error'); return; }
    const d = draft.parsed;
    d.type = d.type === 'income' ? 'expense' : 'income';
    d.category = d.type === 'income' ? 'Gaji' : 'Lainnya';
    await saveDraft(env, userId, d);
    const typeLabel = d.type === 'income' ? '⬆️ Pendapatan' : '⬇️ Pengeluaran';
    await answerCallback(env, cb.id, `Jenis: ${typeLabel}`);
    let summary = `📝 <b>Draft Catatan</b>\n\n`;
    summary += `Jenis: ${typeLabel}\n`;
    summary += `Item: ${d.item || '-'}\n`;
    summary += `Nominal: <b>${rupiah(d.amount)}</b>\n`;
    summary += `Kategori: ${d.category}\n`;
    summary += `Dompet: ${d.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'}\n`;
    summary += `Tanggal: ${d.date}\n\nPilih aksi:`;
    return sendMessageKb(env, chatId, summary, draftKeyboard(d.scope, d.type));
  }

  // ---- Draft: Switch scope ----
  if (data === 'draft_switch_scope') {
    const draft = await getDraft(env, userId);
    if (!draft) { await answerCallback(env, cb.id, 'Error'); return; }
    const d = draft.parsed;
    d.scope = d.scope === 'keluarga' ? 'pribadi' : 'keluarga';
    await saveDraft(env, userId, d);
    const scopeLabel = d.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
    await answerCallback(env, cb.id, `Dompet: ${scopeLabel}`);
    let summary = `📝 <b>Draft Catatan</b>\n\n`;
    summary += `Item: ${d.item || '-'}\n`;
    summary += `Nominal: <b>${rupiah(d.amount)}</b>\n`;
    summary += `Kategori: ${d.category}\n`;
    summary += `Dompet: ${scopeLabel}\n`;
    summary += `Tanggal: ${d.date}\n`;
    summary += `\nPilih aksi:`;
    return sendMessageKb(env, chatId, summary, draftKeyboard(d.scope, d.type));
  }

  // ---- Draft: Change date ----
  if (data.startsWith('draft_date_') && data !== 'draft_date_custom') {
    const draft = await getDraft(env, userId);
    if (!draft) { await answerCallback(env, cb.id, 'Error'); return; }
    const d = draft.parsed;
    const relativeDate = data.replace('draft_date_', '');
    d.date = parseDate(relativeDate);
    await saveDraft(env, userId, d);
    const dateLabel = relativeDate === 'kemarin' ? 'Kemarin' : d.date;
    await answerCallback(env, cb.id, `Tanggal: ${dateLabel}`);
    const scopeLabel = d.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
    let summary = `📝 <b>Draft Catatan</b>\n\n`;
    summary += `Item: ${d.item || '-'}\n`;
    summary += `Nominal: <b>${rupiah(d.amount)}</b>\n`;
    summary += `Kategori: ${d.category}\n`;
    summary += `Dompet: ${scopeLabel}\n`;
    summary += `Tanggal: ${d.date}\n`;
    summary += `\nPilih aksi:`;
    return sendMessageKb(env, chatId, summary, draftKeyboard(d.scope, d.type));
  }

  // ---- Draft: Custom date prompt ----
  if (data === 'draft_date_custom') {
    st.awaitingDraftDate = true;
    await answerCallback(env, cb.id, 'Tanggal custom');
    return sendMessage(env, chatId, `📅 Ketik tanggal transaksi:\nFormat: <code>DD/MM</code> atau <code>YYYY-MM-DD</code>\nContoh: <code>15/08</code> atau <code>2026-08-15</code>`);
  }

  // ---- Draft: Back to summary ----
  if (data === 'draft_back') {
    const draft = await getDraft(env, userId);
    if (!draft) { await answerCallback(env, cb.id, 'Error'); return sendMessageKb(env, chatId, '❌ Draft tidak ditemukan.', mainMenuKeyboard()); }
    const d = draft.parsed;
    const scopeLabel = d.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
    let summary = `📝 <b>Draft Catatan</b>\n\n`;
    summary += `Item: ${d.item || '-'}\n`;
    summary += `Nominal: <b>${rupiah(d.amount)}</b>\n`;
    summary += `Kategori: ${d.category}\n`;
    summary += `Dompet: ${scopeLabel}\n`;
    summary += `Tanggal: ${d.date}\n`;
    summary += `\nPilih aksi:`;
    await answerCallback(env, cb.id, 'Draft');
    return sendMessageKb(env, chatId, summary, draftKeyboard(d.scope, d.type));
  }

  // ---- Draft: Pick category ----
  if (data === 'draft_pick_cat') {
    const draft = await getDraft(env, userId);
    if (!draft) { await answerCallback(env, cb.id, 'Error'); return; }
    const d = draft.parsed;
    const kb = await regexCategoryPicker(env.DB, d.scope);
    await answerCallback(env, cb.id, 'Pilih kategori');
    return sendMessageKb(env, chatId, `🏷️ Pilih kategori untuk <b>${d.item || 'transaksi'}</b>:`, kb);
  }

  // ---- Draft: Set category ----
  if (data.startsWith('draft_set_cat_')) {
    const draft = await getDraft(env, userId);
    if (!draft) { await answerCallback(env, cb.id, 'Error'); return; }
    const d = draft.parsed;
    const newCat = data.replace('draft_set_cat_', '');
    d.category = newCat;
    await saveDraft(env, userId, d);
    const scopeLabel = d.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
    let summary = `📝 <b>Draft Catatan</b>\n\n`;
    summary += `Item: ${d.item || '-'}\n`;
    summary += `Nominal: <b>${rupiah(d.amount)}</b>\n`;
    summary += `Kategori: ${d.category}\n`;
    summary += `Dompet: ${scopeLabel}\n`;
    summary += `Tanggal: ${d.date}\n`;
    summary += `\nPilih aksi:`;
    await answerCallback(env, cb.id, `Kategori: ${newCat}`);
    return sendMessageKb(env, chatId, summary, draftKeyboard(d.scope, d.type));
  }

  // Fallback
  await answerCallback(env, cb.id, 'OK');
}

// ============ Export CSV ============
async function handleExport(env, chatId, userId, filterMonth) {
  const periodLabel = filterMonth || 'semua';
  const query = 'SELECT id, scope, type, amount, category, note, item, tx_date FROM transactions WHERE user_id = ? AND tx_date LIKE ? ORDER BY tx_date ASC, id ASC';
  const rows = await env.DB.prepare(query).bind(userId, filterMonth + '%').all();
  const results = rows.results || [];

  if (!results.length) {
    return sendMessage(env, chatId, `📭 Tidak ada transaksi untuk periode <b>${periodLabel}</b>.`);
  }

  const header = 'id,scope,type,amount,category,note,item,tx_date';
  const csvRows = results.map(r =>
    [r.id, r.scope, r.type, r.amount, csvEscape(r.category), csvEscape(r.note), csvEscape(r.item), r.tx_date].join(',')
  );
  const csv = header + '\n' + csvRows.join('\n');
  const filename = `rrfamily-${filterMonth || 'all'}.csv`;
  const total = results.length;
  const totalExpense = results.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
  const totalIncome = results.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
  const caption = `📊 Export ${periodLabel}\n${total} transaksi · Expense: ${rupiah(totalExpense)} · Income: ${rupiah(totalIncome)}`;

  await sendMessage(env, chatId, '⏳ Membuat CSV...');
  const sent = await sendDocument(env, chatId, filename, csv, caption);
  if (sent.ok) return;
  return sendMessage(env, chatId, `⚠️ Gagal kirim file: ${sent.description || 'unknown error'}`);
}

// ============ Message Handler ============
async function handleMessage(env, msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  let text = (msg.text || '').trim();

  if (!isWhitelisted(userId)) {
    return sendMessage(env, chatId, 'Maaf, bot ini khusus keluarga 😊');
  }

  const name = WHITELIST[userId];
  const st = getState(userId);

  // ==== /start — show main menu with buttons ====
  if (text === '/start' || text === '/help') {
    return showMainMenu(env, chatId);
  }

  // ==== /export (keep as hidden command, triggered via button) ====
  if (text === '/export' || text.startsWith('/export ')) {
    const arg = text.replace('/export', '').trim();
    const filterMonth = /^\d{4}-\d{2}$/.test(arg) ? arg : todayStr().slice(0, 7);
    return handleExport(env, chatId, userId, filterMonth);
  }

  // ==== Handler FOTO STRUK ====
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    await sendMessage(env, chatId, '🧾 Baca struk...');
    try {
      const fileRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${photo.file_id}`);
      const fileData = await fileRes.json();
      const filePath = fileData?.result?.file_path;
      if (!filePath) throw new Error('getFile gagal: ' + JSON.stringify(fileData));

      const dl = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`);
      if (!dl.ok) throw new Error('Download file gagal: ' + dl.status);
      const buf = await dl.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      if (base64.length > 2_000_000) {
        return sendMessage(env, chatId, 'Foto kegedean, kirim yang lebih kecil ya 😅');
      }

      const userRow = await env.DB.prepare('SELECT scope FROM users WHERE telegram_id = ?').bind(userId).first();
      const defaultScope = userRow?.scope || 'keluarga';
      const parsed = await aiParseStruk(env, base64, defaultScope);
      if (!parsed || !parsed.amount) {
        return sendMessage(env, chatId, 'Gagal baca struknya 😅 Coba foto yang lebih jelas, atau ketik manual: <code>makan 25rb</code>');
      }

      const scope = parsed.scope || defaultScope;
      const type = parsed.type || 'expense';
      const category = (await matchCategory(env.DB, parsed.category, scope)) || 'Lainnya';
      const date = parsed.date || todayStr();

      // Normalize items
      let items = Array.isArray(parsed.items) ? parsed.items : [];
      items = items
        .filter(i => i && typeof i.amount === 'number' && i.amount > 0)
        .map(i => ({ name: String(i.name || 'item').trim().toLowerCase() || 'item', amount: Math.round(i.amount) }))
        .filter(i => i.amount >= 5000)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 8);

      // Save pending struk for confirmation
      await env.DB.prepare(
        'INSERT OR REPLACE INTO pending_input (telegram_id, action, scope, category, data) VALUES (?, ?, ?, ?, ?)'
      ).bind(userId, 'confirm_struk', scope, category, JSON.stringify({ type, amount: parsed.amount, date, items })).run();

      const icon = type === 'income' ? '⬆️' : '⬇️';
      let msgText = `📸 Aku baca struknya:\n` +
        `${scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'} · ${icon} ${category} · <b>${rupiah(parsed.amount)}</b>`;

      if (items.length > 1 && type === 'expense') {
        msgText += `\n\n🛒 <b>Item (${items.length}):</b>`;
        for (const it of items) {
          msgText += `\n  • ${it.name.charAt(0).toUpperCase() + it.name.slice(1)} — ${rupiah(it.amount)}`;
        }
        msgText += `\n\nKetik <b>ok</b> buat simpan semua item, atau <b>batal</b>.`;
      } else {
        msgText += `\n\nKetik <b>ok</b> buat simpan, atau ketik koreksi (misal: <code>prib jajan</code>)`;
      }
      return sendMessage(env, chatId, msgText);
    } catch (err) {
      console.error('Foto error:', err);
      return sendMessage(env, chatId, '⚠️ Gagal proses foto. Coba lagi atau ketik manual.');
    }
  }

  // ==== Cek pending input (flow struk confirmation + budget + category) ====
  const pending = await env.DB.prepare('SELECT * FROM pending_input WHERE telegram_id = ?')
    .bind(userId).first();
  if (pending) {
    // confirm_struk
    if (pending.action === 'confirm_struk') {
      const low = text.toLowerCase();
      if (low === 'ok' || low === 'y' || low === 'iya' || low === 'bener' || low === 'benar' || low === 'simpan') {
        const d = JSON.parse(pending.data || '{}');
        if (d.items && d.items.length > 1 && d.type === 'expense') {
          const saved = [];
          for (const it of d.items) {
            await handleCatat(env, userId, pending.scope, 'expense', it.amount, pending.category, `struk: ${it.name}`, d.date || todayStr(), it.name);
            saved.push(it.name);
          }
          const sum = d.items.reduce((s, i) => s + (i.amount || 0), 0);
          const diff = (d.amount || 0) - sum;
          if (diff > 0) {
            await handleCatat(env, userId, pending.scope, 'expense', diff, pending.category, 'struk: lainnya', d.date || todayStr(), 'lainnya');
            saved.push('lainnya');
          }
          await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
          let reply = `✅ Dicatat ${saved.length} item dari struk!\n${pending.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'} · <b>${rupiah(d.amount)}</b> total`;
          const alert = await checkBudgetAlert(env, pending.scope, d.amount);
          if (alert) reply += '\n\n' + alert;
          return sendMessage(env, chatId, reply);
        }
        // Single transaction
        await handleCatat(env, userId, pending.scope, d.type, d.amount, pending.category, 'struk', d.date || todayStr(), d.item || null);
        await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
        const icon = d.type === 'income' ? '⬆️' : '⬇️';
        let reply = `✅ Dicatat!\n${pending.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'} · ${icon} ${pending.category} · <b>${rupiah(d.amount)}</b>`;
        if (d.type === 'expense') {
          const alert = await checkBudgetAlert(env, pending.scope, d.amount);
          if (alert) reply += '\n\n' + alert;
        }
        return sendMessage(env, chatId, reply);
      }
      if (low === 'batal' || low === 'cancel' || low === 'ga jadi' || low === 'gajadi') {
        await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
        return sendMessage(env, chatId, '🗑️ Dibatalin, gak disimpan.');
      }
      // Other text = new parse attempt, clear pending
      await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
      text = low;
    }
  }

  // ==== In-memory state flows ====

  // Awaiting: Delete search
  if (st.awaitingDeleteSearch) {
    st.awaitingDeleteSearch = false;
    const results = await searchTransactions(env, userId, text);
    if (!results.length) {
      return sendMessageKb(env, chatId, `🔍 Gak ada transaksi yang cocok dengan "<b>${text}</b>".\n\nCoba kata lain, atau kembali ke menu.`, settingsKeyboard('keluarga'));
    }
    const list = results.map(r => {
      const icon = r.type === 'income' ? '⬆️' : '⬇️';
      const sc = r.scope === 'keluarga' ? '🏠' : '🙋';
      return `<code>#${r.id}</code> ${sc} ${icon} ${r.item || r.category}: ${rupiah(r.amount)} · ${r.tx_date}`;
    }).join('\n');
    return sendMessageKb(env, chatId, `🔍 <b>Transaksi yang cocok:</b>\n\n${list}\n\nPilih yang mau dihapus:`, deleteSearchResultKeyboard(results));
  }

  // Awaiting: Budget scope value
  if (st.awaitingBudgetScope) {
    const scope = st.awaitingBudgetScope;
    st.awaitingBudgetScope = null;
    const amount = parseAmount(text);
    if (!amount) {
      return sendMessage(env, chatId, '⚠️ Nominal gak valid. Ketik angka, contoh: <code>7jt</code> atau <code>1500rb</code>');
    }
    await env.DB.prepare(
      'INSERT INTO budgets (scope, amount) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET amount = excluded.amount'
    ).bind(scope, amount).run();
    const label = scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
    return sendMessageKb(env, chatId, `✅ Budget <b>${label}</b> = ${rupiah(amount)}/bulan`, budgetMenuKeyboard());
  }

  // Awaiting: Edit nominal
  if (st.awaitingEditNominal) {
    const txId = st.awaitingEditNominal;
    st.awaitingEditNominal = null;
    const amount = parseAmount(text);
    if (!amount) {
      return sendMessage(env, chatId, '⚠️ Nominal gak valid. Ketik angka, contoh: <code>35rb</code> atau <code>75000</code>');
    }
    await env.DB.prepare('UPDATE transactions SET amount = ? WHERE id = ? AND user_id = ?').bind(amount, txId, userId).run();
    return sendMessageKb(env, chatId, `✅ Nominal #${txId} diupdate ke ${rupiah(amount)}`, mainMenuKeyboard());
  }

  // Awaiting: Category rename
  if (st.awaitingCategoryRename) {
    const { scope, oldName } = st.awaitingCategoryRename;
    st.awaitingCategoryRename = null;
    const newName = text.trim();
    if (!newName || newName.length < 2) {
      return sendMessage(env, chatId, '⚠️ Nama kategori terlalu pendek. Ketik nama baru.');
    }
    const formatted = newName.charAt(0).toUpperCase() + newName.slice(1).toLowerCase();
    const renamed = await renameCategoryInDb(env.DB, scope, oldName, formatted);
    if (renamed) {
      return sendMessageKb(env, chatId, `✅ "<b>${oldName}</b>" → "<b>${formatted}</b>"`, categoryManagementKeyboard());
    }
    return sendMessage(env, chatId, `❌ Kategori "${oldName}" gak ditemukan.`);
  }

  // Awaiting: Category name
  if (st.awaitingCategoryName) {
    st.awaitingCategoryName = false;
    const catName = text.trim();
    if (!catName || catName.length < 2) {
      return sendMessage(env, chatId, '⚠️ Nama kategori terlalu pendek. Ketik nama kategori, contoh: <code>dana darurat</code>');
    }
    const formatted = catName.charAt(0).toUpperCase() + catName.slice(1).toLowerCase();
    // Add to D1 for both scopes
    for (const sc of ['keluarga', 'pribadi']) {
      await addCategoryToDb(env.DB, sc, formatted);
    }
    return sendMessageKb(env, chatId, `✅ Kategori "<b>${formatted}</b>" ditambahkan ke Keluarga & Pribadi.`, categoryManagementKeyboard());
  }

  // Awaiting: Draft custom date
  if (st.awaitingDraftDate) {
    st.awaitingDraftDate = false;
    const draft = await getDraft(env, userId);
    if (!draft) return sendMessageKb(env, chatId, '❌ Draft tidak ditemukan.', mainMenuKeyboard());
    const d = draft.parsed;
    d.date = parseDate(text.trim());
    await saveDraft(env, userId, d);
    const scopeLabel = d.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
    let summary = `📝 <b>Draft Catatan</b>\n\n`;
    summary += `Item: ${d.item || '-'}\n`;
    summary += `Nominal: <b>${rupiah(d.amount)}</b>\n`;
    summary += `Kategori: ${d.category}\n`;
    summary += `Dompet: ${scopeLabel}\n`;
    summary += `Tanggal: ${d.date}\n`;
    summary += `\nPilih aksi:`;
    return sendMessageKb(env, chatId, summary, draftKeyboard(d.scope, d.type));
  }

  // Awaiting: Edit item for existing transaction
  if (st.awaitingEditItem) {
    const txId = st.awaitingEditItem;
    st.awaitingEditItem = null;
    const newItem = text.trim();
    if (!newItem || newItem.length < 2) {
      return sendMessage(env, chatId, '⚠️ Nama item terlalu pendek.');
    }
    const formatted = newItem.charAt(0).toUpperCase() + newItem.slice(1).toLowerCase();
    await env.DB.prepare('UPDATE transactions SET item = ? WHERE id = ? AND user_id = ?').bind(formatted, txId, userId).run();
    return sendMessageKb(env, chatId, `✅ Item #${txId} diupdate ke "<b>${formatted}</b>"`, mainMenuKeyboard());
  }

  // Awaiting: Edit date for existing transaction
  if (st.awaitingEditDate) {
    const txId = st.awaitingEditDate;
    st.awaitingEditDate = null;
    const newDate = parseDate(text.trim());
    await env.DB.prepare('UPDATE transactions SET tx_date = ? WHERE id = ? AND user_id = ?').bind(newDate, txId, userId).run();
    return sendMessageKb(env, chatId, `✅ Tanggal #${txId} diupdate ke <b>${newDate}</b>`, mainMenuKeyboard());
  }

  // ==== Free-text: REGEX FIRST, AI FALLBACK ====
  try {
    const userRow = await env.DB.prepare('SELECT scope FROM users WHERE telegram_id = ?').bind(userId).first();
    const defaultScope = userRow?.scope || 'keluarga';

    // STEP 1: Try regex parse (no AI cost)
    const regexResult = regexParse(text);

    if (regexResult && regexResult.amount) {
      // Save draft to D1 and show summary
      const draft = {
        item: regexResult.item,
        amount: regexResult.amount,
        scope: defaultScope,
        category: 'Lainnya',
        date: todayStr(),
        type: regexResult.type || 'expense',
      };
      await saveDraft(env, userId, draft);
      const scopeLabel = draft.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
      const typeLabel = draft.type === 'income' ? '⬆️ Pendapatan' : '⬇️ Pengeluaran';
      let summary = `📝 <b>Draft Catatan</b>\n\n`;
      summary += `Jenis: ${typeLabel}\n`;
      summary += `Item: ${regexResult.item}\n`;
      summary += `Nominal: <b>${rupiah(regexResult.amount)}</b>\n`;
      summary += `Kategori: Lainnya\n`;
      summary += `Dompet: ${scopeLabel}\n`;
      summary += `Tanggal: ${draft.date}\n`;
      summary += `\nPilih aksi:`;
      return sendMessageKb(env, chatId, summary, draftKeyboard(draft.scope));
    }

    // STEP 2: AI fallback (only for complex input)
    const parsed = await aiParse(env, text, defaultScope);

    if (!parsed || !parsed.action) {
      return sendMessageKb(env, chatId, 'Gak ngerti 😅 Ketik nominal buat catat, atau pakai tombol di bawah.', mainMenuKeyboard());
    }

    const action = parsed.action;

    // ---- Action: catat ----
    if (action === 'catat') {
      if (!parsed.amount) {
        return sendMessageKb(env, chatId, 'Gak nemu nominalnya 😅 Contoh: <code>makan 25rb</code>', mainMenuKeyboard());
      }
      const scope = parsed.scope || defaultScope;
      const type = parsed.type || 'expense';
      const category = (await matchCategory(env.DB, parsed.category, scope)) || 'Lainnya';
      const date = parsed.date || todayStr();

      // Save draft, not direct save
      const draft = {
        item: parsed.item || null,
        amount: parsed.amount,
        scope,
        category,
        date,
        type,
      };
      await saveDraft(env, userId, draft);
      const scopeLabel = scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
      const icon = type === 'income' ? '⬆️' : '⬇️';
      let summary = `📝 <b>Draft Catatan</b>\n\n`;
      summary += `Item: ${parsed.item || '-'}\n`;
      summary += `Nominal: <b>${rupiah(parsed.amount)}</b>\n`;
      summary += `Kategori: ${category}\n`;
      summary += `Dompet: ${scopeLabel} ${icon}\n`;
      summary += `Tanggal: ${date}\n`;
      summary += `\nPilih aksi:`;
      return sendMessageKb(env, chatId, summary, draftKeyboard(scope));
    }

    // ---- Action: riwayat ----
    if (action === 'riwayat') {
      return showRiwayat(env, chatId, userId, 1);
    }

    // ---- Action: sisa ----
    if (action === 'sisa') {
      return showSisaBudget(env, chatId);
    }

    // ---- Action: budget ----
    if (action === 'budget') {
      return showBudgetMenu(env, chatId);
    }

    // ---- Action: kategori ----
    if (action === 'kategori') {
      return showCategoryManagement(env, chatId);
    }

    // ---- Action: export ----
    if (action === 'export') {
      return handleExport(env, chatId, userId, todayStr().slice(0, 7));
    }

    // ---- Action: rekap / analisis ----
    if (action === 'rekap' || action === 'analisis') {
      if (action === 'analisis') {
        const month = todayStr().slice(0, 7);
        let summary = '';
        for (const sc of ['keluarga', 'pribadi']) {
          const rows = await env.DB.prepare(
            `SELECT category, type, COALESCE(SUM(amount),0) AS total FROM transactions WHERE scope = ? AND tx_date LIKE ? GROUP BY category, type ORDER BY total DESC`
          ).bind(sc, month + '%').all();
          const s = await getSisa(env, sc);
          summary += `\n[${sc === 'keluarga' ? 'Keluarga' : 'Pribadi'}]\n` +
            `Income: ${s.income}, Expense: ${s.expense}, Sisa: ${s.sisa}\n`;
          for (const r of rows.results || []) {
            summary += `- ${r.category} (${r.type}): ${r.amount}\n`;
          }
        }
        const aiText = await aiRekap(env, month, summary);
        return sendMessageKb(env, chatId, aiText, mainMenuKeyboard());
      }
      // rekap
      const days = daysInMonth();
      let out = '';
      for (const sc of ['keluarga', 'pribadi']) {
        const rows = await getRekap(env, sc, days);
        out += `<b>${sc === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'}</b>\n`;
        if (!rows.length) {
          out += 'Belum ada transaksi\n\n';
          continue;
        }
        for (const r of rows.slice(0, 8)) {
          const icon = r.type === 'income' ? '⬆️' : '⬇️';
          out += `${icon} ${r.category}: ${rupiah(r.total)}\n`;
        }
        out += '\n';
      }
      return sendMessageKb(env, chatId, out.trim(), mainMenuKeyboard());
    }

    // ---- Action: unknown ----
    return sendMessageKb(env, chatId, 'Gak ngerti 😅 Kirim nominal buat catat, atau pakai tombol:', mainMenuKeyboard());
  } catch (err) {
    console.error('AI parse error:', err);
    return sendMessageKb(env, chatId, '⚠️ Error parsing. Coba lagi atau pakai tombol.', mainMenuKeyboard());
  }
}

// ============ Routes ============
app.get('/', c => c.text('RRfamily Bot is running'));

app.post('/webhook', async c => {
  const env = c.env;
  const update = await c.req.json();

  if (update.message) {
    await handleMessage(env, update.message);
  }
  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
  }
  return c.json({ ok: true });
});

// setWebhook helper
app.get('/setwebhook', async c => {
  const env = c.env;
  const url = c.req.query('url');
  if (!url) return c.text('Missing ?url=');
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${url}`);
  return c.json(await res.json());
});

export default app;
