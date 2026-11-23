const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5, // Ideal untuk serverless function agar tidak menghabiskan pool Supabase
});

let menuSchemaReady;
let deliveryIdempotencySchemaReady;
const ensureMenuDiscountColumn = () => {
  if (!menuSchemaReady) {
    menuSchemaReady = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('bakehaus_schema_migration'), hashtext('menu_v2'))");
        await client.query('ALTER TABLE menu ADD COLUMN IF NOT EXISTS diskon_persen INT NOT NULL DEFAULT 0 CHECK (diskon_persen BETWEEN 0 AND 100)');
        await client.query('ALTER TABLE menu ADD COLUMN IF NOT EXISTS deskripsi TEXT');
        await client.query('ALTER TABLE menu ADD COLUMN IF NOT EXISTS is_pedas BOOLEAN NOT NULL DEFAULT FALSE');
        await client.query('ALTER TABLE menu ADD COLUMN IF NOT EXISTS is_baru_manual BOOLEAN NOT NULL DEFAULT FALSE');
        await client.query('ALTER TABLE menu ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE');
        await client.query("ALTER TABLE menu ADD COLUMN IF NOT EXISTS varian_menu TEXT[] NOT NULL DEFAULT '{}'");
        const createdAtMeta = await client.query(`
          SELECT column_default, current_setting('TimeZone') AS time_zone
          FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'menu' AND column_name = 'created_at'
        `);
        await client.query('ALTER TABLE menu ADD COLUMN IF NOT EXISTS created_at TIMESTAMP');
        const oldCreatedAtDefault = createdAtMeta.rows[0] && createdAtMeta.rows[0].column_default;
        if (oldCreatedAtDefault && !oldCreatedAtDefault.toLowerCase().includes('asia/jakarta')) {
          await client.query(
            "UPDATE menu SET created_at = (created_at AT TIME ZONE $1) AT TIME ZONE 'Asia/Jakarta' WHERE created_at IS NOT NULL",
            [createdAtMeta.rows[0].time_zone]
          );
        }
        await client.query("UPDATE menu SET created_at = (NOW() AT TIME ZONE 'Asia/Jakarta') - INTERVAL '31 days' WHERE created_at IS NULL");
        await client.query("ALTER TABLE menu ALTER COLUMN created_at SET DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta'), ALTER COLUMN created_at SET NOT NULL");
        await client.query("ALTER TABLE users ALTER COLUMN created_at SET DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta')");
        await client.query("ALTER TABLE pelanggan ALTER COLUMN dibuat_pada SET DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta')");
        await client.query("ALTER TABLE detail_delivery ALTER COLUMN dibuat_pada SET DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta'), ALTER COLUMN diperbarui_pada SET DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta')");
        await client.query("ALTER TABLE order_tersimpan ALTER COLUMN dibuat_pada SET DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta')");
        await client.query('ALTER TABLE detail_delivery ADD COLUMN IF NOT EXISTS area_code VARCHAR(30)');
        await client.query(`
        DO $$ BEGIN
          IF to_regclass('custom_labels') IS NULL AND to_regclass('label_menu') IS NOT NULL THEN
            ALTER TABLE label_menu RENAME TO custom_labels;
          END IF;
        END $$
        `);
        await client.query(`
        CREATE TABLE IF NOT EXISTS custom_labels (
          id_label SERIAL PRIMARY KEY,
          nama_label VARCHAR(50) NOT NULL UNIQUE,
          warna VARCHAR(7) NOT NULL DEFAULT '#64748b' CHECK (warna ~ '^#[0-9A-Fa-f]{6}$')
        )
        `);
        await client.query(`
        CREATE TABLE IF NOT EXISTS menu_label (
          id_menu VARCHAR(10) NOT NULL REFERENCES menu(id_menu) ON DELETE CASCADE,
          id_label INT NOT NULL REFERENCES custom_labels(id_label) ON DELETE CASCADE,
          PRIMARY KEY (id_menu, id_label)
        )
        `);
        await client.query(`
        CREATE TABLE IF NOT EXISTS addon_target_category (
          id_menu VARCHAR(10) NOT NULL REFERENCES menu(id_menu) ON DELETE CASCADE,
          id_kategori VARCHAR(10) NOT NULL REFERENCES kategori_menu(id_kategori) ON DELETE CASCADE,
          PRIMARY KEY (id_menu, id_kategori)
        )
        `);
        await client.query(`
        CREATE TABLE IF NOT EXISTS bakehaus_schema_migrations (
          migration_key TEXT PRIMARY KEY,
          applied_at TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta')
        )
        `);
        const variantMigration = await client.query(
          "SELECT 1 FROM bakehaus_schema_migrations WHERE migration_key = 'legacy-menu-variants-v1'"
        );
        if (!variantMigration.rows.length) {
          await client.query(`
            UPDATE menu
            SET varian_menu = ARRAY['Putih', 'Merah', 'Coklat']::TEXT[],
                deskripsi = CASE
                  WHEN deskripsi IS NULL OR deskripsi = 'Nasi goreng dengan pilihan bumbu putih, kecap, atau merah. Porsi pas buat makan siang.'
                    THEN 'Nasi goreng dengan pilihan bumbu putih, merah, atau coklat. Porsi pas buat makan siang.'
                  ELSE deskripsi
                END
            WHERE cardinality(varian_menu) = 0
              AND regexp_replace(lower(nama_menu), '[^a-z0-9]', '', 'g') = 'nasigoreng'
          `);
          await client.query(`
            UPDATE menu AS item
            SET varian_menu = array_cat((
                SELECT array_agg(variants.adonan::TEXT ORDER BY
                  CASE variants.adonan
                    WHEN 'Kentang' THEN 1
                    WHEN 'Labu' THEN 2
                    WHEN 'Ubi' THEN 3
                    ELSE 4
                  END
                )
                FROM (
                  SELECT DISTINCT sibling.adonan
                  FROM menu AS sibling
                  WHERE sibling.id_kategori = item.id_kategori
                    AND sibling.adonan IS NOT NULL
                    AND lower(regexp_replace(sibling.nama_menu, '\\s*-\\s*(Kentang|Labu|Ubi)$', '', 'i')) =
                        lower(regexp_replace(item.nama_menu, '\\s*-\\s*(Kentang|Labu|Ubi)$', '', 'i'))
                ) AS variants
              ), ARRAY['Bomboloni']::TEXT[])
            WHERE cardinality(item.varian_menu) = 0 AND item.adonan IS NOT NULL
          `);
          await client.query(`
              UPDATE menu
              SET deskripsi = replace(
                deskripsi,
                'Pilih adonan kentang, labu, atau ubi.',
                'Pilih varian Kentang, Labu, Ubi, atau Bomboloni.'
              )
              WHERE deskripsi LIKE '%Pilih adonan kentang, labu, atau ubi.%'
          `);
          await client.query(
            "INSERT INTO bakehaus_schema_migrations (migration_key) VALUES ('legacy-menu-variants-v1')"
          );
        }
        const seedDateMigration = await client.query(
          "SELECT 1 FROM bakehaus_schema_migrations WHERE migration_key = 'backdate-seeded-menu-v1'"
        );
        if (!seedDateMigration.rows.length) {
          await client.query(`
            WITH seed_batch AS (
              SELECT created_at
              FROM menu
              WHERE created_at >= (NOW() AT TIME ZONE 'Asia/Jakarta') - INTERVAL '30 days'
              GROUP BY created_at
              HAVING COUNT(*) >= 20
              ORDER BY COUNT(*) DESC, created_at
              LIMIT 1
            )
            UPDATE menu AS item
            SET created_at = (NOW() AT TIME ZONE 'Asia/Jakarta') - INTERVAL '31 days'
            FROM seed_batch
            WHERE item.created_at = seed_batch.created_at
          `);
          await client.query(
            "INSERT INTO bakehaus_schema_migrations (migration_key) VALUES ('backdate-seeded-menu-v1')"
          );
        }
        await client.query(`
        UPDATE menu m
        SET id_kategori = k.id_kategori
        FROM kategori_menu k
        WHERE regexp_replace(lower(m.nama_menu), '[^a-z0-9]', '', 'g') = 'addonshot'
          AND k.nama_kategori = 'Add On'
        `);
        await client.query(`
        INSERT INTO addon_target_category (id_menu, id_kategori)
        SELECT m.id_menu, k.id_kategori
        FROM menu m
        JOIN kategori_menu k ON k.nama_kategori = CASE
          WHEN regexp_replace(lower(m.nama_menu), '[^a-z0-9]', '', 'g') = 'addonshot' THEN 'Coffee'
          ELSE 'Food'
        END
        WHERE regexp_replace(lower(m.nama_menu), '[^a-z0-9]', '', 'g') IN
          ('addonnasiputih', 'addonayampokpok', 'addonkatsuperstrip', 'addonshot')
        ON CONFLICT DO NOTHING
        `);
        await client.query('DROP TRIGGER IF EXISTS trg_kurangi_stok ON detail_transaksi');
        await client.query('DROP FUNCTION IF EXISTS fn_kurangi_stok()');
        const queueIndex = await client.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'ux_antrian_harian'"
        );
        const queueUsesUtcStorage = queueIndex.rows.length &&
          queueIndex.rows[0].indexdef.toLowerCase().includes('asia/jakarta');
        if (queueUsesUtcStorage) {
          await client.query('DROP INDEX IF EXISTS ux_antrian_harian');
          await client.query(`
        WITH ranked AS (
          SELECT no_struk,
                 ROW_NUMBER() OVER (
                   PARTITION BY id_toko,
                     (((tanggal_waktu AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta')::date)
                   ORDER BY tanggal_waktu, no_struk
                 ) AS queue_number
          FROM transaksi
        )
        UPDATE transaksi t
        SET no_antrian = ranked.queue_number,
            tanggal_waktu = t.tanggal_waktu + INTERVAL '7 hours'
        FROM ranked WHERE ranked.no_struk = t.no_struk
        `);
        }
        await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_antrian_harian
        ON transaksi (
          id_toko,
          (tanggal_waktu::date),
          no_antrian
        )
        `);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    })().catch((err) => {
      menuSchemaReady = null;
      throw err;
    });
  }
  return menuSchemaReady;
};

const ensureDeliveryIdempotencyTable = () => {
  if (!deliveryIdempotencySchemaReady) {
    deliveryIdempotencySchemaReady = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('bakehaus_schema_migration'), hashtext('delivery_idempotency_v1'))");
        await client.query(`
          CREATE TABLE IF NOT EXISTS delivery_idempotency (
            idempotency_key UUID PRIMARY KEY,
            response JSONB,
            created_at TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Jakarta')
          )
        `);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    })().catch((err) => {
      deliveryIdempotencySchemaReady = null;
      throw err;
    });
  }
  return deliveryIdempotencySchemaReady;
};

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  ensureMenuDiscountColumn,
  ensureDeliveryIdempotencyTable,
};