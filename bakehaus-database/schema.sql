CREATE EXTENSION IF NOT EXISTS pgcrypto;
DROP VIEW IF EXISTS v_delivery_orders, v_menu_master, v_users_staff, v_transaksi_total;
DROP TABLE IF EXISTS detail_delivery, pelanggan CASCADE;
DROP TABLE IF EXISTS order_tersimpan_item, order_tersimpan, detail_transaksi, transaksi,
                     users, menu, kategori_menu, metode_pembayaran, pos, karyawan, toko CASCADE;
DROP FUNCTION IF EXISTS fn_kurangi_stok();
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
    created_at     TIMESTAMP   NOT NULL DEFAULT NOW()
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
    hpp             INT          NOT NULL DEFAULT 0 CHECK (hpp >= 0),
    stok            INT          CHECK (stok >= 0),
    adonan          VARCHAR(20)  CHECK (adonan IN ('Kentang','Labu','Ubi')),
    rating_adonan   INT          CHECK (rating_adonan BETWEEN 1 AND 3),
    is_rekomendasi  BOOLEAN NOT NULL DEFAULT FALSE,
    is_aktif        BOOLEAN NOT NULL DEFAULT TRUE,
    CHECK ((adonan IS NULL) = (rating_adonan IS NULL))
);
CREATE TABLE transaksi (
    no_struk       VARCHAR(20) PRIMARY KEY,
    tanggal_waktu  TIMESTAMP   NOT NULL,
    no_antrian     INT         NOT NULL CHECK (no_antrian > 0),
    tipe_pesanan   VARCHAR(20) NOT NULL
                   CHECK (tipe_pesanan IN ('Dine In','Take Away','Delivery')),
    nominal_bayar  INT         NOT NULL DEFAULT 0 CHECK (nominal_bayar >= 0),
    persen_pajak   NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (persen_pajak >= 0),
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
CREATE UNIQUE INDEX ux_antrian_harian ON transaksi (id_toko, (tanggal_waktu::date), no_antrian);
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
    id_pelanggan  SERIAL PRIMARY KEY,
    nama_pelanggan VARCHAR(100) NOT NULL,
    no_telepon    VARCHAR(20) NOT NULL,
    dibuat_pada   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pelanggan_telepon ON pelanggan(no_telepon);
CREATE TABLE detail_delivery (
    no_struk       VARCHAR(20) PRIMARY KEY
                   REFERENCES transaksi(no_struk) ON DELETE CASCADE,
    id_pelanggan   INT NOT NULL REFERENCES pelanggan(id_pelanggan),
    alamat_lengkap TEXT NOT NULL,
    area_pengiriman VARCHAR(100) NOT NULL,
    ongkir         INT NOT NULL DEFAULT 0 CHECK (ongkir >= 0),
    catatan_delivery TEXT,
    status_delivery VARCHAR(20) NOT NULL DEFAULT 'Pending'
                    CHECK (status_delivery IN
                      ('Pending','Confirmed','Preparing','On Delivery','Completed','Cancelled')),
    dibuat_pada    TIMESTAMP NOT NULL DEFAULT NOW(),
    diperbarui_pada TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_detail_delivery_status ON detail_delivery(status_delivery);
CREATE INDEX idx_transaksi_asal_status ON transaksi(asal_pesanan, status_pesanan);
CREATE TABLE order_tersimpan (
    id_order_tersimpan  SERIAL PRIMARY KEY,
    label               VARCHAR(50) NOT NULL DEFAULT 'Tanpa nama',
    tipe_pesanan        VARCHAR(20) NOT NULL
                        CHECK (tipe_pesanan IN ('Dine In','Take Away','Delivery')),
    id_toko             VARCHAR(10) NOT NULL REFERENCES toko(id_toko),
    id_karyawan         VARCHAR(10) NOT NULL REFERENCES karyawan(id_karyawan),
    dibuat_pada         TIMESTAMP   NOT NULL DEFAULT NOW()
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
CREATE INDEX idx_menu_kategori   ON menu(id_kategori);
CREATE INDEX idx_menu_adonan     ON menu(adonan) WHERE adonan IS NOT NULL;
CREATE INDEX idx_detail_no_struk ON detail_transaksi(no_struk);
CREATE INDEX idx_detail_menu     ON detail_transaksi(id_menu);
CREATE INDEX idx_transaksi_waktu ON transaksi(tanggal_waktu);
CREATE FUNCTION fn_kurangi_stok() RETURNS trigger AS $$
DECLARE
    stok_tersedia INT;
BEGIN
    SELECT stok INTO stok_tersedia
    FROM menu
    WHERE id_menu = NEW.id_menu
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Menu % tidak ditemukan', NEW.id_menu;
    END IF;
    IF stok_tersedia IS NOT NULL THEN
        IF stok_tersedia < NEW.qty THEN
            RAISE EXCEPTION 'Stok menu % tidak mencukupi. Tersedia: %, diminta: %',
                NEW.id_menu, stok_tersedia, NEW.qty;
        END IF;
        UPDATE menu
        SET stok = stok - NEW.qty
        WHERE id_menu = NEW.id_menu;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_kurangi_stok
BEFORE INSERT ON detail_transaksi
FOR EACH ROW EXECUTE FUNCTION fn_kurangi_stok();
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
INSERT INTO menu (id_menu, sku, id_kategori, nama_menu, harga_satuan, is_rekomendasi, adonan, rating_adonan)
SELECT s.id_menu,
       'SKU-' || s.kode_kategori || '-' ||
         LPAD(ROW_NUMBER() OVER (PARTITION BY s.id_kategori ORDER BY s.pos)::text, 3, '0'),
       s.id_kategori, s.nama, s.harga, s.rek, s.adonan, s.rating
FROM (
    SELECT CASE t.nama
             WHEN 'Nasi Ayam Mentai' THEN 'M001'
             WHEN 'Milk Chocolate'   THEN 'M002'
             WHEN 'Cafe Latte'       THEN 'M003'
             WHEN 'Lemon Tea'        THEN 'M004'
             WHEN 'Oreo Cheesecake'  THEN 'M005'
             ELSE 'M' || LPAD((5 + ROW_NUMBER() OVER (PARTITION BY t.is_contoh ORDER BY t.pos))::text, 3, '0')
           END AS id_menu,
           t.pos, t.id_kategori, t.kode_kategori, t.nama, t.harga, t.rek, t.adonan, t.rating
    FROM (
        SELECT p.pos,
               (p.nama IN ('Nasi Ayam Mentai','Milk Chocolate','Cafe Latte','Lemon Tea','Oreo Cheesecake')) AS is_contoh,
               k.id_kategori, k.kode_kategori, p.nama, p.harga, p.rek, p.adonan, p.rating
        FROM (
            SELECT ROW_NUMBER() OVER () AS pos, v.kat, v.nama, v.harga, v.rek,
                   NULL::varchar AS adonan, NULL::int AS rating
            FROM (VALUES
              ('Food','Nasi Goreng',15000,true),
              ('Food','Bakmie',15000,false),
              ('Food','Nasi Ayam Cabe Garam',15000,true),
              ('Food','Nasi Ayam Salted Egg',15000,true),
              ('Food','Nasi Ayam Mentai',15000,true),
              ('Food','Nasi Ayam Gochujang',15000,false),
              ('Food','Nasi Ayam Hot Lava',15000,false),
              ('Food','Nasi Ayam Keju',15000,false),
              ('Food','Nasi Ayam Pok-pok',15000,false),
              ('Food','Sawi Telor',15000,false),
              ('Food','Nasi Cap Cay',20000,true),
              ('Food','Fuyunghai',20000,false),
              ('Food','Nasi Katsu Ori',20000,false),
              ('Food','Nasi Ayam Koloke',20000,false),
              ('Food','Nasi Ayam Mentega',20000,false),
              ('Food','Nasi Katsu Curry',25000,false),
              ('Food','Dish Of The Day 15K',15000,false),
              ('Food','Dish Of The Day 20K',20000,false),
              ('Add On','Add On Nasi Putih',5000,false),
              ('Add On','Add On Ayam Pok-Pok',5000,false),
              ('Add On','Add On Katsu (per strip)',7500,false),
              ('Snack','French Fries',15000,false),
              ('Snack','Nugget',15000,false),
              ('Snack','Sausage',15000,false),
              ('Snack','Snack Platter',15000,false),
              ('Snack','Dimsum Mentai',15000,false),
              ('Snack','Risol',10000,false),
              ('Coffee','Bakehaus Coffee',20000,true),
              ('Coffee','Yin Yang Coffee',18000,false),
              ('Coffee','Cafe Latte',15000,true),
              ('Coffee','Butterscotch Coffee',15000,true),
              ('Coffee','Hazelnut Coffee',15000,true),
              ('Coffee','Brown Sugar Coffee',15000,false),
              ('Coffee','Salt Caramel Coffee',15000,false),
              ('Coffee','Americano',15000,true),
              ('Coffee','Long Black',15000,false),
              ('Coffee','Add On Shot',5000,false),
              ('Non-Coffee','Tea',5000,false),
              ('Non-Coffee','Lychee Tea',8000,true),
              ('Non-Coffee','Peach Tea',8000,false),
              ('Non-Coffee','Lemon Tea',8000,false),
              ('Non-Coffee','Greentea',8000,true),
              ('Non-Coffee','Taro Tea',8000,false),
              ('Non-Coffee','Chocolate Tea',8000,true),
              ('Non-Coffee','Thai Tea',15000,true),
              ('Non-Coffee','Bakehaus Tea',15000,true),
              ('Non-Coffee','Milk Chocolate',15000,true),
              ('Non-Coffee','Pistachio Matcha',15000,false),
              ('Non-Coffee','Matcha Latte',15000,true),
              ('Non-Coffee','Passion Fruit Tea',10000,false),
              ('Non-Coffee','Bakehaus Chocolate',20000,false),
              ('Non-Coffee','Aquviva',5000,false),
              ('Non-Coffee','Wintermelon',10000,false),
              ('Bread','Salt Bread Ori',8000,false),
              ('Bread','Salt Strawberry Cream',13000,false),
              ('Bread','Sourdough Cranberry Cheese',28000,false),
              ('Bread','Sourdough Chocolate',28000,false),
              ('Bread','Roti Pisang Ori',10000,false),
              ('Bread','Roti Pisang Coklat',10000,false),
              ('Bread','Roti Pisang Coklat Keju',10000,false),
              ('Dessert','Cheesecake Ori',28000,false),
              ('Dessert','Matcha Cheesecake',28000,false),
              ('Dessert','Iceberg',28000,false),
              ('Dessert','Brownies Cheesecake',28000,false),
              ('Dessert','Blackforest',30000,false),
              ('Dessert','Brownies',23000,false),
              ('Dessert','Tiramisu',29000,false),
              ('Dessert','Brownies Pudding',15000,false),
              ('Dessert','Strawberry Cheesecake',28000,false),
              ('Dessert','Mini Cookies',10000,false),
              ('Dessert','Pudding Jelly Cheesecake',15000,false),
              ('Dessert','Dubai Chewy Cookie',35000,false),
              ('Dessert','Oreo Cheesecake',28000,false)
            ) AS v(kat, nama, harga, rek)
            UNION ALL
            SELECT 1000 + ROW_NUMBER() OVER (ORDER BY d.n, a.o) AS pos,
                   'Donut', 'Donut ' || d.rasa || ' - ' || a.adonan, d.harga, false,
                   a.adonan::varchar, a.rating
            FROM (VALUES
              ( 1,'Keju',        10000, 2,3,1),
              ( 2,'Meses',       10000, 3,2,1),
              ( 3,'Kacang',      10000, 2,1,3),
              ( 4,'Red Velvet',  10000, 1,3,2),
              ( 5,'Greentea',    10000, 2,1,3),
              ( 6,'Strawberry',  10000, 1,3,2),
              ( 7,'Tiramisu',    10000, 3,1,2),
              ( 8,'Susu',        10000, 2,3,1),
              ( 9,'Banana Milk', 10000, 3,1,2),
              (10,'Caramel',     10000, 2,3,1),
              (11,'Oreo',        10000, 1,3,2),
              (12,'Creamcheese', 10000, 2,1,3),
              (13,'Chocowhite',  10000, 1,3,2),
              (14,'Cappuccino',  10000, 2,1,3),
              (15,'Mango',       10000, 2,3,1),
              (16,'Pizza',       13000, 1,3,2),
              (17,'Smoked Beef', 13000, 2,1,3)
            ) AS d(n, rasa, harga, rk, rl, ru)
            CROSS JOIN LATERAL (VALUES
              (1,'Kentang',d.rk), (2,'Labu',d.rl), (3,'Ubi',d.ru)
            ) AS a(o, adonan, rating)
        ) p
        JOIN kategori_menu k ON k.nama_kategori = p.kat
    ) t
) s;
INSERT INTO transaksi
  (no_struk, tanggal_waktu, no_antrian, tipe_pesanan, nominal_bayar, persen_pajak,
   id_toko, id_karyawan, id_pos, id_metode)
VALUES
  ('#1-15367', '2026-10-14 15:14', 1, 'Dine In', 81000, 0, 'T01', 'E01', 'P01', 'MTD01');
INSERT INTO detail_transaksi (no_struk, id_menu, qty, harga_satuan) VALUES
('#1-15367', 'M001', 1, 15000),
('#1-15367', 'M002', 1, 15000),
('#1-15367', 'M003', 1, 15000),
('#1-15367', 'M004', 1,  8000),
('#1-15367', 'M005', 1, 28000);
CREATE VIEW v_transaksi_total AS
SELECT x.*,
       x.subtotal - x.diskon + x.pajak                      AS total_tagihan,
       x.nominal_bayar - (x.subtotal - x.diskon + x.pajak)  AS kembalian
FROM (
    SELECT t.no_struk, t.tanggal_waktu, t.no_antrian, t.tipe_pesanan,
           t.id_toko, t.id_karyawan, t.id_pos, t.id_metode,
           COALESCE(s.subtotal, 0) AS subtotal,
           COALESCE(s.diskon, 0)   AS diskon,
           ROUND((COALESCE(s.subtotal, 0) - COALESCE(s.diskon, 0)) * t.persen_pajak / 100)::INT AS pajak,
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
    dd.area_code,
    dd.ongkir,
    dd.catatan_delivery,
    vt.subtotal,
    vt.diskon,
    vt.pajak,
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
       m.harga_satuan AS harga, m.hpp,
       COALESCE(t.terjual, 0) AS terjual,
       m.stok,
       CASE WHEN m.stok IS NULL THEN 'Ready ∞'
            WHEN m.stok > 0     THEN m.stok::text || ' pcs'
            ELSE 'Habis' END   AS status_stok,
       m.adonan,
       m.is_rekomendasi,
       m.is_aktif AS aktif
FROM menu m
JOIN kategori_menu k ON k.id_kategori = m.id_kategori
LEFT JOIN (
    SELECT id_menu, SUM(qty)::INT AS terjual
    FROM detail_transaksi
    GROUP BY id_menu
) t ON t.id_menu = m.id_menu;
CREATE VIEW v_users_staff AS
SELECT u.id_user, k.nama_karyawan AS nama, u.username, u.role, u.is_aktif
FROM users u
JOIN karyawan k ON k.id_karyawan = u.id_karyawan;
SELECT t.no_struk, t.no_antrian, t.tanggal_waktu, t.tipe_pesanan, mp.nama_metode,
       m.sku, m.nama_menu, d.qty, d.harga_satuan, d.subtotal_item, d.diskon_item, d.catatan
FROM transaksi t
JOIN detail_transaksi d     ON d.no_struk = t.no_struk
JOIN menu m                 ON m.id_menu = d.id_menu
JOIN metode_pembayaran mp   ON mp.id_metode = t.id_metode
WHERE t.no_struk = '#1-15367'
ORDER BY d.id_detail;
SELECT no_struk, no_antrian, subtotal, diskon, pajak, total_tagihan, nominal_bayar, kembalian
FROM v_transaksi_total;
SELECT * FROM v_transaksi_total WHERE kembalian < 0;
SELECT DATE(tanggal_waktu) AS tanggal, COUNT(*) AS jumlah_transaksi,
       SUM(total_tagihan) AS omzet
FROM v_transaksi_total
GROUP BY DATE(tanggal_waktu)
ORDER BY tanggal;
SELECT m.sku, m.nama_menu, k.nama_kategori, SUM(d.qty) AS total_terjual,
       SUM(d.subtotal_item - d.diskon_item) AS total_pendapatan
FROM detail_transaksi d
JOIN menu m          ON m.id_menu = d.id_menu
JOIN kategori_menu k ON k.id_kategori = m.id_kategori
GROUP BY m.sku, m.nama_menu, k.nama_kategori
ORDER BY total_terjual DESC;
SELECT mp.nama_metode, COUNT(*) AS jumlah, SUM(v.total_tagihan) AS total
FROM v_transaksi_total v JOIN metode_pembayaran mp ON mp.id_metode = v.id_metode
GROUP BY mp.nama_metode;
SELECT k.kelompok, k.nama_kategori, m.sku, m.nama_menu, m.harga_satuan,
       CASE WHEN m.is_rekomendasi THEN '★' ELSE '' END AS rekomendasi
FROM menu m JOIN kategori_menu k ON k.id_kategori = m.id_kategori
WHERE m.is_aktif
ORDER BY k.urutan, m.sku;
SELECT sku, nama_menu, adonan, rating_adonan AS bintang, harga_satuan, stok
FROM menu WHERE adonan IS NOT NULL
ORDER BY sku;
SELECT m.adonan, SUM(d.qty) AS terjual, SUM(d.subtotal_item - d.diskon_item) AS pendapatan
FROM detail_transaksi d JOIN menu m ON m.id_menu = d.id_menu
WHERE m.adonan IS NOT NULL
GROUP BY m.adonan
ORDER BY terjual DESC;
SELECT * FROM v_menu_master ORDER BY sku;
SELECT * FROM v_menu_master
WHERE (nama_menu ILIKE '%nasi%' OR sku ILIKE '%nasi%')
ORDER BY sku;
SELECT * FROM v_menu_master WHERE stok IS NOT NULL AND stok <= 6 ORDER BY stok, sku;
SELECT * FROM v_users_staff ORDER BY id_user;
SELECT u.id_user, k.nama_karyawan AS nama, u.role
FROM users u
JOIN karyawan k ON k.id_karyawan = u.id_karyawan
WHERE u.username = 'admin'
  AND u.is_aktif
  AND u.password_hash = crypt('admin123', u.password_hash);
SELECT k.nama_karyawan, COUNT(*) AS jumlah_transaksi, SUM(v.total_tagihan) AS total_omzet
FROM v_transaksi_total v
JOIN karyawan k ON k.id_karyawan = v.id_karyawan
GROUP BY k.nama_karyawan
ORDER BY total_omzet DESC;
SELECT *
FROM v_delivery_orders
ORDER BY tanggal_waktu DESC;
ALTER TABLE detail_delivery ADD COLUMN IF NOT EXISTS area_code VARCHAR(30);