require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('../db');
const { JWT_SECRET, optionalToken, requireRole } = require('../auth');

const app = express();
app.use(cors());
app.use(express.json());

app.get(['/api', '/api/health'], (req, res) => {
  res.json({
    status: 'OK',
    service: 'Bake Haus POS & Delivery API',
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  const host = String(req.headers.host || '').toLowerCase();
  const page = host.includes('pos') ? 'pos.html' : 'delivery.html';
  res.sendFile(path.join(__dirname, '..', 'public', page));
});

// Helper: Generate No Struk & No Antrian Harian
async function generateOrderMeta(client, idToko = 'T01', requestedNoStruk = null) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext(CURRENT_DATE::text))',
    [idToko]
  );
  const antrianRes = await client.query(
    `SELECT COALESCE(MAX(no_antrian), 0) + 1 AS next_antrian
     FROM transaksi
     WHERE id_toko = $1 AND tanggal_waktu::date = CURRENT_DATE`,
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

// ==========================================
// 2. MENU & KATEGORI ENDPOINTS
// ==========================================
app.get('/api/menu', optionalToken, async (req, res) => {
  try {
    await db.ensureMenuDiscountColumn();
    const { include_inactive } = req.query;
    const whereClause = include_inactive === 'true' ? '' : 'WHERE m.is_aktif = TRUE';

    const result = await db.query(`
      WITH menu_base AS (
        SELECT 
          m.id_menu,
          m.sku,
          m.nama_menu,
          k.id_kategori,
          k.nama_kategori AS category,
          LOWER(REPLACE(k.nama_kategori, '-', '')) AS category_slug,
          m.harga_satuan AS harga,
          m.diskon_persen,
          m.harga_satuan - ROUND(m.harga_satuan * m.diskon_persen / 100.0)::INT AS harga_diskon,
          ${req.user ? 'm.hpp' : 'NULL::int'} AS hpp,
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
          m.deskripsi,
          m.is_aktif AS aktif,
          k.urutan AS kat_urutan,
          CASE 
            WHEN COALESCE(t.terjual, 0) > 0 THEN 
              DENSE_RANK() OVER (
                PARTITION BY (CASE WHEN COALESCE(t.terjual, 0) > 0 THEN 1 ELSE 0 END)
                ORDER BY COALESCE(t.terjual, 0) DESC
              )
            ELSE NULL 
          END AS sales_rank,
          ROW_NUMBER() OVER (
            ORDER BY COALESCE(NULLIF(regexp_replace(m.id_menu, '\\D', '', 'g'), '')::int, 0) DESC, m.id_menu DESC
          ) AS newest_rank
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
        hpp,
        terjual,
        stok,
        status_stok,
        adonan,
        rating_adonan,
        is_rekomendasi,
        deskripsi,
        aktif,
        (terjual > 0 AND sales_rank IS NOT NULL AND sales_rank <= 5) AS is_paling_laris,
        (newest_rank <= 5) AS is_baru
      FROM menu_base
      ORDER BY kat_urutan ASC, sku ASC
    `);

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

app.post('/api/menu', requireRole('admin'), async (req, res) => {
  const { id_kategori, nama_menu, harga_satuan, diskon_persen = 0, hpp = 0, stok = null, adonan = null, rating_adonan = null, is_rekomendasi = false, deskripsi = null } = req.body;
  const diskonPersen = Number(diskon_persen);
  if (!id_kategori || !nama_menu || harga_satuan === undefined) {
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

    const maxKat = await db.query("SELECT COALESCE(MAX(regexp_replace(sku, '^SKU-[A-Z]{3}-', '')::int), 0) AS mx FROM menu WHERE id_kategori = $1", [id_kategori]);
    const sku = `SKU-${kodeKat}-${String(parseInt(maxKat.rows[0].mx, 10) + 1).padStart(3, '0')}`;

    const insertRes = await db.query(
      `INSERT INTO menu (id_menu, sku, id_kategori, nama_menu, harga_satuan, diskon_persen, hpp, stok, adonan, rating_adonan, is_rekomendasi, deskripsi)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [idMenu, sku, id_kategori, nama_menu.trim(), harga_satuan, diskonPersen, hpp, stok === '' ? null : stok, adonan || null, adonan ? rating_adonan || 2 : null, is_rekomendasi, deskripsi ? String(deskripsi).trim() || null : null]
    );
    res.status(201).json(insertRes.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/menu/:id_menu', requireRole('admin'), async (req, res) => {
  const { id_menu } = req.params;
  const { nama_menu, harga_satuan, diskon_persen, hpp, stok, is_rekomendasi, is_aktif, deskripsi, id_kategori } = req.body;
  try {
    await db.ensureMenuDiscountColumn();
    const diskonPersen = diskon_persen === undefined ? null : Number(diskon_persen);
    if (diskonPersen !== null && (!Number.isInteger(diskonPersen) || diskonPersen < 0 || diskonPersen > 100)) {
      return res.status(400).json({ error: 'Diskon harus berupa bilangan bulat antara 0 dan 100' });
    }
    const updateStok = stok !== undefined;
    const updateDesk = deskripsi !== undefined; // kirim "" / null untuk mengosongkan
    const result = await db.query(
      `UPDATE menu
       SET nama_menu = COALESCE($1, nama_menu),
           harga_satuan = COALESCE($2, harga_satuan),
           hpp = COALESCE($3, hpp),
           stok = CASE WHEN $4::boolean THEN $5::int ELSE stok END,
           is_rekomendasi = COALESCE($6, is_rekomendasi),
           is_aktif = COALESCE($7, is_aktif),
           deskripsi = CASE WHEN $9::boolean THEN $10::text ELSE deskripsi END,
           id_kategori = COALESCE($11, id_kategori),
           diskon_persen = COALESCE($12, diskon_persen)
       WHERE id_menu = $8 RETURNING *`,
      [nama_menu ?? null, harga_satuan ?? null, hpp ?? null, updateStok, stok === '' ? null : stok, is_rekomendasi ?? null, is_aktif ?? null, id_menu, updateDesk, updateDesk && deskripsi ? String(deskripsi).trim() || null : null, id_kategori ?? null, diskonPersen]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Menu tidak ditemukan' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/menu/:id_menu', requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE menu SET is_aktif = FALSE WHERE id_menu = $1 RETURNING id_menu, nama_menu, is_aktif',
      [req.params.id_menu]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Menu tidak ditemukan' });
    res.json({ message: 'Menu dinonaktifkan', menu: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. DELIVERY WEBSITE ORDER ENDPOINTS
// ==========================================
app.post('/api/delivery', async (req, res) => {
  const { nama_pelanggan, no_telepon, alamat_lengkap, area_pengiriman, area_code = null, ongkir = 0, catatan_delivery = '', items = [] } = req.body;
  if (!nama_pelanggan || !no_telepon || !alamat_lengkap || !area_pengiriman || items.length === 0) {
    return res.status(400).json({ error: 'Data pelanggan, alamat, area, dan item pesanan wajib lengkap' });
  }

  const client = await db.getClient();
  try {
    await db.ensureMenuDiscountColumn();
    await client.query('BEGIN');

    let idPelanggan;
    const cekPelanggan = await client.query('SELECT id_pelanggan FROM pelanggan WHERE no_telepon = $1 LIMIT 1', [no_telepon.trim()]);
    if (cekPelanggan.rows.length > 0) {
      idPelanggan = cekPelanggan.rows[0].id_pelanggan;
      await client.query('UPDATE pelanggan SET nama_pelanggan = $1 WHERE id_pelanggan = $2', [nama_pelanggan.trim(), idPelanggan]);
    } else {
      const insPelanggan = await client.query('INSERT INTO pelanggan (nama_pelanggan, no_telepon) VALUES ($1, $2) RETURNING id_pelanggan', [nama_pelanggan.trim(), no_telepon.trim()]);
      idPelanggan = insPelanggan.rows[0].id_pelanggan;
    }

    // POS and Delivery share one serialized daily queue and the same receipt format.
    const { noStruk, noAntrian } = await generateOrderMeta(client, 'T01', req.body.no_struk);

    await client.query(
      `INSERT INTO transaksi (no_struk, tanggal_waktu, no_antrian, tipe_pesanan, nominal_bayar, persen_pajak, id_toko, id_metode, asal_pesanan, status_pesanan)
       VALUES ($1, NOW(), $2, 'Delivery', 0, 0, 'T01', 'MTD01', 'Website', 'Pending')`,
      [noStruk, noAntrian]
    );

    let subtotalBelanja = 0;
    for (const item of items) {
      const menuRes = await client.query(
        'SELECT harga_satuan, diskon_persen, stok, is_aktif FROM menu WHERE id_menu = $1 FOR UPDATE',
        [item.id_menu]
      );
      if (menuRes.rows.length === 0) throw new Error(`Menu dengan ID ${item.id_menu} tidak ditemukan`);
      const menuItem = menuRes.rows[0];
      if (!menuItem.is_aktif || menuItem.stok === 0) {
        throw new Error(`Menu ${item.id_menu} tidak tersedia`);
      }
      const qty = Number(item.qty);
      if (!Number.isInteger(qty) || qty < 1) throw new Error(`Jumlah menu ${item.id_menu} tidak valid`);
      const hargaSatuan = Number(menuItem.harga_satuan);
      const diskonItem = Math.round(hargaSatuan * Number(menuItem.diskon_persen) / 100) * qty;
      subtotalBelanja += hargaSatuan * qty - diskonItem;

      await client.query(
        `INSERT INTO detail_transaksi (no_struk, id_menu, qty, harga_satuan, diskon_item, catatan)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [noStruk, item.id_menu, qty, hargaSatuan, diskonItem, item.catatan || null]
      );
    }

    await client.query(
      `INSERT INTO detail_delivery (no_struk, id_pelanggan, alamat_lengkap, area_pengiriman, area_code, ongkir, catatan_delivery, status_delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending')`,
      [noStruk, idPelanggan, alamat_lengkap.trim(), area_pengiriman, area_code, ongkir, catatan_delivery]
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
        total_tagihan: subtotalBelanja + ongkir
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
      `SELECT v.*, v.tanggal_waktu::timestamptz AS waktu,
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

    await client.query('UPDATE detail_delivery SET status_delivery = $1, diperbarui_pada = NOW() WHERE no_struk = $2', [status_delivery, no_struk]);
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
  if (items.length === 0) return res.status(400).json({ error: 'Keranjang transaksi kosong' });

  const client = await db.getClient();
  try {
    await db.ensureMenuDiscountColumn();
    await client.query('BEGIN');
    const { noStruk, noAntrian } = await generateOrderMeta(client, id_toko);

    await client.query(
      `INSERT INTO transaksi (no_struk, tanggal_waktu, no_antrian, tipe_pesanan, nominal_bayar, persen_pajak, id_toko, id_karyawan, id_pos, id_metode, asal_pesanan, status_pesanan)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, 'POS', 'Completed')`,
      [noStruk, noAntrian, tipe_pesanan, nominal_bayar, persen_pajak, id_toko, id_karyawan, id_pos, id_metode]
    );

    for (const item of items) {
      const qty = Number(item.qty);
      if (!Number.isInteger(qty) || qty < 1) throw new Error(`Jumlah menu ${item.id_menu} tidak valid`);
      const menuRes = await client.query(
        'SELECT harga_satuan, diskon_persen FROM menu WHERE id_menu = $1 FOR UPDATE',
        [item.id_menu]
      );
      if (menuRes.rows.length === 0) throw new Error(`Menu dengan ID ${item.id_menu} tidak ditemukan`);
      const hargaSatuan = Number(menuRes.rows[0].harga_satuan);
      const diskonMenu = Math.round(hargaSatuan * Number(menuRes.rows[0].diskon_persen) / 100) * qty;
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

    const summary = await client.query('SELECT * FROM v_transaksi_total WHERE no_struk = $1', [noStruk]);
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
      SELECT v.*, v.tanggal_waktu::timestamptz AS waktu, t.asal_pesanan, t.status_pesanan, mp.nama_metode, k.nama_karyawan,
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