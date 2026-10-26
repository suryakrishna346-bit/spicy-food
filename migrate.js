require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const menu = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data/menu.json"), "utf8")
  );

  const orders = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data/orders.json"), "utf8")
  );

  if (!Array.isArray(menu) || !Array.isArray(orders)) {
    throw new Error("Menu or orders JSON is invalid");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_items (
        id INTEGER PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price INTEGER NOT NULL CHECK (price > 0),
        category VARCHAR(60) NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id BIGINT PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        address VARCHAR(500) NOT NULL,
        items JSONB NOT NULL,
        total INTEGER NOT NULL CHECK (total >= 0),
        status VARCHAR(20) NOT NULL DEFAULT 'Pending',
        created_at TIMESTAMPTZ NOT NULL
      )
    `);

    for (const item of menu) {
      await client.query(
        `INSERT INTO menu_items (id, name, price, category)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [item.id, item.name, item.price, item.category]
      );
    }

    for (const order of orders) {
      await client.query(
        `INSERT INTO orders
          (id, name, phone, address, items, total, status, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          order.id,
          order.name,
          order.phone,
          order.address,
          JSON.stringify(order.items),
          order.total,
          order.status || "Pending",
          order.createdAt
        ]
      );
    }

    const menuCount = await client.query(
      "SELECT COUNT(*)::int AS count FROM menu_items"
    );

    const orderCount = await client.query(
      "SELECT COUNT(*)::int AS count FROM orders"
    );

    await client.query("COMMIT");

    console.log("DATABASE MIGRATION SUCCESS");
    console.log("Menu records in database:", menuCount.rows[0].count);
    console.log("Order records in database:", orderCount.rows[0].count);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

migrate()
  .catch(error => {
    console.error("Migration failed:", error.code || "UNKNOWN_ERROR");
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
