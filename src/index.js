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

// Edit pesan yang sudah ada (pakai message_id dari callback) + tombol inline
async function editMessageKb(env, chatId, messageId, text, inlineKeyboard) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: inlineKeyboard }),
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

// Parse tanggal relatif: "kemarin", "2 hari lalu", "3/8", "2026-08-02", default hari ini (WIB)
function parseDate(str) {
  if (!str) return todayStr();
  const s = String(str).trim().toLowerCase();
  if (s === 'kemarin') {
    const d = nowWIB();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  let m = s.match(/(\d+)\s*hari\s*(yang\s*)?lalu/); // "2 hari lalu", "3 hari yang lalu"
  if (m) {
    const d = nowWIB();
    d.setDate(d.getDate() - parseInt(m[1], 10));
    return d.toISOString().slice(0, 10);
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/); // dd/mm
  if (m) {
    const year = nowWIB().getFullYear();
    return `${year}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  return todayStr();
}

// Sekarang di WIB (UTC+7) — Cloudflare Workers jalan di UTC
function nowWIB() {
  const d = new Date();
  d.setHours(d.getHours() + 7);
  return d;
}

function todayStr() {
  return nowWIB().toISOString().slice(0, 10);
}

function matchCategory(word, scope) {
  if (!word) return null;
  const w = word.toLowerCase();
  const cats = [...DEFAULT_CATEGORIES[scope], ...INCOME_CATEGORIES];
  const found = cats.find(c => c.toLowerCase() === w || c.toLowerCase().startsWith(w) || w.startsWith(c.toLowerCase()));
  return found || null;
}

// ============ AI Parse (DataByte, fallback CommandCode) ============
async function callAI(env, { system, user, model, visionBase64 }) {
  const primary = {
    endpoint: env.AI_ENDPOINT,
    key: env.AI_API_KEY,
    model,
  };
  const fallback = {
    endpoint: env.CC_ENDPOINT,
    key: env.CC_API_KEY,
    model: model.includes('MiniMax') ? env.CC_VISION_MODEL : env.CC_MODEL,
  };

  // content bisa string (teks) atau array (vision)
  const content = visionBase64
    ? [
        { type: 'text', text: user },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${visionBase64}` } },
      ]
    : user;

  let lastErr = null;
  for (const p of [primary, fallback]) {
    if (!p.endpoint || !p.key || !p.model) continue;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000); // timeout 25 detik
      const res = await fetch(p.endpoint + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${p.key}`,
        },
        body: JSON.stringify({
          model: p.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content },
          ],
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

async function aiParse(env, text, defaultScope) {
  const system = `Kamu adalah parser transaksi keuangan. Ekstrak dari teks user (bahasa Indonesia) dan jawab HANYA JSON:
{
  "scope": "keluarga|pribadi|null",
  "type": "income|expense",
  "amount": <int rupiah>,
  "category": "<nama kategori>",
  "item": "<nama produk/merk, atau null>",
  "date": "YYYY-MM-DD|null"
}
Aturan:
- amount wajib. "25rb"=25000, "1jt"=1000000, "1,5jt"=1500000.
- scope: null jika tidak jelas (default "${defaultScope}").
- "gaji", "masuk", "terima" = income. Sisanya expense.
- category: cocokkan ke konteks. "makan"=Makan, "kopi"=Jajan, "bensin"=Transport, "cicilan"=Cicilan.
- item: NAMA PRODUK/MERK jika disebut. Contoh: "pampers sweety 55rb" → item="pampers sweety", "pertalite revo 30rb" → item="pertalite". "makan 25rb" → null. "gaji masuk" → null. Penting: tangkap kata kunci produk & merk.
- date: "kemarin" = tanggal kemarin, "2 hari lalu" = 2 hari yang lalu. null = hari ini.
- Jangan tambahkan teks lain, HANYA JSON.`;

  const { parsed } = await callAI(env, {
    system,
    user: text,
    model: env.AI_MODEL || 'deepseek-v4-flash',
  });
  return parsed;
}

// ============ AI Parse STRUK (foto/gambar via MiniMax-M3, fallback mimo) ============
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
- items: BREAKDOWN SEMUA produk yang dibeli dengan harga masing-masing. PENTING: jangan gabung, satu produk = satu entry. Contoh "SUSU DANCOW 25.000, ROTI TAWAR 15.000, SABUN 12.000" → items=[{"name":"susu dancow","amount":25000},{"name":"roti tawar","amount":15000},{"name":"sabun","amount":12000}].
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

// ============ Command Handlers ============
async function handleCatat(env, userId, scope, type, amount, category, note, date, item) {
  await env.DB.prepare(
    'INSERT INTO transactions (user_id, scope, type, amount, category, note, tx_date, item) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(userId, scope, type, amount, category, note || null, date || todayStr(), item || null).run();
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

  // riwayat_prev_<page> / riwayat_next_<page> → ganti pesan riwayat
  if (data.startsWith('riwayat_prev_') || data.startsWith('riwayat_next_')) {
    const cur = parseInt(data.split('_').pop()) || 1;
    const page = data.startsWith('riwayat_prev_') ? Math.max(1, cur - 1) : cur + 1;
    const PER_PAGE = 10;
    const offset = (page - 1) * PER_PAGE;
    const totalRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?').bind(userId).first();
    const total = totalRow?.c || 0;
    const maxPage = Math.max(1, Math.ceil(total / PER_PAGE));
    const rows = await env.DB.prepare(
      'SELECT id, scope, type, amount, category, tx_date, note FROM transactions WHERE user_id = ? ORDER BY tx_date DESC, id DESC LIMIT ? OFFSET ?'
    ).bind(userId, PER_PAGE, offset).all();
    let out = `📒 <b>Riwayat (hal ${page}/${maxPage}, total ${total})</b>\n`;
    for (const r of rows.results || []) {
      const icon = r.type === 'income' ? '⬆️' : '⬇️';
      const sc = r.scope === 'keluarga' ? '🏠' : '🙋';
      out += `<code>#${r.id}</code> ${sc} ${icon} ${r.category}: ${rupiah(r.amount)} · ${r.tx_date}\n`;
    }
    out += `\nHapus: <code>/hapus #id</code>\nEdit: <code>/edit #id 30000</code>`;
    const kb = { inline_keyboard: [] };
    const nav = [];
    if (page > 1) nav.push({ text: '⬅️ Seb', callback_data: `riwayat_prev_${page}` });
    if (page < maxPage) nav.push({ text: 'Berikut ➡️', callback_data: `riwayat_next_${page}` });
    if (nav.length) kb.inline_keyboard.push(nav);
    await editMessageKb(env, chatId, cb.message.message_id, out.trim(), kb);
    return answerCallback(env, cb.id, `Hal ${page}/${maxPage}`);
  }

  await answerCallback(env, cb.id, 'OK');
}

