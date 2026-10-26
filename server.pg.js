require("dotenv").config();

const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

if (!process.env.ADMIN_USER ||
    !process.env.ADMIN_PASSWORD ||
    !process.env.SESSION_SECRET ||
    !process.env.DATABASE_URL) {
  console.error("Missing required environment settings.");
  process.exit(1);
}

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
  ssl: { rejectUnauthorized: false }
});

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

const PgSession = require("connect-pg-simple")(session);

const sessionStore = new PgSession({
  pool,
  tableName: "user_sessions",
  createTableIfMissing: true
});

app.use(session({
  store: sessionStore,
  name: "spicy_admin",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function adminOnly(req, res, next) {
  if (req.session && req.session.isAdmin === true) return next();
  return res.status(401).json({ error: "Admin login required." });
}

function validMenuItem(body) {
  if (!body || typeof body.name !== "string" ||
      typeof body.category !== "string") return null;

  const name = body.name.trim();
  const category = body.category.trim();
  const price = Number(body.price);

  if (!name || name.length > 100 ||
      !category || category.length > 60 ||
      !Number.isSafeInteger(price) || price < 1 || price > 100000) {
    return null;
  }

  return { name, price, category };
}

function mapOrder(row) {
  return {
    id: String(row.id),
    name: row.name,
    phone: row.phone,
    address: row.address,
    items: row.items,
    total: row.total,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString()
  };
}

app.get("/api/menu", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, price, category FROM menu_items ORDER BY id"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Menu read failed:", error.code || error.message);
    res.status(500).json({ error: "Could not load menu." });
  }
});

app.use("/api/admin", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const loginAttempts = new Map();

app.post("/api/admin/login", (req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  let attempt = loginAttempts.get(ip);

  if (!attempt || now - attempt.start > 15 * 60 * 1000) {
    attempt = { start: now, count: 0 };
  }

  if (attempt.count >= 10) {
    loginAttempts.set(ip, attempt);
    return res.status(429).json({
      error: "Too many login attempts. Try again later."
    });
  }

  const { username, password } = req.body || {};
  const valid = typeof username === "string" &&
    typeof password === "string" &&
    safeEqual(username, process.env.ADMIN_USER) &&
    safeEqual(password, process.env.ADMIN_PASSWORD);

  if (!valid) {
    attempt.count++;
    loginAttempts.set(ip, attempt);
    return res.status(401).json({
      error: "Invalid username or password."
    });
  }

  loginAttempts.delete(ip);

  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.isAdmin = true;
    req.session.save(err => {
      if (err) return next(err);
      res.json({ success: true });
    });
  });
});

app.get("/api/admin/me", adminOnly, (req, res) => {
  res.json({ authenticated: true });
});

app.get("/api/admin/menu", adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, price, category FROM menu_items ORDER BY id"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Admin menu read failed:", error.code || error.message);
    res.status(500).json({ error: "Could not read menu." });
  }
});

