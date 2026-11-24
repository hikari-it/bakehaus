CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP VIEW IF EXISTS v_delivery_orders, v_menu_master, v_users_staff, v_transaksi_total;
DROP TABLE IF EXISTS menu_label, addon_target_category, custom_labels, label_menu CASCADE;
DROP TABLE IF EXISTS detail_delivery, pelanggan CASCADE;
DROP TABLE IF EXISTS order_tersimpan_item, order_tersimpan, detail_transaksi, transaksi,
                     delivery_idempotency, bakehaus_schema_migrations, users, menu, kategori_menu, metode_pembayaran, pos, karyawan, toko CASCADE;
DROP FUNCTION IF EXISTS fn_kurangi_stok();

-- ==========================================
-- 1. MASTER TABLES
-- ==========================================
CREATE TABLE toko (
    id_toko      VARCHAR(10)  PRIMARY KEY,
    nama_toko    VARCHAR(100) NOT NULL,
    alamat_toko  TEXT         NOT NULL
);

CREATE TABLE karyawan (
    id_karyawan    VARCHAR(10)  PRIMARY KEY,
    nama_karyawan  VARCHAR(100) NOT NULL,
    jabatan        VARCHAR(50)
);

CREATE TABLE users (
    id_user        SERIAL PRIMARY KEY,
    id_karyawan    VARCHAR(10) NOT NULL UNIQUE REFERENCES karyawan(id_karyawan),
    username       VARCHAR(50) NOT NULL UNIQUE CHECK (username = LOWER(username)),
    password_hash  TEXT        NOT NULL,
    role           VARCHAR(20) NOT NULL CHECK (role IN ('admin','kasir')),
    is_aktif       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMP   NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta')
);

CREATE TABLE pos (
    id_pos    VARCHAR(10) PRIMARY KEY,
    nama_pos  VARCHAR(50) NOT NULL
);

