// Database schema for the online shop (accounts, carts, freight, payments, mail). Versioned migrations.
import { db } from '../db.js';
import { migrate, addColumn } from '../migrate.js';
import '../ops/service.js'; // customers / orders tables must exist first

migrate([{
  id: '2026-10-21-shop',
  up: () => {
    for (const [c, t] of [['pw_hash', 'TEXT'], ['email_verified', 'INTEGER DEFAULT 0'], ['source', 'TEXT'], ['marketing_opt_in', 'INTEGER DEFAULT 0']]) addColumn('customers', c, t);
    for (const [c, t] of [['channel', "TEXT DEFAULT 'pi'"], ['shipping_address', 'TEXT'], ['shipping_fee', 'REAL DEFAULT 0'], ['shipping_method', 'TEXT'], ['subtotal', 'REAL'], ['discount', 'REAL DEFAULT 0'],
      ['payment_method', 'TEXT'], ['expires_at', 'TEXT'], ['customer_note', 'TEXT'], ['coupon', 'TEXT']]) addColumn('orders', c, t);
    db.exec(`
      CREATE TABLE customer_sessions (token TEXT PRIMARY KEY, customer_id TEXT, created_at TEXT, last_seen INTEGER);
      CREATE TABLE customer_tokens (token TEXT PRIMARY KEY, customer_id TEXT, purpose TEXT, expires_at INTEGER, used INTEGER DEFAULT 0);
      CREATE TABLE addresses (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT, name TEXT, company TEXT, phone TEXT, line1 TEXT, line2 TEXT,
        city TEXT, state TEXT, postcode TEXT, country TEXT, is_default INTEGER DEFAULT 0, created_at TEXT);
      CREATE TABLE carts (id TEXT PRIMARY KEY, customer_id TEXT, created_at TEXT, updated_at TEXT, converted_order_id TEXT);
      CREATE TABLE cart_items (cart_id TEXT, sku TEXT, qty INTEGER, added_at TEXT, PRIMARY KEY (cart_id, sku));
      CREATE TABLE freight_zones (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, countries TEXT, method TEXT, first_kg REAL, first_fee REAL, extra_fee_per_kg REAL,
        volumetric_divisor REAL DEFAULT 5000, free_over REAL, days_min INTEGER, days_max INTEGER, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
      CREATE TABLE payment_intents (id TEXT PRIMARY KEY, order_id TEXT, provider TEXT, provider_ref TEXT, amount REAL, currency TEXT, status TEXT, created_at TEXT, updated_at TEXT, raw TEXT);
      CREATE INDEX idx_pi_ref ON payment_intents(provider, provider_ref);
      CREATE TABLE mail_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT, subject TEXT, body TEXT, status TEXT, error TEXT, created_at TEXT, sent_at TEXT);`);
    // default freight templates (SAMPLE — finance/logistics edit them in /admin/shop/freight)
    const z = db.prepare('INSERT INTO freight_zones (name, countries, method, first_kg, first_fee, extra_fee_per_kg, volumetric_divisor, free_over, days_min, days_max, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    z.run('North America · Express', 'US,CA,MX', 'express', 1, 35, 9, 5000, 3000, 5, 8, 0);
    z.run('Europe · Express', 'DE,FR,GB,IT,ES,NL,BE,PL,SE,DK,FI,IE,AT,PT,CZ,HU,RO,GR,CH,NO', 'express', 1, 32, 8.5, 5000, 3000, 5, 9, 1);
    z.run('Southeast Asia · Express', 'SG,MY,TH,VN,ID,PH', 'express', 1, 18, 4, 5000, 2000, 3, 6, 2);
    z.run('Middle East · Express', 'AE,SA,QA,KW,OM,BH,JO,IL,TR', 'express', 1, 30, 8, 5000, 3000, 4, 8, 3);
    z.run('Rest of world · Express', '*', 'express', 1, 45, 12, 5000, null, 7, 14, 9);
  },
}]);
