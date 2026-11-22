require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET, optionalToken, requireRole } = require('../auth');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Bake Haus POS & Delivery API',
    timestamp: new Date().toISOString(),
  });
});

// Helper: Generate No Struk & No Antrian Harian
async function generateOrderMeta(client, idToko = 'T01', requestedNoStruk = null) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1), hashtext(to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD')))",
    [idToko]
  );
  const antrianRes = await client.query(
    `SELECT COALESCE(MAX(no_antrian), 0) + 1 AS next_antrian
     FROM transaksi
     WHERE id_toko = $1
       AND tanggal_waktu::date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date`,
    [idToko]
  );
  const noAntrian = antrianRes.rows[0].next_antrian;

  let noStruk = typeof requestedNoStruk === 'string' && /^#1-\d{5}$/.test(requestedNoStruk.trim())
    ? requestedNoStruk.trim()
    : '';
  if (noStruk) {
    const cek = await client.query('SELECT 1 FROM transaksi WHERE no_struk = $1', [noStruk]);
    if (cek.rows.length > 0) noStruk = '';
  }
  while (!noStruk) {
    const randSuffix = Math.floor(10000 + Math.random() * 90000);
    noStruk = `#1-${randSuffix}`;
    const cek = await client.query('SELECT 1 FROM transaksi WHERE no_struk = $1', [noStruk]);
    if (cek.rows.length > 0) noStruk = '';
  }

  return { noStruk, noAntrian };
}

async function deductMenuStock(client, idMenu, qty) {
  const result = await client.query(
    `UPDATE menu
     SET stok = CASE WHEN stok IS NULL THEN NULL ELSE stok - $2 END
     WHERE id_menu = $1 AND (stok IS NULL OR stok >= $2)
     RETURNING harga_satuan, diskon_persen, stok, is_aktif`,
    [idMenu, qty]
  );
  if (result.rows.length === 0) {
    const exists = await client.query('SELECT 1 FROM menu WHERE id_menu = $1', [idMenu]);
    if (!exists.rows.length) throw new Error(`Menu dengan ID ${idMenu} tidak ditemukan`);
    throw new Error(`Stok menu ${idMenu} tidak mencukupi`);
  }
  if (!result.rows[0].is_aktif) throw new Error(`Menu ${idMenu} tidak tersedia`);
  return result.rows[0];
}

async function saveMenuRelations(client, idMenu, labelIds, targetIds) {
  if (labelIds !== undefined) {
    await client.query('DELETE FROM menu_label WHERE id_menu = $1', [idMenu]);
    for (const idLabel of labelIds) {
      await client.query('INSERT INTO menu_label (id_menu, id_label) VALUES ($1, $2)', [idMenu, idLabel]);
    }
  }
  if (targetIds !== undefined) {
    await client.query('DELETE FROM addon_target_category WHERE id_menu = $1', [idMenu]);
    for (const idKategori of targetIds) {
      await client.query('INSERT INTO addon_target_category (id_menu, id_kategori) VALUES ($1, $2)', [idMenu, idKategori]);
    }
  }
}

function validateAddonSelections(items) {
  const parentLines = new Map();
  for (const item of items) {
    if (item.line_reference === undefined) continue;
    const reference = String(item.line_reference);
    const quantity = Number(item.qty);
    if (!reference || parentLines.has(reference) || !Number.isInteger(quantity) || quantity < 1) {
      return 'Referensi item Add-On tidak valid';
    }
    parentLines.set(reference, quantity);
  }

  const totals = new Map();
  for (const item of items) {
    const hasAddonMetadata = item.addon_for_line !== undefined || item.addon_count_per_item !== undefined;
    if (!item.is_addon && !hasAddonMetadata) continue;
    if (item.is_addon !== true || item.addon_for_line === undefined || item.addon_count_per_item === undefined) {
      return 'Data Add-On tidak valid';
    }

    const parentReference = String(item.addon_for_line);
    const parentQuantity = parentLines.get(parentReference);
    const addonCount = Number(item.addon_count_per_item);
    const quantity = Number(item.qty);
    if (!parentQuantity || !Number.isInteger(addonCount) || addonCount < 1 ||
        !Number.isInteger(quantity) || quantity !== parentQuantity * addonCount) {
      return 'Jumlah Add-On tidak valid';
    }

    const total = (totals.get(parentReference) || 0) + addonCount;
    if (total > 5) return 'Maksimal 5 add-on per item';
    totals.set(parentReference, total);
  }
  return null;
}

