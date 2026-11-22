BEGIN;

DROP VIEW IF EXISTS v_menu_master;
ALTER TABLE menu DROP COLUMN IF EXISTS hpp;

CREATE VIEW v_menu_master AS
SELECT m.id_menu, m.sku, m.nama_menu, k.nama_kategori AS category,
       m.harga_satuan AS harga,
       COALESCE(t.terjual, 0) AS terjual,
       m.stok,
       CASE WHEN m.stok IS NULL THEN 'Ready ∞'
            WHEN m.stok > 0 THEN m.stok::text || ' pcs'
            ELSE 'Habis' END AS status_stok,
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

COMMIT;
