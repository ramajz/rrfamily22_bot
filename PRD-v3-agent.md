# PRD — RRFamily Bot v3.0 "AI Agent"

> **Status:** DRAFT — siap untuk implementasi lokal (belum boleh deploy)
> **Dibuat:** 6 Oktober 2026
> **Branch:** `v3-agent` — **Restore point: tag `v2.1-stable`**
> **Tipe produk:** Personal, single-user household (Rama + istri). **TIDAK dikomersilkan.**

---

## 1. Problem & Purpose

Bot v2 (button-based + AI parse) sudah stabil: menu tombol, natural language untuk
catat transaksi, draft → konfirmasi → simpan, rekap, budget. **Tapi pemahamannya
sempit** — AI hanya dipakai untuk *mengekstrak field* dari format catatan
(`"beli susu 88rb"` → `{item, amount}`). Di luar format itu, user harus lewat
tombol atau command (`/riwayat`, `/sisa`, `/harga`).

Akibatnya user masih harus "ngomong sesuai bahasa bot" untuk banyak hal:
pertanyaan sederhana soal data sendiri tidak bisa ditanya bebas.

**Tujuan v3:** menambahkan **lapisan pemahaman (intent)** di awal — semua teks
bebas masuk, AI menafsirkan maksud, memanggil kemampuan yang tepat, lalu
menjawab dengan data nyata. Tombol dan command tetap ada; AI adalah lapisan
tambahan, bukan pengganti.

## 2. Scope & Ownership

- Personal use, rumah tangga Rama (whitelist 2 user — TIDAK berubah).
- Bukan SaaS, tanpa multi-user baru, tanpa monetisasi.
- Karena non-komersial: boleh pakai model berkualitas tinggi (Syncera/Anthropic
  proxy) tanpa tekanan biaya per-user.

## 3. Stack & Deployment

| Item | Nilai |
|------|-------|
| Runtime | Cloudflare Workers (Hono) |
| Database | Cloudflare D1 (SQLite) |
| LLM | **Syncera** — `https://api.syncera.id/anthropic` (native `/v1/messages`) |
| Model | Claude (via Syncera) — mendukung tool-calling |
| Deploy | `wrangler deploy` — **HANYA dari `main`** |
| Eksperimen | branch `v3-agent`, jangan deploy sebelum merge |

Keyenv: `ANTHROPIC_API_KEY` (Syncera) disimpan sebagai Cloudflare secret —
**jangan pernah dicetak di chat/log/fact_store.**

## 4. Keputusan Terkunci (jangan diubah tanpa diskusi)

1. **Struktur DB lama TIDAK berubah** — `users`, `categories`, `transactions`,
   `pending_input`, `budgets` tetap. Perubahan schema hanya ADDITIVE (tabel baru).
2. **Tulis uang = konfirmasi.** Flow draft → tombol `ok/batal` TETAP untuk semua
   aksi tulis (catat, edit, hapus, set_budget). AI boleh memahami niat, tetapi
   eksekusi selalu lewat konfirmasi user.
3. **Angka di jawaban = dari query D1.** AI tidak boleh mengarang nominal,
   saldo, atau statistik. Pola: query dulu → hasil masuk ke prompt AI → AI
   menyusun kalimat dari angka tersebut.
4. **Tombol & command lama tetap berfungsi** — AI adalah jalur alternatif, bukan
   pengganti. Regresi ke v2.1-stable harus selalu mungkin.
5. **Repo terpisah** gak perlu — satu repo, branch terpisah (sudah dibuat).

## 5. Fitur (MVP v3)

### 5.1 Intent Router (lapisan baru)
Semua pesan teks bebas masuk ke satu router AI sebelum handler lama.
Urutan prioritas (aman → berbahaya):

```
1. Pending state (confirm_struk, confirm_edit, ok/batal) → handler lama DAHULU
   (aturan lama: pending handler selalu paling atas — lesson 2026-08-06)
2. Command dikenal (/riwayat, /sisa, /harga, dll) → handler lama
3. Sisanya → AI intent router
4. Gagal/AI timeout → fallback ke handler parse lama (regexParse/aiParse)
```

### 5.2 Tools (kemampuan yang bisa dipanggil AI)

**Read (langsung, tanpa konfirmasi):**

| Tool | Sumber data |
|------|-------------|
| `cek_budget` | `budgets` + SUM(transactions bulan ini) |
| `riwayat` | `transactions` (paginated) |
| `cari_transaksi` | FTS/LIKE di `transactions` |
| `tanya_data` | **BARU** — query agregat bebas (rata-rata, total per kategori, tren bulanan) via pembungkus query terbatas |
| `harga_item` | logika `/harga` lama |

**Write (WAJIB lewat konfirmasi tombol ok/batal):**