async function deleteMenuOrDeactivate(client, idMenu) {
  const menuResult = await client.query(
    'SELECT id_menu, nama_menu, is_aktif FROM menu WHERE id_menu = $1 FOR UPDATE',
    [idMenu]
  );
  if (!menuResult.rows.length) return null;

  const references = await client.query(
    `SELECT
       EXISTS (SELECT 1 FROM detail_transaksi WHERE id_menu = $1)
       OR EXISTS (SELECT 1 FROM order_tersimpan_item WHERE id_menu = $1) AS is_referenced`,
    [idMenu]
  );
  if (references.rows[0].is_referenced) {
    const result = await client.query(
      'UPDATE menu SET is_deleted = TRUE WHERE id_menu = $1 RETURNING id_menu, nama_menu, is_aktif',
      [idMenu]
    );
    return {
      deleted: true,
      archived: true,
      message: 'Menu dihapus dari katalog dan diarsipkan agar riwayat transaksi tetap utuh',
      menu: result.rows[0],
    };
  }

  const result = await client.query(
    'DELETE FROM menu WHERE id_menu = $1 RETURNING id_menu, nama_menu, is_aktif',
    [idMenu]
  );
  return {
    deleted: true,
    archived: false,
    message: 'Menu berhasil dihapus',
    menu: result.rows[0],
  };
}

// ==========================================
// 1. AUTHENTICATION (LOGIN ADMIN & KASIR)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }

  try {
    const result = await db.query(
      `SELECT u.id_user, u.id_karyawan, k.nama_karyawan AS nama, u.username, u.role
       FROM users u
       JOIN karyawan k ON k.id_karyawan = u.id_karyawan
       WHERE u.username = LOWER($1)
         AND u.is_aktif = TRUE
         AND u.password_hash = crypt($2, u.password_hash)`,
      [username.trim(), password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Username atau password salah' });
    }

    const user = result.rows[0];
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '12h' });

    res.json({ message: 'Login berhasil', token, user });
  } catch (err) {
    console.error('POST /api/auth/login error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server saat login' });
  }
});

