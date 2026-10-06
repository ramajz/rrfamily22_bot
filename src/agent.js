// ── RRFamily v3 Agent (M1) ─────────────────────────────────────────────
// Intent router + read-only tools via Syncera (native Anthropic API).
// Dipanggil dari handleMessage SETELAH pending/command/state-flow,
// SEBELUM parser lama (regexParse/aiParse) sebagai fallback.
//
// Guardrail PRD v3:
//  - Hanya tool READ yang ada di M1 (write tetap flow lama + konfirmasi)
//  - Semua angka dijawab dari hasil query D1, bukan karangan model
//  - Jangan pernah mencetak API key ke log

const AGENT_MAX_TOOLS = 5; // anti-loop per pesan

// Helper lokal — todayStr di index.js tidak di-export (hindari circular import)
// Format YYYY-MM-DD zona WIB (UTC+7)
function todayStr() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

// DDL ringkas untuk system prompt — diambil dari sqlite_master (otomatis ikut skema)
async function getSchema(db) {
  const res = await db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all();
  return (res.results || [])
    .map((r) => r.sql)
    .filter(Boolean)
    .join('\n\n');
}

const AGENT_SYSTEM = `Kamu adalah asisten keuangan keluarga RRFamily di Telegram.
Kamu punya akses tools READ-ONLY ke database pengguna.

Aturan keras:
1. Angka (rupiah, jumlah, tanggal) HARUS dari hasil tool. Jangan pernah mengarang angka.
2. Jika tool gagal atau hasil kosong, bilang apa adanya — jangan mengkarang.
3. Jawab ringkas, bahasa Indonesia santai, format Telegram HTML (<b>, <code>).
4. Untuk CATAT transaksi: pakai tool siapkan_draft (SISTEM yang menampilkan konfirmasi tombol). Sebut di jawaban teks kalau ada transaksi lain di pesan yang sama (staged draft hanya untuk yang pertama). Untuk edit/hapus/set budget pakai [FALLBACK].
5. Sebut satuan penuh (rupiah), jangan pakai format aneh.
6. Untuk pertanyaan analitis/apapun yang butuh query data bebas, pakai tool tanya_data.
   Tulis SATU query SELECT/WITH SQLite yang valid. Jika query ditolak atau error,
   boleh revisi MAKSIMAL 1x; kalau gagal lagi, jawab jujur "data tidak ditemukan".`;

// Wrapper Syncera — native Anthropic Messages API
async function callClaude(env, { system, messages, tools }) {
  const endpoint = env.AGENT_ENDPOINT || 'https://api.syncera.id/anthropic';
  const key = env.AGENT_API_KEY;
  const model = env.AGENT_MODEL || 'claude-sonnet-5';
  if (!key) throw new Error('AGENT_API_KEY tidak diset');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(endpoint + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system,
        messages,
        ...(tools && tools.length ? { tools } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Syncera ${res.status}: ${err.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Tools M1 (READ ONLY) ───────────────────────────────────────────────
const TOOLS = [
  {
    name: 'cek_budget',
    description:
      'Cek budget bulan ini: nominal budget, total terpakai, dan sisa. scope: keluarga | pribadi',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['keluarga', 'pribadi'] },
      },
      required: ['scope'],
    },
  },
  {
    name: 'riwayat',
    description:
      'Daftar transaksi terakhir. scope opsional, days = rentang hari terakhir (default 7), limit maks 20.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['keluarga', 'pribadi'] },
        days: { type: 'integer', minimum: 1, maximum: 90 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
  },
  {
    name: 'cari_transaksi',
    description: 'Cari transaksi berdasarkan kata kunci (note, item, atau kategori).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'harga_item',
    description:
      'Riwayat harga suatu item/kata kunci: min, max, 5 entri terakhir, dan tren (naik/turun/stabil).',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'siapkan_draft',
    description:
      'Untuk MENYIMPAN transaksi (catat): siapkan satu draft transaksi. ' +
      'Sistem akan menampilkan ringkasan + tombol konfirmasi ke user. ' +
      'Panggil SATU draft per pesan. Jika pesan berisi lebih dari satu transaksi, ' +
      'siapkan yang pertama saja dan sebutkan sisanya di jawaban teks (user mengirim lagi setelah konfirmasi).',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['expense', 'income'] },
        amount: { type: 'integer', description: 'Nominal dalam rupiah (angka bulat)' },
        scope: { type: 'string', enum: ['keluarga', 'pribadi'] },
        category: { type: 'string', description: 'Kategori, mis. Makan, Transport, Jajan' },
        note: { type: 'string', description: 'Catatan/item singkat' },
        date: { type: 'string', description: 'YYYY-MM-DD, default hari ini' },
      },
      required: ['type', 'amount', 'scope', 'category'],
    },
  },
  {
    name: 'tanya_data',
    description:
      'Jalankan query SQL HANYA-READ (SELECT atau WITH) untuk pertanyaan analitis bebas. ' +
      'Tulis satu query SQLite yang benar sesuai skema database. Guard akan menolak non-SELECT, ' +
      'menambah LIMIT otomatis, dan query yang gagal boleh direvisi 1x.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Satu statement SELECT atau WITH (SQLite dialect)' },
        alasan: { type: 'string', description: 'Singkat: apa yang dijawab query ini' },
      },
      required: ['sql'],
    },
  },
];