CREATE TABLE metode_pembayaran (
    id_metode    VARCHAR(10) PRIMARY KEY,
    nama_metode  VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE kategori_menu (
    id_kategori    VARCHAR(10) PRIMARY KEY,
    nama_kategori  VARCHAR(50) NOT NULL UNIQUE,
    kode_kategori  VARCHAR(3)  NOT NULL UNIQUE CHECK (kode_kategori ~ '^[A-Z]{3}$'),
    kelompok       VARCHAR(30) NOT NULL,
    urutan         INT NOT NULL DEFAULT 0
);

CREATE TABLE menu (
    id_menu         VARCHAR(10)  PRIMARY KEY,
    sku             VARCHAR(20)  NOT NULL UNIQUE
                    CHECK (sku ~ '^SKU-[A-Z]{3}-[0-9]{3,}$'),
    id_kategori     VARCHAR(10)  NOT NULL REFERENCES kategori_menu(id_kategori),
    nama_menu       VARCHAR(100) NOT NULL UNIQUE,
    harga_satuan    INT          NOT NULL CHECK (harga_satuan >= 0),
    diskon_persen   INT          NOT NULL DEFAULT 0 CHECK (diskon_persen BETWEEN 0 AND 100),
    stok            INT          CHECK (stok >= 0),
    adonan          VARCHAR(20)  CHECK (adonan IN ('Kentang','Labu','Ubi')),
    rating_adonan   INT          CHECK (rating_adonan BETWEEN 1 AND 3),
    is_rekomendasi  BOOLEAN NOT NULL DEFAULT FALSE,
    is_baru_manual  BOOLEAN NOT NULL DEFAULT FALSE,
    is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
    varian_menu     TEXT[] NOT NULL DEFAULT '{}',
    is_aktif        BOOLEAN NOT NULL DEFAULT TRUE,
    deskripsi       TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta'),
    CHECK ((adonan IS NULL) = (rating_adonan IS NULL))
);

CREATE TABLE bakehaus_schema_migrations (
    migration_key TEXT PRIMARY KEY,
    applied_at    TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta')
);

-- ==========================================
-- 2. TRANSACTION & DELIVERY TABLES
-- ==========================================
CREATE TABLE transaksi (
    no_struk       VARCHAR(20) PRIMARY KEY,
    tanggal_waktu  TIMESTAMP   NOT NULL,
    no_antrian     INT         NOT NULL CHECK (no_antrian > 0),
    tipe_pesanan   VARCHAR(20) NOT NULL
                   CHECK (tipe_pesanan IN ('Dine In','Take Away','Delivery')),
    nominal_bayar  INT         NOT NULL DEFAULT 0 CHECK (nominal_bayar >= 0),
    id_toko        VARCHAR(10) NOT NULL REFERENCES toko(id_toko),
    id_karyawan    VARCHAR(10) REFERENCES karyawan(id_karyawan),
    id_pos         VARCHAR(10) REFERENCES pos(id_pos),
    id_metode      VARCHAR(10) REFERENCES metode_pembayaran(id_metode),
    asal_pesanan   VARCHAR(20) NOT NULL DEFAULT 'POS'
                   CHECK (asal_pesanan IN ('POS','Website')),
    status_pesanan VARCHAR(20) NOT NULL DEFAULT 'Completed'
                   CHECK (status_pesanan IN
                     ('Pending','Confirmed','Preparing','On Delivery','Completed','Cancelled'))
);

CREATE UNIQUE INDEX ux_antrian_harian ON transaksi (
    id_toko,
    (tanggal_waktu::date),
    no_antrian
);

CREATE TABLE detail_transaksi (
    id_detail      SERIAL PRIMARY KEY,
    no_struk       VARCHAR(20) NOT NULL REFERENCES transaksi(no_struk) ON DELETE CASCADE,
    id_menu        VARCHAR(10) NOT NULL REFERENCES menu(id_menu),
    qty            INT NOT NULL CHECK (qty > 0),
    harga_satuan   INT NOT NULL CHECK (harga_satuan >= 0),
    subtotal_item  INT GENERATED ALWAYS AS (qty * harga_satuan) STORED,
    diskon_item    INT NOT NULL DEFAULT 0 CHECK (diskon_item >= 0),
    catatan        TEXT,
    CHECK (diskon_item <= qty * harga_satuan)
);

CREATE TABLE pelanggan (
    id_pelanggan   SERIAL PRIMARY KEY,
    nama_pelanggan VARCHAR(100) NOT NULL,
    no_telepon     VARCHAR(20) NOT NULL,
    dibuat_pada    TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta')
);

CREATE INDEX idx_pelanggan_telepon ON pelanggan(no_telepon);

CREATE TABLE detail_delivery (
    no_struk         VARCHAR(20) PRIMARY KEY
                     REFERENCES transaksi(no_struk) ON DELETE CASCADE,
    id_pelanggan     INT NOT NULL REFERENCES pelanggan(id_pelanggan),
    alamat_lengkap   TEXT NOT NULL,
    area_pengiriman  VARCHAR(100) NOT NULL,
    ongkir           INT NOT NULL DEFAULT 0 CHECK (ongkir >= 0),
    catatan_delivery TEXT,
    status_delivery  VARCHAR(20) NOT NULL DEFAULT 'Pending'
                     CHECK (status_delivery IN
                       ('Pending','Confirmed','Preparing','On Delivery','Completed','Cancelled')),
    dibuat_pada      TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta'),
    diperbarui_pada  TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta')
);

CREATE INDEX idx_detail_delivery_status ON detail_delivery(status_delivery);

CREATE TABLE delivery_idempotency (
    idempotency_key UUID PRIMARY KEY,
    response        JSONB,
    created_at      TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta')
);

CREATE TABLE custom_labels (
    id_label   SERIAL PRIMARY KEY,
    nama_label VARCHAR(50) NOT NULL UNIQUE,
    warna      VARCHAR(7) NOT NULL DEFAULT '#64748b' CHECK (warna ~ '^#[0-9A-Fa-f]{6}$')
);

CREATE TABLE menu_label (
    id_menu  VARCHAR(10) NOT NULL REFERENCES menu(id_menu) ON DELETE CASCADE,
    id_label INT NOT NULL REFERENCES custom_labels(id_label) ON DELETE CASCADE,
    PRIMARY KEY (id_menu, id_label)
);

CREATE TABLE addon_target_category (
    id_menu     VARCHAR(10) NOT NULL REFERENCES menu(id_menu) ON DELETE CASCADE,
    id_kategori VARCHAR(10) NOT NULL REFERENCES kategori_menu(id_kategori) ON DELETE CASCADE,
    PRIMARY KEY (id_menu, id_kategori)
);

CREATE TABLE order_tersimpan (
    id_order_tersimpan  SERIAL PRIMARY KEY,
    label               VARCHAR(50) NOT NULL DEFAULT 'Tanpa nama',
    tipe_pesanan        VARCHAR(20) NOT NULL
                        CHECK (tipe_pesanan IN ('Dine In','Take Away','Delivery')),
    id_toko             VARCHAR(10) NOT NULL REFERENCES toko(id_toko),
    id_karyawan         VARCHAR(10) NOT NULL REFERENCES karyawan(id_karyawan),
    dibuat_pada         TIMESTAMP   NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta')
);

CREATE TABLE order_tersimpan_item (
    id_item             SERIAL PRIMARY KEY,
    id_order_tersimpan  INT         NOT NULL REFERENCES order_tersimpan(id_order_tersimpan) ON DELETE CASCADE,
    id_menu             VARCHAR(10) NOT NULL REFERENCES menu(id_menu),
    qty                 INT         NOT NULL CHECK (qty > 0),
    tipe_diskon         VARCHAR(2)  NOT NULL DEFAULT '%' CHECK (tipe_diskon IN ('%','rp')),
    nilai_diskon        NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (nilai_diskon >= 0),
    catatan             TEXT
);

-- ==========================================
-- 3. INDEXES
-- ==========================================
CREATE INDEX idx_transaksi_asal_status ON transaksi(asal_pesanan, status_pesanan);
CREATE INDEX idx_menu_kategori         ON menu(id_kategori);
CREATE INDEX idx_menu_adonan           ON menu(adonan) WHERE adonan IS NOT NULL;
CREATE INDEX idx_detail_no_struk       ON detail_transaksi(no_struk);
CREATE INDEX idx_detail_menu           ON detail_transaksi(id_menu);
CREATE INDEX idx_transaksi_waktu       ON transaksi(tanggal_waktu);

-- ==========================================
-- 4. CORE SYSTEM SEED
-- ==========================================
INSERT INTO toko VALUES ('T01', 'Bake Haus', 'Mansion Valley D6');

INSERT INTO karyawan (id_karyawan, nama_karyawan, jabatan) VALUES
('E01', 'Owner',         'Owner'),
('E02', 'Administrator', 'Admin'),
('E03', 'Kasir 1',       'Kasir');

INSERT INTO users (id_karyawan, username, password_hash, role) VALUES
('E02', 'admin', crypt('admin123', gen_salt('bf')), 'admin'),
('E03', 'kasir', crypt('kasir123', gen_salt('bf')), 'kasir');

INSERT INTO pos VALUES ('P01', 'POS 1');

INSERT INTO metode_pembayaran VALUES
('MTD01', 'QRIS'),
('MTD02', 'Tunai'),
('MTD03', 'Debit');

INSERT INTO kategori_menu (id_kategori, nama_kategori, kode_kategori, kelompok, urutan) VALUES
('K01','Food',       'FOO','Food',    1),
('K02','Add On',     'ADD','Food',    2),
('K03','Snack',      'SNA','Food',    3),
('K04','Coffee',     'COF','Beverage',4),
('K05','Non-Coffee', 'NON','Beverage',5),
('K06','Donut',      'DON','Bakery',  6),
('K07','Bread',      'BRE','Bakery',  7),
('K08','Dessert',    'DES','Bakery',  8);

INSERT INTO custom_labels (nama_label, warna) VALUES
('Pedas', '#dc2626');

INSERT INTO bakehaus_schema_migrations (migration_key)
VALUES ('legacy-menu-variants-v1'), ('backdate-seeded-menu-v1');

-- ==========================================
-- 5. VIEWS
-- ==========================================
CREATE VIEW v_transaksi_total AS
SELECT x.*,
       x.subtotal - x.diskon                      AS total_tagihan,
       x.nominal_bayar - (x.subtotal - x.diskon)  AS kembalian
FROM (
    SELECT t.no_struk, t.tanggal_waktu, t.no_antrian, t.tipe_pesanan,
           t.id_toko, t.id_karyawan, t.id_pos, t.id_metode,
           COALESCE(s.subtotal, 0) AS subtotal,
           COALESCE(s.diskon, 0)   AS diskon,
           t.nominal_bayar
    FROM transaksi t
    LEFT JOIN (
        SELECT no_struk, SUM(subtotal_item)::INT AS subtotal, SUM(diskon_item)::INT AS diskon
        FROM detail_transaksi
        GROUP BY no_struk
    ) s ON s.no_struk = t.no_struk
) x;

CREATE OR REPLACE VIEW v_delivery_orders AS
SELECT
    t.no_struk,
    t.tanggal_waktu,
    t.no_antrian,
    t.status_pesanan,
    dd.status_delivery,
    p.nama_pelanggan,
    p.no_telepon,
    dd.alamat_lengkap,
    dd.area_pengiriman,
    dd.ongkir,
    dd.catatan_delivery,
    vt.subtotal,
    vt.diskon,
    (vt.total_tagihan + dd.ongkir) AS total_tagihan,
    t.nominal_bayar,
    t.id_karyawan,
    t.id_pos
FROM transaksi t
JOIN detail_delivery dd ON dd.no_struk = t.no_struk
JOIN pelanggan p ON p.id_pelanggan = dd.id_pelanggan
JOIN v_transaksi_total vt ON vt.no_struk = t.no_struk
WHERE t.tipe_pesanan = 'Delivery';

CREATE OR REPLACE VIEW v_menu_master AS
SELECT m.id_menu, m.sku, m.nama_menu, k.nama_kategori AS category,
       m.harga_satuan AS harga,
       COALESCE(t.terjual, 0) AS terjual,
       m.stok,
       CASE WHEN m.stok IS NULL THEN 'Ready ∞'
            WHEN m.stok > 0     THEN m.stok::text || ' pcs'
            ELSE 'Habis' END   AS status_stok,
       m.adonan,
       m.is_rekomendasi,
       m.is_aktif AS aktif,
       m.deskripsi
FROM menu m
JOIN kategori_menu k ON k.id_kategori = m.id_kategori
LEFT JOIN (
    SELECT id_menu, SUM(qty)::INT AS terjual
    FROM detail_transaksi
    GROUP BY id_menu
) t ON t.id_menu = m.id_menu
WHERE m.is_deleted = FALSE;

CREATE VIEW v_users_staff AS
SELECT u.id_user, k.nama_karyawan AS nama, u.username, u.role, u.is_aktif
FROM users u
JOIN karyawan k ON k.id_karyawan = u.id_karyawan;