| Tool | Aksi |
|------|------|
| `catat_transaksi` | draft → keyboard konfirmasi (flow lama) |
| `set_budget` | draft → konfirmasi |
| `edit_transaksi` / `hapus_transaksi` | alur konfirmasi lama |

### 5.3 Konteks percakapan (yang bikin "Level C")
- Tabel BARU `chat_history (id, user_id, role, content, created_at)` — additive,
  v2.1 tidak menyentuhnya.
- Simpan 10–20 pesan terakhir per user sebagai konteks prompt.
- Resolusi anaphora: "yang kemarin itu" → AI menemukan kandidat dari history +
  hasil `cari_transaksi`, lalu menawarkan (dengan konfirmasi untuk aksi tulis).
- Trim: simpan maksimal N baris (mis. 100/user), hapus yang terlama.

### 5.4 `tanya_data` — kemampuan baru
Pola query-terbatas, BUKAN SQL bebas dari AI:
- Daftar agregat yang diizinkan: total, jumlah, rata-rata, min/max, per kategori,
  per dompet, rentang tanggal.
- AI memilih parameter (kolom, filter, periode) → query dibangun oleh kode
  terstruktur (parameterized), bukan string SQL mentah dari model.
- Hasil query → AI menyusun jawaban natural.

**Mengapa bukan SQL bebas:** D1 dari prompt model = risiko error & kebocoran
struktur; query terbatas cukup untuk 95% pertanyaan rumah tangga.

## 6. Guardrail (wajib)

- Whitelist tetap — non-whitelist langsung ditolak (aturan lama).
- `--` / komentar SQL tidak pernah masuk dari teks user (parameterized only).
- Setiap aksi tulis: konfirmasi tombol. Tidak ada eksekusi write langsung dari
  AI.
- Semua angka dalam jawaban wajib berasal dari variabel hasil query — prompt
  system menegaskan: "JANGAN mengarang angka; kalau tidak ada datanya, bilang
  tidak ada."
- Rate/loop guard: maksimal N tool-call per pesan (mis. 5), lalu jawab dengan
  apa yang ada — cegah loop agent.

## 7. Data Model

**Tabel lama — TIDAK DIUBAH:**
`users, categories, transactions, pending_input, budgets`

**Tabel baru (additive):**
```sql
CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,          -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_history(user_id, id DESC);
```

## 8. Acceptance Criteria

- [ ] Pesan bebas "sisa budget pribadi berapa?" → jawaban dengan angka dari D1.
- [ ] "rata-rata beli makan per hari bulan ini" → `tanya_data` menjawab benar.
- [ ] "catat makan siang 35rb kemarin" → TETAP menampilkan keyboard konfirmasi
      (draft), bukan langsung simpan.
- [ ] "yang kemarin itu batal" → history dipahami, aksi diusulkan + konfirmasi.
- [ ] Tombol lama & command `/riwayat`, `/sisa`, `/harga` tetap berfungsi
      identik dengan v2.1.
- [ ] AI timeout/gagal → fallback ke parser lama (pesan tetap terlayani).
- [ ] User non-whitelist tetap ditolak.
- [ ] `node --check src/index.js` lolos sebelum setiap deploy.

## 9. Local Setup & Test

```bash
# jalankan lokal (wrangler dev) dengan secret:
# ANTHROPIC_API_KEY (Syncera), BOT_TOKEN, AI_* vars
npx wrangler dev
# test: kirim pesan langsung ke bot staging / synthetic POST ke /webhook
# assert ke D1 (bukan cuma {"ok":true}) — pola skill telegram-bot-webhook-debugging
```

Synthetic POST wajib menyertakan objek `message`/`callback_query` yang lengkap
(pitfall lama), dan baris test dibersihkan setelah assert.

## 10. Non-Goals (v3)

- BUKAN multi-user SaaS / komersialisasi.
- Bukan penghapusan tombol (UI tetap button-first).
- Bukan SQL bebas dari AI.
- Bukan migrasi DB.
- Bukan perubahan whitelist / arsitektur Hono-D1.
- Bukan deploy otomatis — merge ke main = keputusan sadar.

## 11. Do-Not-Touch (batas agent coding)

- `migrations/001`–`006` — jangan diubah (data existing).
- Alur konfirmasi draft (ok/batal) — jangan dilewati/disederhanakan.
- Whitelist & fungsi kirim pesan Telegram lama.
- Jangan `wrangler deploy` dari branch ini.
- Jangan mencetak API key/token ke mana pun.

## 12. Milestone

1. **M1 — Intent router + fallback** (tools read: budget, riwayat, cari).
2. **M2 — `tanya_data`** (agregat terstruktur).
3. **M3 — `chat_history` + konteks** (resolusi "yang kemarin").
4. **M4 — write tools via konfirmasi** (catat/set_budget lewat intent).
5. **Review → merge `main` → deploy.**