app.get('/api/users', requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id_user, u.id_karyawan, k.nama_karyawan AS nama, u.username, u.role, u.is_aktif
       FROM users u JOIN karyawan k ON k.id_karyawan = u.id_karyawan
       WHERE u.is_aktif = TRUE ORDER BY u.id_user`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/users error:', err);
    res.status(500).json({ error: 'Gagal memuat daftar pengguna' });
  }
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  const { nama, username, password, role = 'kasir' } = req.body;
  const normalizedUsername = String(username || '').trim().toLowerCase();
  if (!String(nama || '').trim() || !/^[a-z0-9._-]{3,50}$/.test(normalizedUsername) ||
      typeof password !== 'string' || password.length < 4 || !['admin', 'kasir'].includes(role)) {
    return res.status(400).json({ error: 'Nama, username (3-50 karakter), password (minimal 4 karakter), dan role yang valid wajib diisi' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const nextEmployee = await client.query(
      "SELECT COALESCE(MAX(NULLIF(regexp_replace(id_karyawan, '\\D', '', 'g'), '')::int), 0) + 1 AS next_id FROM karyawan"
    );
    const idKaryawan = `E${String(nextEmployee.rows[0].next_id).padStart(2, '0')}`;
    await client.query('INSERT INTO karyawan (id_karyawan, nama_karyawan, jabatan) VALUES ($1, $2, $3)', [idKaryawan, String(nama).trim(), role === 'admin' ? 'Admin' : 'Kasir']);
    const result = await client.query(
      `INSERT INTO users (id_karyawan, username, password_hash, role)
       VALUES ($1, $2, crypt($3, gen_salt('bf')), $4)
       RETURNING id_user, id_karyawan, username, role, is_aktif`,
      [idKaryawan, normalizedUsername, password, role]
    );
    await client.query('COMMIT');
    res.status(201).json({ ...result.rows[0], nama: String(nama).trim() });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/users error:', err);
    res.status(err.code === '23505' ? 409 : 400).json({ error: err.code === '23505' ? 'Username sudah digunakan' : err.message });
  } finally {
    client.release();
  }
});

app.patch('/api/users/:id_user', requireRole('admin'), async (req, res) => {
  const { id_user } = req.params;
  const { nama, username, password, role, is_aktif } = req.body;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT id_karyawan, role FROM users WHERE id_user = $1 FOR UPDATE', [id_user]);
    if (!current.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
    }
    if (role !== undefined && !['admin', 'kasir'].includes(role)) throw new Error('Role tidak valid');
    if (Number(id_user) === Number(req.user.id_user) && role !== undefined && role !== current.rows[0].role) {
      throw new Error('Role akun yang sedang digunakan tidak dapat diubah');
    }
    if (current.rows[0].role === 'admin' && role === 'kasir') {
      const admins = await client.query("SELECT COUNT(*)::int AS total FROM users WHERE role = 'admin' AND is_aktif = TRUE");
      if (admins.rows[0].total <= 1) throw new Error('Minimal harus ada satu admin aktif');
    }
    if (username !== undefined && !/^[a-z0-9._-]{3,50}$/.test(String(username).trim().toLowerCase())) throw new Error('Username tidak valid');
    if (password !== undefined && (typeof password !== 'string' || password.length < 4)) throw new Error('Password minimal 4 karakter');
    await client.query(
      `UPDATE karyawan SET nama_karyawan = COALESCE($1, nama_karyawan),
         jabatan = COALESCE($2, jabatan) WHERE id_karyawan = $3`,
      [nama === undefined ? null : String(nama).trim(), role === 'admin' ? 'Admin' : role === 'kasir' ? 'Kasir' : null, current.rows[0].id_karyawan]
    );
    const result = await client.query(
      `UPDATE users SET username = COALESCE($1, username),
         password_hash = CASE WHEN $2::text IS NULL THEN password_hash ELSE crypt($2, gen_salt('bf')) END,
         role = COALESCE($3, role), is_aktif = COALESCE($4, is_aktif)
       WHERE id_user = $5 RETURNING id_user, id_karyawan, username, role, is_aktif`,
      [username === undefined ? null : String(username).trim().toLowerCase(), password === undefined ? null : password, role ?? null, is_aktif ?? null, id_user]
    );
    await client.query('COMMIT');
    res.json({ ...result.rows[0], nama: nama === undefined ? undefined : String(nama).trim() });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /api/users error:', err);
    res.status(err.code === '23505' ? 409 : 400).json({ error: err.code === '23505' ? 'Username sudah digunakan' : err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/users/:id_user', requireRole('admin'), async (req, res) => {
  const { id_user } = req.params;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const target = await client.query('SELECT id_karyawan, role FROM users WHERE id_user = $1 FOR UPDATE', [id_user]);
    if (!target.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
    }
    if (Number(id_user) === Number(req.user.id_user)) throw new Error('Akun yang sedang digunakan tidak dapat dihapus');
    if (target.rows[0].role === 'admin') {
      const admins = await client.query("SELECT COUNT(*)::int AS total FROM users WHERE role = 'admin' AND is_aktif = TRUE");
      if (admins.rows[0].total <= 1) throw new Error('Minimal harus ada satu admin aktif');
    }
    await client.query('UPDATE users SET is_aktif = FALSE WHERE id_user = $1', [id_user]);
    await client.query('COMMIT');
    res.json({ message: 'Pengguna berhasil dihapus' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 2. MENU & KATEGORI ENDPOINTS
// ==========================================
app.get('/api/menu', optionalToken, async (req, res) => {
  try {
    await db.ensureMenuDiscountColumn();
    const { include_inactive } = req.query;
    const conditions = ['COALESCE(m.is_deleted, FALSE) = FALSE'];
    if (include_inactive !== 'true') conditions.push('COALESCE(m.is_aktif, TRUE) = TRUE');
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await db.query(`
      WITH menu_base AS (
        SELECT 
          m.id_menu,
          m.sku,
          m.nama_menu,
          k.id_kategori,
          k.nama_kategori AS category,
          LOWER(REGEXP_REPLACE(k.nama_kategori, '[^a-zA-Z0-9]', '', 'g')) AS category_slug,
          m.harga_satuan AS harga,
          m.diskon_persen,
          m.harga_satuan - ROUND(m.harga_satuan * m.diskon_persen / 100.0)::INT AS harga_diskon,
          COALESCE(t.terjual, 0) AS terjual,
          m.stok,
          CASE 
            WHEN m.stok IS NULL THEN 'Ready ∞'
            WHEN m.stok > 0     THEN m.stok::text || ' pcs'
            ELSE 'Habis' 
          END AS status_stok,
          m.adonan,
          m.rating_adonan,
          m.is_rekomendasi,
          m.is_baru_manual,
          m.is_pedas,
          m.varian_menu,
          m.deskripsi,
          COALESCE(m.is_aktif, TRUE) AS aktif,
          m.created_at,
          k.urutan AS kat_urutan,
          ROW_NUMBER() OVER (
            ORDER BY CASE WHEN COALESCE(t.terjual, 0) > 0 THEN 0 ELSE 1 END,
                     COALESCE(t.terjual, 0) DESC, m.id_menu
          ) AS sales_rank
        FROM menu m
        JOIN kategori_menu k ON k.id_kategori = m.id_kategori
        LEFT JOIN (
          SELECT id_menu, SUM(qty)::INT AS terjual
          FROM detail_transaksi
          GROUP BY id_menu
        ) t ON t.id_menu = m.id_menu
        ${whereClause}
      )
      SELECT 
        id_menu,
        sku,
        nama_menu,
        id_kategori,
        category,
        category_slug,
        harga,
        diskon_persen,
        harga_diskon,
        terjual,
        stok,
        status_stok,
        adonan,
        rating_adonan,
        is_rekomendasi,
        is_pedas,
        varian_menu,
        deskripsi,
        created_at,
        aktif,
        (terjual > 0 AND sales_rank <= 5) AS is_paling_laris,
        (is_baru_manual OR created_at >= (NOW() AT TIME ZONE 'Asia/Jakarta') - INTERVAL '30 days') AS is_baru,
        is_baru_manual,
        COALESCE((
          SELECT json_agg(json_build_object('id_label', lm.id_label, 'nama_label', lm.nama_label, 'warna', lm.warna) ORDER BY lm.nama_label)
          FROM menu_label ml JOIN custom_labels lm ON lm.id_label = ml.id_label
          WHERE ml.id_menu = menu_base.id_menu
        ), '[]'::json) AS labels,
        COALESCE((
          SELECT json_agg(k2.nama_kategori ORDER BY k2.urutan)
          FROM addon_target_category atc JOIN kategori_menu k2 ON k2.id_kategori = atc.id_kategori
          WHERE atc.id_menu = menu_base.id_menu
        ), '[]'::json) AS addon_target_categories
      FROM menu_base
      ORDER BY kat_urutan ASC, sku ASC
    `);

    res.set('Cache-Control', 'no-store');
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/menu error:', err);
    res.status(500).json({ error: 'Gagal memuat daftar menu', detail: err.message });
  }
});

app.get('/api/kategori', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM kategori_menu ORDER BY urutan ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Gagal memuat kategori' });
  }
});

app.get('/api/labels', optionalToken, async (req, res) => {
  try {
    await db.ensureMenuDiscountColumn();
    const result = await db.query('SELECT id_label, nama_label, warna FROM custom_labels ORDER BY nama_label');
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/labels error:', err);
    res.status(500).json({ error: 'Gagal memuat label menu' });
  }
});

app.post('/api/labels', requireRole('admin'), async (req, res) => {
  const { nama_label, warna } = req.body;
  if (!String(nama_label || '').trim() || !/^#[0-9A-Fa-f]{6}$/.test(String(warna || ''))) {
    return res.status(400).json({ error: 'Nama label dan warna hex (#RRGGBB) wajib diisi' });
  }
  try {
    await db.ensureMenuDiscountColumn();
    const result = await db.query(
      'INSERT INTO custom_labels (nama_label, warna) VALUES ($1, $2) RETURNING id_label, nama_label, warna',
      [String(nama_label).trim(), warna]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(err.code === '23505' ? 409 : 400).json({ error: err.code === '23505' ? 'Nama label sudah digunakan' : err.message });
  }
});

app.patch('/api/labels/:id_label', requireRole('admin'), async (req, res) => {
  const { nama_label, warna } = req.body;
  if (nama_label !== undefined && !String(nama_label).trim()) return res.status(400).json({ error: 'Nama label tidak boleh kosong' });
  if (warna !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(String(warna))) return res.status(400).json({ error: 'Warna harus berformat hex (#RRGGBB)' });
  try {
    const result = await db.query(
      `UPDATE custom_labels SET nama_label = COALESCE($1, nama_label), warna = COALESCE($2, warna)
       WHERE id_label = $3 RETURNING id_label, nama_label, warna`,
      [nama_label === undefined ? null : String(nama_label).trim(), warna ?? null, req.params.id_label]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Label tidak ditemukan' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(err.code === '23505' ? 409 : 400).json({ error: err.code === '23505' ? 'Nama label sudah digunakan' : err.message });
  }
});

app.delete('/api/labels/:id_label', requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query('DELETE FROM custom_labels WHERE id_label = $1 RETURNING id_label', [req.params.id_label]);
    if (!result.rows.length) return res.status(404).json({ error: 'Label tidak ditemukan' });
    res.json({ message: 'Label berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menghapus label', detail: err.message });
  }
});

app.post('/api/menu', requireRole('admin'), async (req, res) => {
  const { id_kategori, nama_menu, harga_satuan, diskon_persen = 0, stok = null, adonan = null, rating_adonan = null, is_rekomendasi = false, is_baru_manual = false, is_pedas = false, varian_menu = [], deskripsi = null, label_ids = [], addon_target_categories = [] } = req.body;
  const diskonPersen = Number(diskon_persen);
  if (!id_kategori || !nama_menu || harga_satuan === undefined || !Array.isArray(label_ids) || !Array.isArray(addon_target_categories) || !Array.isArray(varian_menu)) {
    return res.status(400).json({ error: 'Kategori, nama menu, dan harga satuan wajib diisi' });
  }
  if (!Number.isInteger(diskonPersen) || diskonPersen < 0 || diskonPersen > 100) {
    return res.status(400).json({ error: 'Diskon harus berupa bilangan bulat antara 0 dan 100' });
  }
  try {
    await db.ensureMenuDiscountColumn();
    const katRes = await db.query('SELECT kode_kategori FROM kategori_menu WHERE id_kategori = $1', [id_kategori]);
    if (katRes.rows.length === 0) return res.status(400).json({ error: 'Kategori tidak ditemukan' });
    const kodeKat = katRes.rows[0].kode_kategori;

    // pakai angka terbesar (bukan COUNT) supaya tidak bentrok kalau ada menu yang pernah dihapus
    const maxMenu = await db.query("SELECT COALESCE(MAX(NULLIF(regexp_replace(id_menu, '\\D', '', 'g'), '')::int), 0) AS mx FROM menu");
    const idMenu = 'M' + String(parseInt(maxMenu.rows[0].mx, 10) + 1).padStart(3, '0');

    const maxKat = await db.query(
      "SELECT COALESCE(MAX(NULLIF(SUBSTRING(sku FROM '[0-9]+$'), '')::int), 0) AS mx FROM menu WHERE id_kategori = $1 AND sku LIKE $2",
      [id_kategori, `SKU-${kodeKat}-%`]
    );
    const sku = `SKU-${kodeKat}-${String(parseInt(maxKat.rows[0].mx, 10) + 1).padStart(3, '0')}`;

    const variants = [...new Set(varian_menu.map(value => String(value).trim()).filter(Boolean))];
    const insertRes = await db.query(
      `INSERT INTO menu (id_menu, sku, id_kategori, nama_menu, harga_satuan, diskon_persen, stok, adonan, rating_adonan, is_rekomendasi, is_baru_manual, is_pedas, varian_menu, deskripsi, is_aktif, is_deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE, FALSE) RETURNING *`,
      [idMenu, sku, id_kategori, nama_menu.trim(), harga_satuan, diskonPersen, stok === '' ? null : stok, adonan || null, adonan ? rating_adonan || 2 : null, is_rekomendasi, is_baru_manual, is_pedas, variants, deskripsi ? String(deskripsi).trim() || null : null]
    );
    await saveMenuRelations(db, idMenu, label_ids, addon_target_categories);
    res.status(201).json(insertRes.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/menu/:id_menu', requireRole('admin'), async (req, res) => {
  const { id_menu } = req.params;
  const { nama_menu, harga_satuan, diskon_persen, stok, is_rekomendasi, is_baru_manual, is_pedas, is_aktif, deskripsi, id_kategori, label_ids, addon_target_categories, varian_menu } = req.body;
  try {
    await db.ensureMenuDiscountColumn();
    const diskonPersen = diskon_persen === undefined ? null : Number(diskon_persen);
    if (diskonPersen !== null && (!Number.isInteger(diskonPersen) || diskonPersen < 0 || diskonPersen > 100)) {
      return res.status(400).json({ error: 'Diskon harus berupa bilangan bulat antara 0 dan 100' });
    }
    const updateStok = stok !== undefined;
    const updateDesk = deskripsi !== undefined; // kirim "" / null untuk mengosongkan
    if (label_ids !== undefined && !Array.isArray(label_ids)) return res.status(400).json({ error: 'label_ids harus berupa daftar' });
    if (addon_target_categories !== undefined && !Array.isArray(addon_target_categories)) return res.status(400).json({ error: 'addon_target_categories harus berupa daftar' });
    if (varian_menu !== undefined && !Array.isArray(varian_menu)) return res.status(400).json({ error: 'varian_menu harus berupa daftar' });
    const normalizedVariants = varian_menu === undefined
      ? []
      : [...new Set(varian_menu.map(value => String(value).trim()).filter(Boolean))];
    const result = await db.query(
      `UPDATE menu
       SET nama_menu = COALESCE($1, nama_menu),
           harga_satuan = COALESCE($2, harga_satuan),
           stok = CASE WHEN $3::boolean THEN $4::int ELSE stok END,
           is_rekomendasi = COALESCE($5, is_rekomendasi),
           is_aktif = COALESCE($6, is_aktif),
           deskripsi = CASE WHEN $8::boolean THEN $9::text ELSE deskripsi END,
           id_kategori = COALESCE($10, id_kategori),
           diskon_persen = COALESCE($11, diskon_persen),
           is_pedas = COALESCE($12, is_pedas),
           is_baru_manual = COALESCE($13, is_baru_manual),
           varian_menu = CASE WHEN $14::boolean THEN $15::text[] ELSE varian_menu END
       WHERE id_menu = $7 RETURNING *`,
      [nama_menu ?? null, harga_satuan ?? null, updateStok, stok === '' ? null : stok, is_rekomendasi ?? null, is_aktif ?? null, id_menu, updateDesk, updateDesk && deskripsi ? String(deskripsi).trim() || null : null, id_kategori ?? null, diskonPersen, is_pedas ?? null, is_baru_manual ?? null, varian_menu !== undefined, normalizedVariants]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Menu tidak ditemukan' });
    if (varian_menu !== undefined && result.rows[0].adonan) {
      const baseName = result.rows[0].nama_menu.replace(/\s*-\s*(Kentang|Labu|Ubi)$/i, '').trim();
      await db.query(
        `UPDATE menu
         SET varian_menu = $1
         WHERE id_kategori = $2 AND adonan IS NOT NULL
           AND lower(regexp_replace(nama_menu, '\\s*-\\s*(Kentang|Labu|Ubi)$', '', 'i')) = lower($3)`,
        [normalizedVariants, result.rows[0].id_kategori, baseName]
      );
    }
    if (label_ids !== undefined || addon_target_categories !== undefined) {
      await saveMenuRelations(db, id_menu, label_ids, addon_target_categories);
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/menu/:id_menu', requireRole('admin'), async (req, res) => {
  let client;
  try {
    await db.ensureMenuDiscountColumn();
    client = await db.getClient();
    await client.query('BEGIN');
    const result = await deleteMenuOrDeactivate(client, req.params.id_menu);
    if (!result) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Menu tidak ditemukan' });
    }
    await client.query('COMMIT');
    res.json(result);
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('DELETE /api/menu error:', err);
    res.status(500).json({ error: 'Gagal menghapus menu', detail: err.message });
  } finally {
    if (client) client.release();
  }
});

// ==========================================
// 3. DELIVERY WEBSITE ORDER ENDPOINTS
// ==========================================
app.post('/api/delivery', optionalToken, async (req, res) => {
  const { nama_pelanggan, no_telepon, alamat_lengkap, area_pengiriman, area_code = null, catatan_delivery = '', items = [] } = req.body;
  const normalizedPhone = String(no_telepon || '').replace(/[\s\-()+]/g, '');
  const isValidPhone = /^(08\d{8,12}|628\d{7,11})$/.test(normalizedPhone);
  if (!String(nama_pelanggan || '').trim() || !isValidPhone || !String(alamat_lengkap || '').trim() ||
      !String(area_pengiriman || '').trim() || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Data pelanggan, alamat, area, dan item pesanan wajib lengkap' });
  }
  const addonError = validateAddonSelections(items);
  if (addonError) return res.status(400).json({ error: addonError });
  const areaCode = area_code === 'ombe' ? 'ombe' : area_code === 'araya' ? 'araya' :
    (/ombe/i.test(area_pengiriman) ? 'ombe' : /araya|senandung/i.test(area_pengiriman) ? 'araya' : null);
  if (!areaCode) return res.status(400).json({ error: 'Area pengiriman tidak dikenal' });
  const ongkir = areaCode === 'ombe' ? 5000 : 0;

  const client = await db.getClient();
  try {
    await db.ensureMenuDiscountColumn();
    await client.query('BEGIN');

    let idPelanggan;
    const cekPelanggan = await client.query('SELECT id_pelanggan FROM pelanggan WHERE no_telepon = $1 LIMIT 1', [normalizedPhone]);
    if (cekPelanggan.rows.length > 0) {
      idPelanggan = cekPelanggan.rows[0].id_pelanggan;
      await client.query('UPDATE pelanggan SET nama_pelanggan = $1 WHERE id_pelanggan = $2', [nama_pelanggan.trim(), idPelanggan]);
    } else {
      const insPelanggan = await client.query('INSERT INTO pelanggan (nama_pelanggan, no_telepon) VALUES ($1, $2) RETURNING id_pelanggan', [nama_pelanggan.trim(), normalizedPhone]);
      idPelanggan = insPelanggan.rows[0].id_pelanggan;
    }

    // POS and Delivery share one serialized daily queue and the same receipt format.
    const { noStruk, noAntrian } = await generateOrderMeta(client, 'T01', req.body.no_struk);
    const source = req.user ? 'POS' : 'Website';
    const employeeId = req.user && req.user.id_karyawan ? req.user.id_karyawan : null;

    await client.query(
      `INSERT INTO transaksi (no_struk, tanggal_waktu, no_antrian, tipe_pesanan, nominal_bayar, persen_pajak, id_toko, id_karyawan, id_pos, id_metode, asal_pesanan, status_pesanan)
       VALUES ($1, NOW() AT TIME ZONE 'Asia/Jakarta', $2, 'Delivery', $3, 0, 'T01', $4, $5, $6, $7, 'Pending')`,
      [noStruk, noAntrian, Number(req.body.nominal_bayar) || 0, employeeId, req.user ? 'P01' : null, req.body.id_metode || 'MTD01', source]
    );

    let subtotalBelanja = 0;
    for (const item of items) {
      const qty = Number(item.qty);
      if (!Number.isInteger(qty) || qty < 1) throw new Error(`Jumlah menu ${item.id_menu} tidak valid`);
      const menuItem = await deductMenuStock(client, item.id_menu, qty);
      const hargaSatuan = Number(menuItem.harga_satuan);
      const diskonMenu = Math.round(hargaSatuan * Number(menuItem.diskon_persen) / 100) * qty;
      const diskonKasir = req.user ? Number(item.diskon_item || 0) : 0;
      if (!Number.isInteger(diskonKasir) || diskonKasir < 0 || diskonKasir > hargaSatuan * qty - diskonMenu) {
        throw new Error(`Diskon transaksi untuk menu ${item.id_menu} tidak valid`);
      }
      const diskonItem = diskonMenu + diskonKasir;
      subtotalBelanja += hargaSatuan * qty - diskonItem;

      await client.query(
        `INSERT INTO detail_transaksi (no_struk, id_menu, qty, harga_satuan, diskon_item, catatan)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [noStruk, item.id_menu, qty, hargaSatuan, diskonItem, item.catatan || null]
      );
    }
    if (areaCode === 'ombe' && subtotalBelanja < 50000) {
      throw new Error('Minimal order area Ombe ke depan adalah Rp50.000');
    }

    await client.query(
      `INSERT INTO detail_delivery (no_struk, id_pelanggan, alamat_lengkap, area_pengiriman, area_code, ongkir, catatan_delivery, status_delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending')`,
      [noStruk, idPelanggan, alamat_lengkap.trim(), area_pengiriman, areaCode, ongkir, catatan_delivery]
    );

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      message: 'Pesanan delivery berhasil dibuat',
      no_struk: noStruk,
      no_antrian: noAntrian,
      subtotal: subtotalBelanja,
      ongkir,
      total_tagihan: subtotalBelanja + ongkir,
      order: {
        no_struk: noStruk,
        no_antrian: noAntrian,
        subtotal: subtotalBelanja,
        ongkir,
        total_tagihan: subtotalBelanja + ongkir,
        tanggal_waktu: new Date().toISOString()
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, message: err.message || 'Gagal memproses pesanan delivery', error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/delivery', requireRole('admin', 'kasir'), async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    const filter = status ? (params.push(status), 'WHERE v.status_delivery = $1') : '';

    const result = await db.query(
      `SELECT v.*, v.tanggal_waktu AT TIME ZONE 'Asia/Jakarta' AS waktu,
        (SELECT mp.nama_metode FROM transaksi tx JOIN metode_pembayaran mp ON mp.id_metode = tx.id_metode WHERE tx.no_struk = v.no_struk) AS nama_metode,
        (SELECT kr.nama_karyawan FROM karyawan kr WHERE kr.id_karyawan = v.id_karyawan) AS nama_karyawan,
        COALESCE(
          (SELECT json_agg(json_build_object(
            'id_menu', d.id_menu, 'sku', m.sku, 'nama_menu', m.nama_menu,
            'qty', d.qty, 'harga_satuan', d.harga_satuan, 'subtotal_item', d.subtotal_item,
            'diskon_item', d.diskon_item, 'catatan', d.catatan
          ))
          FROM detail_transaksi d JOIN menu m ON m.id_menu = d.id_menu WHERE d.no_struk = v.no_struk), '[]'
        ) AS items
      FROM v_delivery_orders v ${filter} ORDER BY v.tanggal_waktu DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Gagal memuat pesanan delivery' });
  }
});

app.patch('/api/delivery/:no_struk/status', requireRole('admin', 'kasir'), async (req, res) => {
  const { no_struk } = req.params;
  const { status_delivery, nominal_bayar, id_karyawan = 'E03', id_metode } = req.body;
  const validStatuses = ['Pending', 'Confirmed', 'Preparing', 'On Delivery', 'Completed', 'Cancelled'];
  if (!validStatuses.includes(status_delivery)) return res.status(400).json({ error: 'Status tidak valid' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const cekStatus = await client.query('SELECT status_delivery FROM detail_delivery WHERE no_struk = $1 FOR UPDATE', [no_struk]);
    if (cekStatus.rows.length === 0) throw new Error('Pesanan delivery tidak ditemukan');
    const prevStatus = cekStatus.rows[0].status_delivery;

    await client.query("UPDATE detail_delivery SET status_delivery = $1, diperbarui_pada = NOW() AT TIME ZONE 'Asia/Jakarta' WHERE no_struk = $2", [status_delivery, no_struk]);
    await client.query(
      `UPDATE transaksi SET status_pesanan = $1, id_karyawan = COALESCE($2, id_karyawan), id_metode = COALESCE($3, id_metode), nominal_bayar = COALESCE($4, nominal_bayar) WHERE no_struk = $5`,
      [status_delivery, id_karyawan, id_metode || null, nominal_bayar ?? null, no_struk]
    );

    if (status_delivery === 'Cancelled' && prevStatus !== 'Cancelled') {
      const itemsRes = await client.query('SELECT id_menu, qty FROM detail_transaksi WHERE no_struk = $1', [no_struk]);
      for (const row of itemsRes.rows) {
        await client.query('UPDATE menu SET stok = stok + $1 WHERE id_menu = $2 AND stok IS NOT NULL', [row.qty, row.id_menu]);
      }
    }

    await client.query('COMMIT');
    res.json({
      message: `Status pesanan ${no_struk} diperbarui menjadi ${status_delivery}`,
      notification_due: status_delivery === 'On Delivery' && prevStatus !== 'On Delivery'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 4. TRANSAKSI KASIR POS & LAPORAN
// ==========================================
app.post('/api/transaksi', requireRole('admin', 'kasir'), async (req, res) => {
  const { tipe_pesanan = 'Dine In', nominal_bayar, persen_pajak = 0, id_toko = 'T01', id_karyawan = 'E03', id_pos = 'P01', id_metode = 'MTD01', items = [] } = req.body;
  if (tipe_pesanan === 'Delivery') return res.status(400).json({ error: 'Pesanan Delivery harus dibuat melalui endpoint /api/delivery agar data pelanggan, area, ongkir, dan riwayatnya tersimpan lengkap' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Keranjang transaksi kosong' });
  const addonError = validateAddonSelections(items);
  if (addonError) return res.status(400).json({ error: addonError });

  const client = await db.getClient();
  try {
    await db.ensureMenuDiscountColumn();
    await client.query('BEGIN');
    const { noStruk, noAntrian } = await generateOrderMeta(client, id_toko);

    await client.query(
      `INSERT INTO transaksi (no_struk, tanggal_waktu, no_antrian, tipe_pesanan, nominal_bayar, persen_pajak, id_toko, id_karyawan, id_pos, id_metode, asal_pesanan, status_pesanan)
       VALUES ($1, NOW() AT TIME ZONE 'Asia/Jakarta', $2, $3, $4, $5, $6, $7, $8, $9, 'POS', 'Completed')`,
      [noStruk, noAntrian, tipe_pesanan, nominal_bayar, persen_pajak, id_toko, id_karyawan, id_pos, id_metode]
    );

    for (const item of items) {
      const qty = Number(item.qty);
      if (!Number.isInteger(qty) || qty < 1) throw new Error(`Jumlah menu ${item.id_menu} tidak valid`);
      const menuItem = await deductMenuStock(client, item.id_menu, qty);
      const hargaSatuan = Number(menuItem.harga_satuan);
      const diskonMenu = Math.round(hargaSatuan * Number(menuItem.diskon_persen) / 100) * qty;
      const diskonKasir = Number(item.diskon_item || 0);
      const subtotalSetelahDiskonMenu = hargaSatuan * qty - diskonMenu;
      if (!Number.isInteger(diskonKasir) || diskonKasir < 0 || diskonKasir > subtotalSetelahDiskonMenu) {
        throw new Error(`Diskon transaksi untuk menu ${item.id_menu} tidak valid`);
      }
      await client.query(
        `INSERT INTO detail_transaksi (no_struk, id_menu, qty, harga_satuan, diskon_item, catatan)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [noStruk, item.id_menu, qty, hargaSatuan, diskonMenu + diskonKasir, item.catatan || null]
      );
    }

    const summary = await client.query(
      "SELECT v.*, v.tanggal_waktu AT TIME ZONE 'Asia/Jakarta' AS waktu FROM v_transaksi_total v WHERE v.no_struk = $1",
      [noStruk]
    );
    await client.query('COMMIT');
    res.status(201).json({ message: 'Transaksi POS berhasil disimpan', transaksi: summary.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/transaksi', requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(`
      SELECT v.*, v.tanggal_waktu AT TIME ZONE 'Asia/Jakarta' AS waktu, t.asal_pesanan, t.status_pesanan, mp.nama_metode, k.nama_karyawan,
             COALESCE(dd.ongkir, 0) AS ongkir,
             (v.total_tagihan + COALESCE(dd.ongkir, 0)) AS grand_total
      FROM v_transaksi_total v
      JOIN transaksi t ON t.no_struk = v.no_struk
      LEFT JOIN metode_pembayaran mp ON mp.id_metode = v.id_metode
      LEFT JOIN karyawan k ON k.id_karyawan = v.id_karyawan
      LEFT JOIN detail_delivery dd ON dd.no_struk = v.no_struk
      ORDER BY v.tanggal_waktu DESC LIMIT 150
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Gagal memuat riwayat transaksi' });
  }
});

// Wajib diekspor sebagai handler Vercel Serverless
module.exports = app;