// Eksekusi tool → hasil JSON string (yang dikirim balik ke model sebagai tool_result)
async function runTool(env, userId, name, args) {
  const db = env.DB;
  const ymd = (d) => d.toISOString().slice(0, 10); // fallback simple

  if (name === 'cek_budget') {
    const scope = args.scope;
    const budget = await db
      .prepare('SELECT amount FROM budgets WHERE scope = ?')
      .bind(scope)
      .first();
    const row = await db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) AS used FROM transactions WHERE user_id = ? AND scope = ? AND type = 'expense' AND substr(tx_date,1,7) = substr(?,1,7)"
      )
      .bind(userId, scope, todayStr())
      .first();
    return JSON.stringify({
      scope,
      budget: budget ? budget.amount : null,
      used: row?.used || 0,
      remaining: budget ? budget.amount - (row?.used || 0) : null,
      periode: todayStr().slice(0, 7),
    });
  }

  if (name === 'riwayat') {
    const days = Math.min(Math.max(args.days || 7, 1), 90);
    const limit = Math.min(Math.max(args.limit || 10, 1), 20);
    const sql = args.scope
      ? 'SELECT id, type, category, note, item, amount, tx_date, scope FROM transactions WHERE user_id = ? AND scope = ? AND tx_date >= date(?, ?) ORDER BY id DESC LIMIT ?'
      : 'SELECT id, type, category, note, item, amount, tx_date, scope FROM transactions WHERE user_id = ? AND tx_date >= date(?, ?) ORDER BY id DESC LIMIT ?';
    const binds = args.scope
      ? [userId, args.scope, todayStr(), `-${days} days`, limit]
      : [userId, todayStr(), `-${days} days`, limit];
    const res = await db.prepare(sql).bind(...binds).all();
    return JSON.stringify({ days, rows: res.results || [] });
  }

  if (name === 'cari_transaksi') {
    const q = String(args.query || '').trim().slice(0, 60);
    if (!q) return JSON.stringify({ rows: [], note: 'query kosong' });
    const res = await db
      .prepare(
        'SELECT id, type, category, note, item, amount, tx_date, scope FROM transactions WHERE user_id = ? AND (LOWER(COALESCE(note,"")) LIKE ? OR LOWER(COALESCE(item,"")) LIKE ? OR LOWER(category) LIKE ?) ORDER BY id DESC LIMIT 15'
      )
      .bind(userId, `%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`)
      .all();
    return JSON.stringify({ query: q, rows: res.results || [] });
  }

  if (name === 'harga_item') {
    const kw = String(args.keyword || '').trim().toLowerCase().slice(0, 60);
    if (!kw) return JSON.stringify({ note: 'keyword kosong' });
    const res = await db
      .prepare(
        'SELECT amount, tx_date FROM transactions WHERE user_id = ? AND type = ? AND (LOWER(COALESCE(item,"")) LIKE ? OR LOWER(COALESCE(note,"")) LIKE ?) ORDER BY id DESC LIMIT 50'
      )
      .bind(userId, 'expense', `%${kw}%`, `%${kw}%`)
      .all();
    const rows = res.results || [];
    if (!rows.length) return JSON.stringify({ keyword: kw, rows: [] });
    const amounts = rows.map((r) => r.amount);
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    const last5 = rows.slice(0, 5);
    // tren dari 5 terakhir (terbaru dulu): bandingkan paruh awal vs akhir
    let trend = 'stabil';
    if (last5.length >= 4) {
      const newer = (last5[0].amount + (last5[1]?.amount || 0)) / (last5[1] ? 2 : 1);
      const older = (last5[last5.length - 1].amount + last5[last5.length - 2].amount) / 2;
      if (newer > older * 1.1) trend = 'naik';
      else if (newer < older * 0.9) trend = 'turun';
    }
    return JSON.stringify({ keyword: kw, count: rows.length, min, max, trend, last5 });
  }


  if (name === 'siapkan_draft') {
    // tulis ke pending_input sebagai draft (action catat_draft) — sama dengan saveDraft()
    // transaksi BELUM masuk transactions; butuh konfirmasi tombol draft_save
    const type = args.type === 'income' ? 'income' : 'expense';
    const amount = Math.round(Number(args.amount) || 0);
    const scope = args.scope === 'pribadi' ? 'pribadi' : 'keluarga';
    const category = String(args.category || 'Lainnya').slice(0, 40);
    const note = String(args.note || '').slice(0, 120);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date || '')) ? args.date : todayStr();
    if (amount <= 0) return JSON.stringify({ error: 'amount tidak valid' });
    const draft = { type, amount, scope, category, note, date };
    await db
      .prepare(
        'INSERT OR REPLACE INTO pending_input (telegram_id, action, scope, category, data) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(userId, 'catat_draft', scope, category, JSON.stringify(draft))
      .run();
    return JSON.stringify({ staged: true, draft });
  }

  if (name === 'tanya_data') {
    const guard = sqlGuard(String(args.sql || ''));
    if (guard.rejected) return JSON.stringify({ error: guard.reason, ditolak_oleh: 'sql_guard' });
    const res = await db.prepare(guard.sql).all();
    const rows = (res.results || []).slice(0, 100);
    return JSON.stringify({ query: guard.sql, alasan: args.alasan || null, row_count: rows.length, rows });
  }

  return JSON.stringify({ error: `tool tidak dikenal: ${name}` });
}

