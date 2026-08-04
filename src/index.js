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
  return { income, expense, sisa: income - expense };
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

async function handleMessage(env, msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = (msg.text || '').trim();

  if (!isWhitelisted(userId)) {
    return sendMessage(env, chatId, 'Maaf, bot ini khusus keluarga 😊');
  }

  const name = WHITELIST[userId];

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
      out += `<b>${sc === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'}</b>\n` +
        `Income: ${rupiah(s.income)}\n` +
        `Expense: ${rupiah(s.expense)}\n` +
        `Sisa: <b>${rupiah(s.sisa)}</b>\n\n`;
    }
    return sendMessage(env, chatId, out.trim());
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

  if (text === '/kategori') {
    let out = '';
    for (const sc of ['keluarga', 'pribadi']) {
      out += `<b>${sc === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'}</b>: ` +
        DEFAULT_CATEGORIES[sc].join(', ') + '\n';
    }
    return sendMessage(env, chatId, out.trim());
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
    return sendMessage(env, chatId,
      `✅ Dicatat ${name}!\n` +
      `${scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'} · ${icon} ${category} · <b>${rupiah(parsed.amount)}</b>\n` +
      `<code>${date}</code> · ketik /sisa buat cek budget`
    );
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
