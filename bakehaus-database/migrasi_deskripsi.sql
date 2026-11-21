ALTER TABLE menu ADD COLUMN IF NOT EXISTS deskripsi TEXT;
COMMENT ON COLUMN menu.deskripsi IS 'Deskripsi menu, tampil di website delivery';

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
       m.is_aktif AS aktif,
       m.deskripsi
FROM menu m
JOIN kategori_menu k ON k.id_kategori = m.id_kategori
LEFT JOIN (
    SELECT id_menu, SUM(qty)::INT AS terjual
    FROM detail_transaksi
    GROUP BY id_menu
) t ON t.id_menu = m.id_menu;

UPDATE menu m
SET deskripsi = v.d
FROM (VALUES
  ('nasigoreng', 'Nasi goreng dengan pilihan bumbu putih, kecap, atau merah. Porsi pas buat makan siang.'),
  ('bakmie', 'Bakmie gurih dengan topping khas Bakehaus.'),
  ('nasiayamcabegaram', 'Ayam renyah ditumis cabe garam, gurih dan pedas, disajikan dengan nasi.'),
  ('nasiayamsaltedegg', 'Ayam goreng dibalut saus salted egg yang creamy dan gurih, disajikan dengan nasi.'),
  ('nasiayammentai', 'Ayam dengan saus mentai creamy, disajikan dengan nasi.'),
  ('nasiayamgochujang', 'Ayam berbumbu gochujang ala Korea, manis pedas, disajikan dengan nasi.'),
  ('nasiayamhotlava', 'Ayam dengan saus hot lava yang pedas menyengat, disajikan dengan nasi.'),
  ('nasiayamkeju', 'Ayam dengan saus keju yang lumer, disajikan dengan nasi.'),
  ('nasiayampokpok', 'Ayam pok-pok renyah ala street food, disajikan dengan nasi.'),
  ('sawitelor', 'Tumis sawi dan telur yang ringan dan gurih, disajikan dengan nasi.'),
  ('nasicapcay', 'Tumis aneka sayur dengan kuah kental gurih, disajikan dengan nasi.'),
  ('fuyunghai', 'Telur dadar ala Chinese food dengan saus kental, disajikan dengan nasi.'),
  ('nasikatsuori', 'Chicken katsu renyah dengan saus katsu, disajikan dengan nasi.'),
  ('nasiayamkoloke', 'Ayam goreng tepung dengan saus asam manis ala koloke, disajikan dengan nasi.'),
  ('nasiayammentega', 'Ayam dengan saus mentega yang gurih manis, disajikan dengan nasi.'),
  ('nasikatsucurry', 'Chicken katsu renyah dengan saus kari ala Jepang, disajikan dengan nasi.'),
  ('dishoftheday', 'Menu spesial yang berganti setiap hari.'),
  ('frenchfries', 'Kentang goreng renyah, cocok buat camilan.'),
  ('nugget', 'Nugget ayam goreng, hangat dan renyah.'),
  ('sausage', 'Sosis goreng yang gurih.'),
  ('snackplatter', 'Campuran camilan goreng untuk ngemil bareng.'),
  ('dimsummentai', 'Dimsum dengan saus mentai yang creamy.'),
  ('risol', 'Risol isi gurih, digoreng renyah.'),
  ('bakehauscoffee', 'Signature coffee Bakehaus, creamy dan seimbang.'),
  ('yinyangcoffee', 'Perpaduan kopi dan teh dalam satu gelas.'),
  ('cafelatte', 'Espresso dengan susu, lembut dan ringan.'),
  ('butterscotchcoffee', 'Kopi susu dengan rasa butterscotch yang manis legit.'),
  ('hazelnutcoffee', 'Kopi susu dengan aroma hazelnut yang wangi.'),
  ('brownsugarcoffee', 'Kopi susu dengan manis gula aren/brown sugar.'),
  ('saltcaramelcoffee', 'Kopi susu dengan karamel manis asin.'),
  ('americano', 'Espresso dengan air, ringan dan segar.'),
  ('longblack', 'Espresso pekat dengan air, kuat dan bold.'),
  ('addonshot', 'Tambahan satu shot espresso.'),
  ('tea', 'Teh klasik yang menyegarkan.'),
  ('lycheetea', 'Teh dengan rasa leci yang segar.'),
  ('peachtea', 'Teh dengan rasa peach yang manis segar.'),
  ('lemontea', 'Teh dengan perasan lemon, segar dan asam manis.'),
  ('greentea', 'Minuman teh hijau yang segar.'),
  ('tarotea', 'Minuman rasa taro yang manis dan lembut.'),
  ('chocolatetea', 'Perpaduan teh dan coklat.'),
  ('thaitea', 'Thai tea manis dan creamy.'),
  ('bakehaustea', 'Signature tea ala Bakehaus.'),
  ('milkchocolate', 'Coklat susu yang manis dan lembut.'),
  ('pistachiomatcha', 'Matcha dengan sentuhan rasa pistachio.'),
  ('matchalatte', 'Matcha dengan susu, creamy dan segar.'),
  ('passionfruittea', 'Teh dengan rasa markisa yang segar asam manis.'),
  ('bakehauschocolate', 'Signature coklat Bakehaus yang pekat dan manis.'),
  ('aquviva', 'Air mineral Aquviva.'),
  ('wintermelon', 'Minuman wintermelon yang manis dan menyegarkan.'),
  ('donutkeju', 'Donut empuk rasa Keju. Pilih adonan kentang, labu, atau ubi.'),
  ('donutmeses', 'Donut empuk rasa Meses. Pilih adonan kentang, labu, atau ubi.'),
  ('donutkacang', 'Donut empuk rasa Kacang. Pilih adonan kentang, labu, atau ubi.'),
  ('donutredvelvet', 'Donut empuk rasa Red Velvet. Pilih adonan kentang, labu, atau ubi.'),
  ('donutgreentea', 'Donut empuk rasa Greentea. Pilih adonan kentang, labu, atau ubi.'),
  ('donutstrawberry', 'Donut empuk rasa Strawberry. Pilih adonan kentang, labu, atau ubi.'),
  ('donuttiramisu', 'Donut empuk rasa Tiramisu. Pilih adonan kentang, labu, atau ubi.'),
  ('donutsusu', 'Donut empuk rasa Susu. Pilih adonan kentang, labu, atau ubi.'),
  ('donutbananamilk', 'Donut empuk rasa Banana Milk. Pilih adonan kentang, labu, atau ubi.'),
  ('donutcaramel', 'Donut empuk rasa Caramel. Pilih adonan kentang, labu, atau ubi.'),
  ('donutoreo', 'Donut empuk rasa Oreo. Pilih adonan kentang, labu, atau ubi.'),
  ('donutcreamcheese', 'Donut empuk rasa Creamcheese. Pilih adonan kentang, labu, atau ubi.'),
  ('donutchocowhite', 'Donut empuk rasa Chocowhite. Pilih adonan kentang, labu, atau ubi.'),
  ('donutcappuccino', 'Donut empuk rasa Cappuccino. Pilih adonan kentang, labu, atau ubi.'),
  ('donutmango', 'Donut empuk rasa Mango. Pilih adonan kentang, labu, atau ubi.'),
  ('donutpizza', 'Donut gurih dengan topping ala pizza. Pilih adonan kentang, labu, atau ubi.'),
  ('donutsmokedbeef', 'Donut gurih dengan smoked beef. Pilih adonan kentang, labu, atau ubi.'),
  ('saltbreadori', 'Salt bread lembut dengan rasa gurih asin yang pas.'),
  ('saltstrawberrycream', 'Salt bread dengan krim stroberi yang manis.'),
  ('sourdough', 'Roti sourdough pilihan isi cranberry cheese atau chocolate.'),
  ('rotipisang', 'Roti isi pisang, pilih ori, coklat, atau coklat keju.'),
  ('nasiputih', 'Tambahan seporsi nasi putih.'),
  ('ayampokpok', 'Tambahan ayam pok-pok renyah.'),
  ('katsuperstrip', 'Tambahan irisan chicken katsu, harga per strip.')
) AS v(n, d)
WHERE m.deskripsi IS NULL
  AND regexp_replace(
        regexp_replace(
          lower(regexp_replace(m.nama_menu, '\s*-\s*(Kentang|Labu|Ubi)$', '', 'i')),
          '[^a-z0-9]', '', 'g'
        ), '^addon', ''
      ) = v.n;