// ── SQL Guard (PRD 5.5) — di KODE, bukan di prompt ────────────────────
// Cuma SELECT/WITH yang lolos; auto-LIMIT; blokir statement berbahaya.
function sqlGuard(raw) {
  let q = String(raw || '').trim();
  if (!q) return { rejected: true, reason: 'query kosong' };

  // buang komentar SQL dulu (// dan /* */ dan --), tapi HANYA jika tidak di dalam string.
  // Pendekatan konservatif: tolak query yang mengandung komentar baris/block yang mencurigakan
  // bersamaan dengan keyword berbahaya — cukup aman untuk use case rumah tangga.
  const noComment = q.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

  // Lapis 1: harus diawali SELECT atau WITH (setelah trim)
  const head = noComment.trimStart().toUpperCase();
  if (!(head.startsWith('SELECT') || head.startsWith('WITH'))) {
    return { rejected: true, reason: 'hanya query SELECT/WITH yang diizinkan' };
  }

  // Lapis 2: blokir keyword tulis/destruktif di posisi statement (split semicolon)
  const banned = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|CREATE|GRANT|REVOKE)\b/i;
  // izinkan kata-kata yang muncul di dalam string literal? cukup aman karena kasus kita terbatas:
  // kalau ada keyword banned di luar string, tolak.
  if (banned.test(noComment)) {
    return { rejected: true, reason: 'query mengandung operasi non-READ (ditolak guard)' };
  }

  // Lapis 3: auto-LIMIT
  let finalQ = noComment.replace(/;+\s*$/, '').trim();
  if (!/\bLIMIT\s+\d+/i.test(finalQ)) {
    finalQ += ' LIMIT 100';
  } else {
    // clamp LIMIT > 1000
    finalQ = finalQ.replace(/\bLIMIT\s+(\d+)/i, (m, n) => {
      const num = parseInt(n, 10);
      return num > 1000 ? 'LIMIT 1000' : `LIMIT ${num}`;
    });
  }
  if (finalQ.length > 4000) return { rejected: true, reason: 'query terlalu panjang' };
  return { rejected: false, sql: finalQ };
}