app.post("/api/admin/menu", adminOnly, async (req, res) => {
  const item = validMenuItem(req.body);
  if (!item) {
    return res.status(400).json({
      error: "Enter a valid name, price and category."
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO menu_items (id, name, price, category)
       VALUES (
         (SELECT COALESCE(MAX(id), 0) + 1 FROM menu_items),
         $1, $2, $3
       )
       RETURNING id, name, price, category`,
      [item.name, item.price, item.category]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Menu create failed:", error.code || error.message);
    res.status(500).json({ error: "Could not add menu item." });
  }
});

app.patch("/api/admin/menu/:id", adminOnly, async (req, res) => {
  const item = validMenuItem(req.body);
  if (!item) {
    return res.status(400).json({
      error: "Enter a valid name, price and category."
    });
  }

  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) {
    return res.status(400).json({ error: "Invalid menu item ID." });
  }

  try {
    const result = await pool.query(
      `UPDATE menu_items SET name=$1, price=$2, category=$3
       WHERE id=$4 RETURNING id, name, price, category`,
      [item.name, item.price, item.category, id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "Menu item not found." });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Menu update failed:", error.code || error.message);
    res.status(500).json({ error: "Could not update menu item." });
  }
});

app.delete("/api/admin/menu/:id", adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) {
    return res.status(400).json({ error: "Invalid menu item ID." });
  }

  try {
    const result = await pool.query(
      "DELETE FROM menu_items WHERE id=$1 RETURNING id", [id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "Menu item not found." });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Menu delete failed:", error.code || error.message);
    res.status(500).json({ error: "Could not delete menu item." });
  }
});

app.post("/api/orders", async (req, res) => {
  const { name, phone, address, items } = req.body || {};

  if (typeof name !== "string" || typeof phone !== "string" ||
      typeof address !== "string" || !Array.isArray(items)) {
    return res.status(400).json({ error: "Invalid order details." });
  }

  if (name.trim().length < 2 || name.trim().length > 80 ||
      !/^[0-9+\-\s()]{10,20}$/.test(phone.trim()) ||
      address.trim().length < 8 || address.trim().length > 500 ||
      items.length < 1 || items.length > 30) {
    return res.status(400).json({ error: "Please check your details." });
  }

  const quantities = new Map();

  for (const item of items) {
    if (!item || !Number.isSafeInteger(item.id) ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 || item.quantity > 20) {
      return res.status(400).json({ error: "Invalid menu item." });
    }

    quantities.set(
      item.id, (quantities.get(item.id) || 0) + item.quantity
    );
  }

  if ([...quantities.values()].some(q => q > 20)) {
    return res.status(400).json({ error: "Quantity limit exceeded." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ids = [...quantities.keys()];
    const menuResult = await client.query(
      `SELECT id, name, price FROM menu_items
       WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE`,
      [ids]
    );

    if (menuResult.rowCount !== ids.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid menu item." });
    }

    const dishes = new Map(menuResult.rows.map(d => [d.id, d]));
    const orderItems = [...quantities.entries()].map(([id, quantity]) => {
      const dish = dishes.get(id);
      return {
        id,
        name: dish.name,
        price: dish.price,
        quantity,
        subtotal: dish.price * quantity
      };
    });

    const total = orderItems.reduce(
      (sum, item) => sum + item.subtotal, 0
    );
    const orderId = Date.now();

    const result = await client.query(
      `INSERT INTO orders
       (id, name, phone, address, items, total, status, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,'Pending',NOW())
       RETURNING id, total`,
      [
        orderId, name.trim(), phone.trim(), address.trim(),
        JSON.stringify(orderItems), total
      ]
    );

    await client.query("COMMIT");
    res.status(201).json({
      success: true,
      orderId: String(result.rows[0].id),
      total: result.rows[0].total,
      message: "Order received successfully."
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Order save failed:", error.code || error.message);
    res.status(500).json({ error: "Could not save order." });
  } finally {
    client.release();
  }
});

app.get("/api/admin/orders", adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone, address, items, total, status, created_at
       FROM orders ORDER BY created_at DESC`
    );
    res.json(result.rows.map(mapOrder));
  } catch (error) {
    console.error("Orders read failed:", error.code || error.message);
    res.status(500).json({ error: "Could not read orders." });
  }
});

app.patch("/api/admin/orders/:id/status", adminOnly, async (req, res) => {
  const allowed = ["Pending", "Preparing", "Delivered", "Cancelled"];
  const { status } = req.body || {};
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "Invalid order status." });
  }

  try {
    const result = await pool.query(
      `UPDATE orders SET status=$1 WHERE id=$2
       RETURNING id, name, phone, address, items, total, status, created_at`,
      [status, req.params.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "Order not found." });
    }
    res.json({ success: true, order: mapOrder(result.rows[0]) });
  } catch (error) {
    console.error("Order update failed:", error.code || error.message);
    res.status(500).json({ error: "Could not update order." });
  }
});

app.post("/api/admin/logout", adminOnly, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie("spicy_admin", {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production"
    });
    res.json({ success: true });
  });
});

let server;

async function start() {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    const menuCount = await client.query(
      "SELECT COUNT(*)::int AS count FROM menu_items"
    );
    console.log("PostgreSQL connected. Menu items:", menuCount.rows[0].count);
  } finally {
    client.release();
  }

  server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Spicy Food server listening on port ${PORT}`);
  });
}

start().catch(error => {
  console.error("Server startup failed:", error.code || error.message);
  process.exit(1);
});

async function shutdown() {
  if (server) server.close();
  await pool.end();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
