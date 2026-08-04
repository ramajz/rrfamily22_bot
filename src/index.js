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

// ============ Helpers ============
async function sendMessage(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  return res.json();
}

// Kirim pesan + tombol inline
async function sendMessageKb(env, chatId, text, inlineKeyboard) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: inlineKeyboard,
    }),
  });
  return res.json();
}

// Jawab callback query (hilangkan loading di tombol)
async function answerCallback(env, callbackId, text) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  });
}

function isWhitelisted(userId) {
  return String(userId) in WHITELIST;
}

function rupiah(n) {
  return 'Rp' + Number(n).toLocaleString('id-ID');
}

// Parse angka: "25rb" / "25000" / "25.000" / "1jt" / "1,5jt" / "1.5jt"
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

// Parse tanggal relatif: "kemarin", "2/8", "2026-08-02", default hari ini
function parseDate(str) {
  if (!str) return todayStr();
  const s = String(str).trim().toLowerCase();
  if (s === 'kemarin') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  let m = s.match(/^(\d{1,2})\/(\d{1,2})$/); // dd/mm
  if (m) {
    const year = new Date().getFullYear();
    return `${year}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  return todayStr();
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function matchCategory(word, scope) {
  if (!word) return null;
  const w = word.toLowerCase();
  const cats = [...DEFAULT_CATEGORIES[scope], ...INCOME_CATEGORIES];
  const found = cats.find(c => c.toLowerCase() === w || c.toLowerCase().startsWith(w) || w.startsWith(c.toLowerCase()));
  return found || null;
}

// ============ AI Parse (DataByte) ============
async function aiParse(env, text, defaultScope) {
  const system = `Kamu adalah parser transaksi keuangan. Ekstrak dari teks user (bahasa Indonesia) dan jawab HANYA JSON:
{
  "scope": "keluarga|pribadi|null",
  "type": "income|expense",
  "amount": <int rupiah>,
  "category": "<nama kategori>",
  "date": "YYYY-MM-DD|null"
}
Aturan:
- amount wajib. "25rb"=25000, "1jt"=1000000, "1,5jt"=1500000.
- scope: null jika tidak jelas (default "${defaultScope}").
- "gaji", "masuk", "terima" = income. Sisanya expense.
- category: cocokkan ke konteks. "makan"=Makan, "kopi"=Jajan, "bensin"=Transport, "cicilan"=Cicilan.
- date: "kemarin" = tanggal kemarin. null = hari ini.
- Jangan tambahkan teks lain, HANYA JSON.`;

  const res = await fetch(env.AI_ENDPOINT + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.AI_MODEL || 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
      temperature: 0,
      max_tokens: 200,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('AI error: ' + err.slice(0, 200));
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(content.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

// ============ Command Handlers ============
async function handleCatat(env, userId, scope, type, amount, category, date, note) {
  await env.DB.prepare(
    'INSERT INTO transactions (user_id, scope, type, amount, category, note, tx_date) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(userId, scope, type, amount, category, note || null, date).run();
}

async function getSisa(env, scope) {
  const month = todayStr().slice(0, 7); // YYYY-MM
  const res = await env.DB.prepare(
    `SELECT type, COALESCE(SUM(amount),0) AS total FROM transactions
     WHERE scope = ? AND tx_date LIKE ? GROUP BY type`
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
    `SELECT category, type, COALESCE(SUM(amount),0) AS total FROM transactions
     WHERE scope = ? AND tx_date >= ? GROUP BY category, type ORDER BY total DESC`
  ).bind(scope, fromStr).all();
  return res.results || [];
}

// Cek budget dompet bulan ini, return pesan alert kalau melewati 80%/100%
async function checkBudgetAlert(env, scope, amount) {
  const month = todayStr().slice(0, 7);
  const b = await env.DB.prepare('SELECT amount FROM budgets WHERE scope = ?').bind(scope).first();
  if (!b?.amount) return null;

  const spent = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
     WHERE scope = ? AND type = 'expense' AND tx_date LIKE ?`
  ).bind(scope, month + '%').first();

  const total = (spent?.total || 0) + amount;
  const budget = b.amount;
  const pct = (total / budget) * 100;

  if (pct >= 100) {
    return `⚠️ <b>OVER BUDGET!</b> ${scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'}: ${rupiah(total)} dari ${rupiah(budget)} (${pct.toFixed(0)}%)`;
  }
  if (pct >= 80) {
    return `🟡 ${scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'}: sudah ${rupiah(total)} dari ${rupiah(budget)} (${pct.toFixed(0)}%) — hampir habis!`;
  }
  return null;
}