// ── Chat history (M3) ──────────────────────────────────────────────────
const HISTORY_MAX = 12;   // pesan terakhir yang dikirim sebagai konteks
const HISTORY_KEEP = 100; // total baris disimpan per user

async function loadHistory(db, userId) {
  try {
    const res = await db
      .prepare(
        'SELECT role, content FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT ?'
      )
      .bind(userId, HISTORY_MAX)
      .all();
    // dibalik jadi urut kronologis
    return (res.results || []).reverse().map((r) => ({ role: r.role, content: r.content }));
  } catch {
    return []; // tabel belum ada / error → konteks kosong (gak fatal)
  }
}

async function saveHistory(db, userId, userText, assistantText) {
  try {
    const now = new Date().toISOString();
    await db
      .prepare(
        'INSERT INTO chat_history (user_id, role, content, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)'
      )
      .bind(
        userId, 'user', String(userText).slice(0, 1000), now,
        userId, 'assistant', String(assistantText).slice(0, 2000), now
      )
      .run();
    // trim: sisakan HISTORY_KEEP terakhir
    await db
      .prepare(
        'DELETE FROM chat_history WHERE user_id = ? AND id NOT IN (SELECT id FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT ?)'
      )
      .bind(userId, userId, HISTORY_KEEP)
      .run();
  } catch {
    // history gagal simpan tidak boleh menggagalkan balasan
  }
}

// ── Router utama M1 ────────────────────────────────────────────────────
// reply = fungsi dari index.js untuk kirim pesan + keyboard
//         (menghindari circular import antara index.js <-> agent.js)
// Return: true = pesan sudah ditangani agent, false = lanjut ke parser lama.
async function runAgent(env, msg, text, reply) {
  let schema;
  try {
    schema = await getSchema(env.DB);
  } catch {
    return false; // fallback parser lama
  }

  const system = AGENT_SYSTEM + '\n\nSkema database (SQLite):\n' + schema;
  const userId = String(msg.from.id);
  const history = await loadHistory(env.DB, userId);
  // guard: history tidak boleh diakhiri 'user' (bikin dua user berurutan → API tolak)
  while (history.length && history[history.length - 1].role === 'user') history.pop();
  const messages = [...history, { role: 'user', content: text }];
  let stagedDraft = false; // M4: ada draft siap konfirmasi?

  try {
    let resp = await callClaude(env, { system, messages, tools: TOOLS });
    let steps = 0;

    // Loop tool-call sampai jawaban final (guard: max AGENT_MAX_TOOLS)
    while (
      steps < AGENT_MAX_TOOLS &&
      resp.content &&
      resp.content.some((b) => b.type === 'tool_use')
    ) {
      steps++;
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        if (block.name === 'siapkan_draft') { stagedDraft = true; }
        let out;
        try {
          out = await runTool(env, String(msg.from.id), block.name, block.input || {});
        } catch (e) {
          out = JSON.stringify({ error: String(e && e.message ? e.message : e).slice(0, 300) });
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: out,
        });
      }
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user', content: toolResults });
      resp = await callClaude(env, { system, messages, tools: TOOLS });
    }

    const finalText = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!finalText) return false; // model gak jawab → fallback
    if (finalText.includes('[FALLBACK]')) {
      console.log('[agent] niat tulis -> FALLBACK ke parser lama');
      return false;
    }

    console.log(`[agent] tool_calls=${steps} stagedDraft=${stagedDraft} reply="${finalText.slice(0, 120)}"`);
    await saveHistory(env.DB, userId, text, finalText);
    await reply(msg.chat.id, finalText, stagedDraft ? 'draft' : null);
    return true;
  } catch (err) {
    // AI gagal/timeout → SILENT fallback ke parser lama (jangan tampilkan error)
    console.error('agent error:', err && err.message ? err.message : err);
    return false;
  }
}

export { runAgent, sqlGuard };