async function handleMessage(env, msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  let text = (msg.text || '').trim();

  if (!isWhitelisted(userId)) {
    return sendMessage(env, chatId, 'Maaf, bot ini khusus keluarga 😊');
  }

  const name = WHITELIST[userId];

  // ==== Handler FOTO STRUK ====
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1]; // resolusi tertinggi
    await sendMessage(env, chatId, '🧾 Baca struk...');
    try {
      // 1. Ambil file dari Telegram
      const fileRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${photo.file_id}`);
      const fileData = await fileRes.json();
      const filePath = fileData?.result?.file_path;
      if (!filePath) throw new Error('getFile gagal: ' + JSON.stringify(fileData));

      // 2. Download file
      const dl = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`);
      if (!dl.ok) throw new Error('Download file gagal: ' + dl.status);
      const buf = await dl.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      if (base64.length > 2_000_000) {
        return sendMessage(env, chatId, 'Foto kegedean, kirim yang lebih kecil ya 😅');
      }

      // 3. AI parse struk (MiniMax-M3 vision)
      const userRow = await env.DB.prepare('SELECT scope FROM users WHERE telegram_id = ?').bind(userId).first();
      const defaultScope = userRow?.scope || 'keluarga';
      const parsed = await aiParseStruk(env, base64, defaultScope);
      if (!parsed || !parsed.amount) {
        return sendMessage(env, chatId, 'Gagal baca struknya 😅 Coba foto yang lebih jelas, atau ketik manual: <code>makan 25rb</code>');
      }

      const scope = parsed.scope || defaultScope;
      const type = parsed.type || 'expense';
      const category = matchCategory(parsed.category, scope) || 'Lainnya';
      const date = parsed.date || todayStr();

      // 4. Konfirmasi dulu sebelum simpan
      // Normalisasi items: filter amount valid, min Rp5rb, max 8 item, urut terbesar
      let items = Array.isArray(parsed.items) ? parsed.items : [];
      items = items
        .filter(i => i && typeof i.amount === 'number' && i.amount > 0)
        .map(i => ({ name: String(i.name || 'item').trim().toLowerCase() || 'item', amount: Math.round(i.amount) }))
        .filter(i => i.amount >= 5000)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 8);

      await env.DB.prepare(
        'INSERT OR REPLACE INTO pending_input (telegram_id, action, scope, category, data) VALUES (?, ?, ?, ?, ?)'
      ).bind(userId, 'confirm_struk', scope, category, JSON.stringify({ type, amount: parsed.amount, date, items })).run();

      const icon = type === 'income' ? '⬆️' : '⬇️';
      let msg = `📸 Aku baca struknya:\n` +
        `${scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'} · ${icon} ${category} · <b>${rupiah(parsed.amount)}</b>`;

      // Tampilkan breakdown item kalau ada (dan expense)
      if (items.length > 1 && type === 'expense') {
        msg += `\n\n🛒 <b>Item (${items.length}):</b>`;
        for (const it of items) {
          msg += `\n  • ${it.name.charAt(0).toUpperCase() + it.name.slice(1)} — ${rupiah(it.amount)}`;
        }
        msg += `\n\n<i>Ketik <b>ok</b> buat simpan semua item, atau <b>batal</b>.</i>`;
      } else {
        msg += `\n\nKetik <b>ok</b> buat simpan, atau ketik koreksi (misal: <code>prib jajan</code>)`;
      }
      return sendMessage(env, chatId, msg);
    } catch (err) {
      console.error('Foto error:', err);
      return sendMessage(env, chatId, '⚠️ Gagal proses foto. Coba lagi atau ketik manual.');
    }
  }

  // ==== Cek pending input (flow budget interaktif + konfirmasi struk) ====
  const pending = await env.DB.prepare('SELECT * FROM pending_input WHERE telegram_id = ?')
    .bind(userId).first();
  if (pending) {
    // confirm_struk: tangani ok/batal DULU (teks bebas, bukan angka)
    if (pending.action === 'confirm_struk') {
      const low = text.toLowerCase();
      if (low === 'ok' || low === 'y' || low === 'iya' || low === 'bener' || low === 'benar' || low === 'simpan') {
        const d = JSON.parse(pending.data || '{}');
        // Simpan semua item sebagai transaksi terpisah kalau ada breakdown
        if (d.items && d.items.length > 1 && d.type === 'expense') {
          const sum = d.items.reduce((s, i) => s + (i.amount || 0), 0);
          const diff = (d.amount || 0) - sum; // selisih total vs items (diskon/pajak/item <5rb)
          const saved = [];
          for (const it of d.items) {
            await handleCatat(env, userId, pending.scope, 'expense', it.amount, pending.category, `struk: ${it.name}`, d.date || todayStr(), it.name);
            saved.push(it.name);
          }
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
        // Tanpa breakdown → simpan 1 transaksi (perilaku lama)
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
      // Selain ok/batal = ketik manual baru (parse teks biasa)
      await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
      text = low; // lanjut ke free-text parse di bawah
    }

    // confirm_hapus: tangani ya/batal
    if (pending.action === 'confirm_hapus') {
      const low = text.toLowerCase();
      const d = JSON.parse(pending.data || '{}');
      const id = d.id;
      if (low === 'ya' || low === 'y' || low === 'iya' || low === 'hapus' || low === 'yakin') {
        const res = await env.DB.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?')
          .bind(id, userId).run();
        await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
        if (res.meta.changes > 0) {
          return sendMessage(env, chatId, `🗑️ Transaksi #${id} dihapus.`);
        }
        return sendMessage(env, chatId, `❌ Transaksi #${id} gak ditemukan (atau sudah terhapus).`);
      }
      if (low === 'batal' || low === 'cancel' || low === 'ga jadi' || low === 'gajadi') {
        await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
        return sendMessage(env, chatId, '🗑️ Dibatalin, transaksi gak dihapus.');
      }
      // Selain ya/batal → batalkan konfirmasi
      await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
      return sendMessage(env, chatId, '⚠️ Penghapusan dibatalkan. Ketik <b>batal</b> kalau mau membatalkan.');
    }

    // confirm_edit: user balas perubahan (nominal / kategori / keduanya)
    if (pending.action === 'confirm_edit') {
      const low = text.toLowerCase();
      if (low === 'batal' || low === 'cancel' || low === 'ga jadi' || low === 'gajadi') {
        await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
        return sendMessage(env, chatId, '✏️ Edit dibatalkan.');
      }
      const d = JSON.parse(pending.data || '{}');
      const id = d.id;
      const existing = await env.DB.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?')
        .bind(id, userId).first();
      if (!existing) {
        await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
        return sendMessage(env, chatId, `❌ Transaksi #${id} gak ditemukan.`);
      }
      const amountMatch = text.match(/(\d+(?:[.,]\d+)?\s*(?:rb|k|jt|j|ribu|juta)?)$/i);
      const amount = amountMatch ? parseAmount(amountMatch[1]) : null;
      const catPart = amountMatch ? text.slice(0, text.length - amountMatch[0].length).trim() : text.trim();
      if (amount) {
        await env.DB.prepare('UPDATE transactions SET amount = ? WHERE id = ?').bind(amount, id).run();
      }
      if (catPart) {
        const cat = matchCategory(catPart, existing.scope) || catPart;
        await env.DB.prepare('UPDATE transactions SET category = ? WHERE id = ?').bind(cat, id).run();
      }
      if (!amount && !catPart) {
        await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
        return sendMessage(env, chatId, '⚠️ Gak ada perubahan. Ketik nominal/kategori, atau <b>batal</b>.');
      }
      await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
      return sendMessage(env, chatId, `✅ Transaksi #${id} diupdate`);
    }

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
      await env.DB.prepare('DELETE FROM pending_input WHERE telegram_id = ?').bind(userId).run();
      return sendMessage(env, chatId,
        `✅ Budget ${pending.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'} · ${pending.category} = ${rupiah(amount)}`);
    }

    return sendMessage(env, chatId, '⚠️ Ada pending input yang belum selesai. Ketik <b>batal</b> atau tunggu sebentar.');
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
      `/riwayat — transaksi (pakai tombol ➡️ utk halaman berikutnya)\n` +
      `/hapus #12 — hapus transaksi (ID dari /riwayat, ada konfirmasi)\n` +
      `/edit #12 — lihat rincian lalu edit (atau /edit #12 30000)\n` +
      `/harga pampers — riwayat harga item (deteksi kenaikan)\n` +
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
  // /riwayat → halaman 1 (terbaru)
  // /riwayat <n> → halaman n (pagination)
  // /riwayat_prev <n> / /riwayat_next <n> → navigasi via inline keyboard
  const PER_PAGE = 10;
  const isRiwayat = text === '/riwayat' || text.startsWith('/riwayat ') ||
                    text.startsWith('/riwayat_prev ') || text.startsWith('/riwayat_next ');
  if (isRiwayat) {
    let page = 1;
    if (text.startsWith('/riwayat ')) page = parseInt(text.split(' ')[1]) || 1;
    else if (text.startsWith('/riwayat_prev ')) page = Math.max(1, (parseInt(text.split(' ')[1]) || 2) - 1);
    else if (text.startsWith('/riwayat_next ')) page = parseInt(text.split(' ')[1]) + 1;
    page = Math.max(1, page);
    const offset = (page - 1) * PER_PAGE;

    // Total count buat tahu halaman maksimum
    const totalRow = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?'
    ).bind(userId).first();
    const total = totalRow?.c || 0;
    const maxPage = Math.max(1, Math.ceil(total / PER_PAGE));

    const rows = await env.DB.prepare(
      'SELECT id, scope, type, amount, category, tx_date, note FROM transactions WHERE user_id = ? ORDER BY tx_date DESC, id DESC LIMIT ? OFFSET ?'
    ).bind(userId, PER_PAGE, offset).all();

    if (!rows.results?.length) return sendMessage(env, chatId, 'Belum ada transaksi.');

    let out = `📒 <b>Riwayat (hal ${page}/${maxPage}, total ${total})</b>\n`;
    for (const r of rows.results) {
      const icon = r.type === 'income' ? '⬆️' : '⬇️';
      const sc = r.scope === 'keluarga' ? '🏠' : '🙋';
      out += `<code>#${r.id}</code> ${sc} ${icon} ${r.category}: ${rupiah(r.amount)} · ${r.tx_date}\n`;
    }
    out += `\nHapus: <code>/hapus #id</code>\nEdit: <code>/edit #id 30000</code>`;

    // Inline keyboard navigasi
    const kb = { inline_keyboard: [] };
    const nav = [];
    if (page > 1) nav.push({ text: '⬅️ Seb', callback_data: `riwayat_prev_${page}` });
    if (page < maxPage) nav.push({ text: 'Berikut ➡️', callback_data: `riwayat_next_${page}` });
    if (nav.length) kb.inline_keyboard.push(nav);

    return sendMessageKb(env, chatId, out.trim(), kb);
  }

  // ==== /hapus — 2-step: tampilkan detail + minta konfirmasi ====
  if (text === '/hapus' || text.startsWith('/hapus ')) {
    const arg = text.replace('/hapus', '').trim().replace(/^#/, ''); // buang # kalau ada
    // Hanya izinkan angka (dan optional #). Kalau ada huruf/kata → tolak.
    if (!arg || !/^\d+$/.test(arg)) {
      return sendMessage(env, chatId,
        `⚠️ Format salah. Hapus pakai ID dari /riwayat:\n\n` +
        `<code>/hapus #12</code> atau <code>/hapus 12</code>\n\n` +
        `ID transaksi: 12 (bukan kata/keterangan).`);
    }
    const id = parseInt(arg, 10);
    // Ambil detail dulu buat ditampilkan
    const tx = await env.DB.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?')
      .bind(id, userId).first();
    if (!tx) {
      return sendMessage(env, chatId, `❌ Transaksi #${id} gak ditemukan (atau bukan punyamu). Cek /riwayat buat ID yang bener.`);
    }
    const icon = tx.type === 'income' ? '⬆️' : '⬇️';
    const tgl = (tx.tx_date || '').slice(0, 10);
    // Simpan state konfirmasi
    await env.DB.prepare(
      'INSERT OR REPLACE INTO pending_input (telegram_id, action, scope, category, data) VALUES (?, ?, ?, ?, ?)'
    ).bind(userId, 'confirm_hapus', tx.scope, '', JSON.stringify({ id })).run();
    return sendMessage(env, chatId,
      `🗑️ <b>Yakin hapus transaksi ini?</b>\n\n` +
      `${icon} #${id} · ${tx.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'} · ${tx.category}\n` +
      `💰 <b>${rupiah(tx.amount)}</b> · 📅 ${tgl}\n` +
      `${tx.note ? `📝 ${tx.note}\n` : ''}\n` +
      `Ketik <b>ya</b> buat hapus, atau <b>batal</b>.`);
  }

  if (text.startsWith('/edit ')) {
    const parts = text.replace('/edit', '').trim().split(/\s+/);
    const id = parseInt(parts[0].replace(/[^0-9]/g, ''));
    if (!id) {
      return sendMessage(env, chatId, 'Format: /edit #123 30000 atau /edit #123 makan 30000');
    }
    // cek punya user
    const existing = await env.DB.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?')
      .bind(id, userId).first();
    if (!existing) return sendMessage(env, chatId, `❌ Transaksi #${id} gak ditemukan (atau bukan punyamu)`);

    // Mode 1: /edit #id TANPA value → tampilkan rincian, tunggu input
    if (parts.length < 2) {
      const icon = existing.type === 'income' ? '⬆️' : '⬇️';
      const tgl = (existing.tx_date || '').slice(0, 10);
      await env.DB.prepare(
        'INSERT OR REPLACE INTO pending_input (telegram_id, action, scope, category, data) VALUES (?, ?, ?, ?, ?)'
      ).bind(userId, 'confirm_edit', existing.scope, '', JSON.stringify({ id })).run();
      return sendMessage(env, chatId,
        `✏️ <b>Rincian #${id}:</b>\n` +
        `${icon} ${existing.scope === 'keluarga' ? '🏠 Keluarga' : '🙋 Pribadi'} · ${existing.category}\n` +
        `💰 <b>${rupiah(existing.amount)}</b> · 📅 ${tgl}\n` +
        `${existing.note ? `📝 ${existing.note}\n` : ''}\n` +
        `Ketik perubahan, misal:\n` +
        `• <code>30000</code> (ubah nominal)\n` +
        `• <code>makan</code> (ubah kategori)\n` +
        `• <code>30000 makan</code> (keduanya)\n` +
        `Atau <b>batal</b>.`);
    }

    // Mode 2: /edit #id <value> → langsung update (backward compatible)
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

  // ==== /harga <item> — riwayat harga + deteksi kenaikan ====
  if (text === '/harga' || text.startsWith('/harga ')) {
    const q = text.replace('/harga', '').trim().toLowerCase();
    if (!q) {
      return sendMessage(env, chatId,
        `Format: <code>/harga pampers</code>\n\n` +
        `Cari riwayat harga item dari catatanmu. Contoh: /harga pertalite, /harga sweety`);
    }
    const rows = await env.DB.prepare(
      `SELECT id, scope, amount, category, note, item, tx_date FROM transactions
       WHERE user_id = ? AND (LOWER(item) LIKE ? OR LOWER(note) LIKE ?)
       ORDER BY tx_date ASC, id ASC LIMIT 50`
    ).bind(userId, `%${q}%`, `%${q}%`).all();
    if (!rows.results?.length) {
      return sendMessage(env, chatId,
        `Gak ada riwayat "<b>${q}</b>" di catatanmu.\n` +
        `Coba kata lain, atau mulai catat dengan nama item, contoh: <code>pampers sweety 55rb</code>`);
    }
    // Kelompokkan per item unik (utamakan kolom item, fallback note)
    const byItem = {};
    for (const r of rows.results) {
      const key = (r.item || r.note || '').toLowerCase();
      if (!byItem[key]) byItem[key] = [];
      byItem[key].push(r);
    }
    let out = `📈 <b>Riwayat "${q}" (${rows.results.length} catatan)</b>\n`;
    for (const [key, list] of Object.entries(byItem)) {
      const prices = list.map(r => r.amount);
      const min = Math.min(...prices), max = Math.max(...prices);
      const first = list[0], last = list[list.length - 1];
      const delta = last.amount - first.amount;
      const pct = first.amount > 0 ? (delta / first.amount) * 100 : 0;
      const trend = delta > 0 ? `📈 naik ${rupiah(delta)} (${pct.toFixed(0)}%)` :
        delta < 0 ? `📉 turun ${rupiah(Math.abs(delta))}` : '➡️ stabil';
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      out += `\n<b>${label}</b> · ${list.length}x · ${rupiah(min)}–${rupiah(max)}\n`;
      for (const r of list.slice(-5)) {
        const sc = r.scope === 'keluarga' ? '🏠' : '🙋';
        out += `  ${sc} ${rupiah(r.amount)} · ${r.tx_date}\n`;
      }
      if (list.length >= 2) out += `  ${trend}\n`;
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
  // Guard: teks diawali "/" tapi bukan command dikenal → jangan masuk AI parse
  // (mencegah "hapus makan 25rb" salah dicatat sebagai transaksi)
  const KNOWN_CMDS = ['/start', '/help', '/sisa', '/rekap', '/analisis', '/budget', '/riwayat',
    '/hapus', '/edit', '/kategori', '/saldo', '/setprib', '/setkel', '/harga'];
  if (text.startsWith('/') && !KNOWN_CMDS.some(c => text === c || text.startsWith(c + ' '))) {
    return sendMessage(env, chatId,
      `❓ Command <code>${text.split(' ')[0]}</code> gak dikenal.\n` +
      `Ketik /help buat lihat semua perintah.`);
  }

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

    await handleCatat(env, userId, scope, type, parsed.amount, category, text, date, parsed.item || null);

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