// AI rekap naratif bulanan
async function aiRekap(env, month, summary) {
  const system = `Kamu adalah analis keuangan keluarga. Berikut ringkasan transaksi bulan ${month}. Buat analisis singkat (maks 200 kata) dalam bahasa Indonesia santai tapi informatif: pola pengeluaran, kategori paling besar, saran hemat yang actionable. Jangan sebutkan "berdasarkan data" berulang-ulang.`;
  const res = await fetch(env.AI_ENDPOINT + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.AI_MODEL || 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: summary },
      ],
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

// Handler klik tombol inline (callback query)
async function handleCallback(env, cb) {
  const chatId = cb.message.chat.id;
  const userId = String(cb.from.id);
  const data = cb.data || '';

  if (!isWhitelisted(userId)) {
    await answerCallback(env, cb.id, 'Bukan untuk kamu');
    return;
  }

  // budget_scope_keluarga / budget_scope_pribadi → pilih kategori
  if (data.startsWith('budget_scope_')) {
    const scope = data.replace('budget_scope_', '');
    const rows = await env.DB.prepare(
      'SELECT name FROM categories WHERE scope = ? AND type = ? ORDER BY name'
    ).bind(scope, 'expense').all();
    const kb = {
      inline_keyboard: [],
    };
    let row = [];
    for (const r of rows.results || []) {
      row.push({ text: r.name, callback_data: `budget_cat_${scope}_${r.name}` });
      if (row.length === 2) {
        kb.inline_keyboard.push(row);
        row = [];
      }
    }
    if (row.length) kb.inline_keyboard.push(row);
    await answerCallback(env, cb.id, 'Pilih kategori');
    return sendMessageKb(env, chatId,
      `Pilih kategori (${scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'}):`,
      kb);
  }

  // budget_cat_<scope>_<nama> → minta nominal
  if (data.startsWith('budget_cat_')) {
    const rest = data.replace('budget_cat_', '');
    const scope = rest.startsWith('keluarga_') ? 'keluarga' : 'pribadi';
    const catName = rest.replace(/^(keluarga|pribadi)_/, '');
    await env.DB.prepare(
      'INSERT OR IGNORE INTO pending_input (telegram_id, action, scope, category) VALUES (?, ?, ?, ?)'
    ).bind(userId, 'set_budget', scope, catName).run();
    await answerCallback(env, cb.id, 'Ketik nominal');
    return sendMessage(env, chatId,
      `💰 Budget untuk <b>${catName}</b> (${scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'}) berapa?\n` +
      `Ketik nominal, contoh: <code>1jt</code> atau <code>500rb</code>`);
  }

  await answerCallback(env, cb.id, 'OK');
}

async function handleMessage(env, msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = (msg.text || '').trim();

  if (!isWhitelisted(userId)) {
    return sendMessage(env, chatId, 'Maaf, bot ini khusus keluarga 😊');
  }

  const name = WHITELIST[userId];

  // ==== Cek pending input (flow budget interaktif) ====
  const pending = await env.DB.prepare('SELECT * FROM pending_input WHERE telegram_id = ?')
    .bind(userId).first();
  if (pending) {
    const amount = parseAmount(text);
    if (!amount) {
      return sendMessage(env, chatId, 'Itu bukan angka yang valid 🤔 Ketik nominal aja, contoh: <code>1jt</code>');
    }
    if (pending.action === 'set_budget') {
      const scope = pending.scope || 'keluarga';
      const catName = pending.category || 'Lainnya';
      await env.DB.prepare(
        'INSERT OR IGNORE INTO categories (scope, name, type) VALUES (?, ?, ?)'
      ).bind(scope, catName, 'expense').run();
      await env.DB.prepare('UPDATE categories SET budget = ? WHERE scope = ? AND name = ?')
        .bind(amount, scope, catName).run();
    }
    await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
    return sendMessage(env, chatId,
      `✅ Budget ${pending.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'} · ${pending.category} = ${rupiah(amount)}`);
  }

  // ==== Commands ====
  if (text === '/start' || text === '/help') {
    return sendMessage(env, chatId,
      `<b>${env.BOT_NAME || 'RRfamily Bot'}</b> 📒\n\n` +
      `Catat keuangan tinggal ketik:\n` +
      `• <code>makan 25rb</code> — expense Keluarga\n` +
      `• <code>/prib kopi 15rb</code> — expense Pribadi\n` +
      `• <code>gaji masuk 10jt</code> — income\n` +
      `• <code>makan 25rb kemarin</code> — tanggal kemarin\n\n` +
      `<b>Perintah:</b>\n` +
      `/sisa — sisa budget bulan ini\n` +
      `/rekap — rekap bulan ini\n` +
      `/rekap 7 — rekap 7 hari\n` +
      `/analisis — analisis naratif AI\n` +
      `/budget — lihat budget (set: /budget keluarga 6.8jt)\n` +
      `/riwayat — transaksi terakhir\n` +
      `/hapus #id — hapus transaksi\n` +
      `/edit #id 30000 — edit transaksi\n` +
      `/kategori — daftar kategori\n` +
      `/kategori tambah "nama"\n` +
      `/saldo — saldo total\n` +
      `/setprib — ubah scope default ke Pribadi\n` +
      `/setkel — ubah scope default ke Keluarga`
    );
  }

  if (text === '/sisa') {
    let out = '';
    for (const sc of ['keluarga', 'pribadi']) {
      const s = await getSisa(env, sc);
      const label = sc === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi';
      out += `<b>${label}</b>\n`;
      if (s.budget) {
        const pct = (s.expense / s.budget) * 100;
        const sisaBudget = s.budget - s.expense;
        const status = sisaBudget < 0 ? '⚠️' : (pct >= 80 ? '🟡' : '✅');
        out += `Budget: ${rupiah(s.budget)}\n` +
          `Expense: ${rupiah(s.expense)} (${pct.toFixed(0)}%)\n` +
          `Sisa budget: <b>${status} ${rupiah(sisaBudget)}</b>\n\n`;
      } else {
        out += `Income: ${rupiah(s.income)}\nExpense: ${rupiah(s.expense)}\nSisa: <b>${rupiah(s.sisa)}</b>\n\n`;
      }
    }
    return sendMessage(env, chatId, out.trim());
  }

  // /analisis → rekap naratif AI bulan ini (per scope)
  if (text === '/analisis') {
    const month = todayStr().slice(0, 7);
    let summary = '';
    for (const sc of ['keluarga', 'pribadi']) {
      const rows = await env.DB.prepare(
        `SELECT category, type, COALESCE(SUM(amount),0) AS total FROM transactions
         WHERE scope = ? AND tx_date LIKE ? GROUP BY category, type ORDER BY total DESC`
      ).bind(sc, month + '%').all();
      const s = await getSisa(env, sc);
      summary += `\n[${sc === 'keluarga' ? 'Keluarga' : 'Pribadi'}]\n` +
        `Income: ${s.income}, Expense: ${s.expense}, Sisa: ${s.sisa}\n`;
      for (const r of rows.results || []) {
        summary += `- ${r.category} (${r.type}): ${r.amount}\n`;
      }
    }
    const aiText = await aiRekap(env, month, summary);
    return sendMessage(env, chatId, aiText);
  }

  if (text.startsWith('/rekap')) {
    const parts = text.split(' ');
    const days = parts[1] ? parseInt(parts[1]) : daysInMonth();
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
    return sendMessage(env, chatId, out.trim());
  }

  if (text === '/saldo') {
    let totalIncome = 0, totalExpense = 0;
    for (const sc of ['keluarga', 'pribadi']) {
      const s = await getSisa(env, sc);
      totalIncome += s.income;
      totalExpense += s.expense;
    }
    // Saldo total semua waktu
    const all = await env.DB.prepare(
      'SELECT type, COALESCE(SUM(amount),0) AS total FROM transactions GROUP BY type'
    ).all();
    let inc = 0, exp = 0;
    for (const r of all.results || []) {
      if (r.type === 'income') inc = r.total;
      else exp = r.total;
    }
    return sendMessage(env, chatId,
      `💰 <b>Saldo Total</b>\n\n` +
      `Total Income: ${rupiah(inc)}\n` +
      `Total Expense: ${rupiah(exp)}\n` +
      `Saldo: <b>${rupiah(inc - exp)}</b>`
    );
  }

  // ==== Budget per DOMWET (2 angka, simple) ====
  // /budget → lihat | /budget keluarga 6.8jt | /budget pribadi 1.5jt | /budget hapus keluarga
  if (text === '/budget' || text.startsWith('/budget ')) {
    const parts = text.replace('/budget', '').trim().split(/\s+/);
    if (parts.length === 0 || parts[0] === '') {
      let out = '📋 <b>Budget Bulanan</b>\n';
      for (const sc of ['keluarga', 'pribadi']) {
        const b = await env.DB.prepare('SELECT amount FROM budgets WHERE scope = ?').bind(sc).first();
        out += `${sc === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'}: ${b?.amount ? rupiah(b.amount) : '<i>belum diset</i>'}\n`;
      }
      out += '\nSet: <code>/budget keluarga 6.8jt</code>\nHapus: <code>/budget hapus keluarga</code>';
      return sendMessage(env, chatId, out.trim());
    }
    if (parts[0] === 'hapus') {
      const scope = parts[1] === 'prib' || parts[1] === 'pribadi' ? 'pribadi' : 'keluarga';
      await env.DB.prepare('DELETE FROM budgets WHERE scope = ?').bind(scope).run();
      return sendMessage(env, chatId, `🗑️ Budget ${scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'} dihapus`);
    }
    const scope = parts[0] === 'prib' || parts[0] === 'pribadi' ? 'pribadi' : 'keluarga';
    const amount = parseAmount(parts[1]);
    if (!amount) return sendMessage(env, chatId, 'Format: /budget keluarga 6.8jt atau /budget pribadi 1.5jt');
    await env.DB.prepare(
      'INSERT INTO budgets (scope, amount) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET amount = excluded.amount'
    ).bind(scope, amount).run();
    return sendMessage(env, chatId, `✅ Budget ${scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'} = ${rupiah(amount)}`);
  }

  if (text === '/kategori') {
    let out = '';
    for (const sc of ['keluarga', 'pribadi']) {
      out += `<b>${sc === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'}</b>: ` +
        DEFAULT_CATEGORIES[sc].join(', ') + '\n';
    }
    return sendMessage(env, chatId, out.trim());
  }

  // ==== Riwayat + edit + hapus ====
  // /riwayat [n] → transaksi terakhir (default 10)
  // /hapus <id> → hapus transaksi
  // /edit <id> kategori baru | /edit <id> 50000 | /edit <id> makan 30000
  if (text === '/riwayat' || text.startsWith('/riwayat ')) {
    const n = parseInt(text.split(' ')[1]) || 10;
    const rows = await env.DB.prepare(
      'SELECT id, scope, type, amount, category, tx_date, note FROM transactions WHERE user_id = ? ORDER BY tx_date DESC, id DESC LIMIT ?'
    ).bind(userId, Math.min(n, 20)).all();
    if (!rows.results?.length) return sendMessage(env, chatId, 'Belum ada transaksi.');
    let out = `📒 <b>Riwayat (${rows.results.length})</b>\n`;
    for (const r of rows.results) {
      const icon = r.type === 'income' ? '⬆️' : '⬇️';
      const sc = r.scope === 'keluarga' ? '🏠' : '🙋';
      out += `<code>#${r.id}</code> ${sc} ${icon} ${r.category}: ${rupiah(r.amount)} · ${r.tx_date}\n`;
    }
    out += '\nHapus: <code>/hapus #id</code>\nEdit: <code>/edit #id 30000</code>';
    return sendMessage(env, chatId, out.trim());
  }

  if (text.startsWith('/hapus ')) {
    const id = parseInt(text.replace(/[^0-9]/g, ''));
    if (!id) return sendMessage(env, chatId, 'Format: /hapus #123 (lihat ID di /riwayat)');
    const res = await env.DB.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?')
      .bind(id, userId).run();
    if (res.meta.changes > 0) {
      return sendMessage(env, chatId, `🗑️ Transaksi #${id} dihapus`);
    }
    return sendMessage(env, chatId, `❌ Transaksi #${id} gak ditemukan (atau bukan punyamu)`);
  }

  if (text.startsWith('/edit ')) {
    const parts = text.replace('/edit', '').trim().split(/\s+/);
    const id = parseInt(parts[0].replace(/[^0-9]/g, ''));
    if (!id || parts.length < 2) {
      return sendMessage(env, chatId, 'Format: /edit #123 30000 atau /edit #123 makan 30000');
    }
    // cek punya user
    const existing = await env.DB.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?')
      .bind(id, userId).first();
    if (!existing) return sendMessage(env, chatId, `❌ Transaksi #${id} gak ditemukan (atau bukan punyamu)`);

    const rest = parts.slice(1).join(' ');
    const amountMatch = rest.match(/(\d+(?:[.,]\d+)?\s*(?:rb|k|jt|j|ribu|juta)?)$/i);
    const amount = amountMatch ? parseAmount(amountMatch[1]) : null;
    const catPart = amountMatch ? rest.slice(0, rest.length - amountMatch[0].length).trim() : rest;

    if (amount) {
      await env.DB.prepare('UPDATE transactions SET amount = ? WHERE id = ?').bind(amount, id).run();
    }
    if (catPart) {
      const scope = existing.scope;
      const cat = matchCategory(catPart, scope) || catPart;
      await env.DB.prepare('UPDATE transactions SET category = ? WHERE id = ?').bind(cat, id).run();
    }
    return sendMessage(env, chatId, `✅ Transaksi #${id} diupdate`);
  }

  if (text.startsWith('/kategori tambah')) {
    const m = text.match(/"([^"]+)"/);
    const catName = m ? m[1] : text.replace('/kategori tambah', '').trim();
    if (!catName) return sendMessage(env, chatId, 'Format: /kategori tambah "nama kategori"');
    for (const sc of ['keluarga', 'pribadi']) {
      if (!DEFAULT_CATEGORIES[sc].includes(catName)) DEFAULT_CATEGORIES[sc].push(catName);
    }
    return sendMessage(env, chatId, `✅ Kategori "${catName}" ditambahkan ke Keluarga & Pribadi`);
  }

  if (text === '/setprib') {
    await env.DB.prepare('INSERT INTO users (telegram_id, name, scope) VALUES (?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET scope = ?')
      .bind(userId, name, 'pribadi', 'pribadi').run();
    return sendMessage(env, chatId, '✅ Scope default kamu sekarang: <b>Pribadi</b>');
  }

  if (text === '/setkel') {
    await env.DB.prepare('INSERT INTO users (telegram_id, name, scope) VALUES (?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET scope = ?')
      .bind(userId, name, 'keluarga', 'keluarga').run();
    return sendMessage(env, chatId, '✅ Scope default kamu sekarang: <b>Keluarga</b>');
  }

  // ==== Free-text parse (AI) ====
  try {
    const userRow = await env.DB.prepare('SELECT scope FROM users WHERE telegram_id = ?').bind(userId).first();
    const defaultScope = userRow?.scope || 'keluarga';

    const parsed = await aiParse(env, text, defaultScope);
    if (!parsed || !parsed.amount) {
      return sendMessage(env, chatId, 'Gak ngerti transaksinya 😅 Ketik contoh: <code>makan 25rb</code> atau /help');
    }

    const scope = parsed.scope || defaultScope;
    const type = parsed.type || 'expense';
    const category = matchCategory(parsed.category, scope) || 'Lainnya';
    const date = parsed.date || todayStr();

    await handleCatat(env, userId, scope, type, parsed.amount, category, text, date);

    const icon = type === 'income' ? '⬆️' : '⬇️';
    let reply = `✅ Dicatat ${name}!\n` +
      `${scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'} · ${icon} ${category} · <b>${rupiah(parsed.amount)}</b>\n` +
      `<code>${date}</code> · ketik /sisa buat cek budget`;

    // Alert budget kalau expense
    if (type === 'expense') {
      const alert = await checkBudgetAlert(env, scope, parsed.amount);
      if (alert) reply += '\n\n' + alert;
    }
    return sendMessage(env, chatId, reply);
  } catch (err) {
    console.error('AI parse error:', err);
    return sendMessage(env, chatId, '⚠️ Error parsing. Coba lagi atau /help');
  }
}

function daysInMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
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

// setWebhook helper: POST /setwebhook?url=...
app.get('/setwebhook', async c => {
  const env = c.env;
  const url = c.req.query('url');
  if (!url) return c.text('Missing ?url=');
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${url}`);
  return c.json(await res.json());
});

export default app;
