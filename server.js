require("dotenv").config();

const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = 3000;

if (!process.env.ADMIN_USER ||
    !process.env.ADMIN_PASSWORD ||
    !process.env.SESSION_SECRET) {
  console.error("Missing admin settings in .env");
  process.exit(1);
}

const dataDir = path.join(__dirname, "data");
const ordersFile = path.join(dataDir, "orders.json");

fs.mkdirSync(dataDir, { recursive: true });

if (!fs.existsSync(ordersFile)) {
  fs.writeFileSync(ordersFile, "[]");
}

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

app.use(session({
  name: "spicy_admin",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    maxAge: 30 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));


const menuFile = path.join(dataDir, "menu.json");

function readMenu() {
  const data = JSON.parse(fs.readFileSync(menuFile, "utf8"));
  if (!Array.isArray(data)) throw new Error("Invalid menu file");
  return data;
}

function saveMenu(items) {
  const temp = menuFile + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(items, null, 2), { mode: 0o600 });
  fs.renameSync(temp, menuFile);
}

let menu = readMenu();

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


function readOrders() {
  const data = JSON.parse(fs.readFileSync(ordersFile, "utf8"));
  if (!Array.isArray(data)) throw new Error("Invalid orders file");
  return data;
}

function saveOrders(orders) {
  const tempFile = ordersFile + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(orders, null, 2), {
    mode: 0o600
  });
  fs.renameSync(tempFile, ordersFile);
}

function adminOnly(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    return next();
  }
  return res.status(401).json({ error: "Admin login required." });
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));

  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

// Public menu
app.get("/api/menu", (req, res) => {
  res.json(menu);
});


// Admin menu management
app.post("/api/admin/menu", adminOnly, (req, res) => {
  try {
    const item = validMenuItem(req.body);
    if (!item) {
      return res.status(400).json({ error: "Enter a valid name, price and category." });
    }

    const items = readMenu();
    const id = items.reduce((max, x) => Math.max(max, Number(x.id) || 0), 0) + 1;
    const created = { id, ...item };
    items.push(created);
    saveMenu(items);
    menu = items;
    res.status(201).json(created);
  } catch (error) {
    console.error("Menu create failed:", error.message);
    res.status(500).json({ error: "Could not add menu item." });
  }
});

app.patch("/api/admin/menu/:id", adminOnly, (req, res) => {
  try {
    const item = validMenuItem(req.body);
    if (!item) {
      return res.status(400).json({ error: "Enter a valid name, price and category." });
    }

    const items = readMenu();
    const index = items.findIndex(x => String(x.id) === req.params.id);
    if (index < 0) return res.status(404).json({ error: "Menu item not found." });

    items[index] = { id: items[index].id, ...item };
    saveMenu(items);
    menu = items;
    res.json(items[index]);
  } catch (error) {
    console.error("Menu update failed:", error.message);
    res.status(500).json({ error: "Could not update menu item." });
  }
});

app.delete("/api/admin/menu/:id", adminOnly, (req, res) => {
  try {
    const items = readMenu();
    const updated = items.filter(x => String(x.id) !== req.params.id);
    if (updated.length === items.length) {
      return res.status(404).json({ error: "Menu item not found." });
    }

    saveMenu(updated);
    menu = updated;
    res.json({ success: true });
  } catch (error) {
    console.error("Menu delete failed:", error.message);
    res.status(500).json({ error: "Could not delete menu item." });
  }
});

// Customer order submission
app.post("/api/orders", (req, res) => {
  const { name, phone, address, items } = req.body;

  if (
    typeof name !== "string" ||
    typeof phone !== "string" ||
    typeof address !== "string" ||
    !Array.isArray(items)
  ) {
    return res.status(400).json({ error: "Invalid order details." });
  }

  if (
    name.trim().length < 2 ||
    name.trim().length > 80 ||
    !/^[0-9+\-\s()]{10,20}$/.test(phone.trim()) ||
    address.trim().length < 8 ||
    address.trim().length > 500 ||
    items.length < 1 ||
    items.length > 30
  ) {
    return res.status(400).json({ error: "Please check your details." });
  }

  const quantities = new Map();

  for (const item of items) {
    if (
      !item ||
      !Number.isSafeInteger(item.id) ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 20 ||
      !menu.some(d => d.id === item.id)
    ) {
      return res.status(400).json({ error: "Invalid menu item." });
    }

    quantities.set(
      item.id,
      (quantities.get(item.id) || 0) + item.quantity
    );
  }

  if ([...quantities.values()].some(q => q > 20)) {
    return res.status(400).json({ error: "Quantity limit exceeded." });
  }

  const orderItems = [...quantities.entries()].map(([id, quantity]) => {
    const dish = menu.find(d => d.id === id);
    return {
      id,
      name: dish.name,
      price: dish.price,
      quantity,
      subtotal: dish.price * quantity
    };
  });

  const total = orderItems.reduce((sum, item) => sum + item.subtotal, 0);

  try {
    const orders = readOrders();

    const order = {
      id: Date.now(),
      name: name.trim(),
      phone: phone.trim(),
      address: address.trim(),
      items: orderItems,
      total,
      status: "Pending",
      createdAt: new Date().toISOString()
    };

    orders.push(order);
    saveOrders(orders);

    return res.status(201).json({
      success: true,
      orderId: order.id,
      total,
      message: "Order received successfully."
    });
  } catch (error) {
    console.error("Order save failed:", error.message);
    return res.status(500).json({ error: "Could not save order." });
  }
});

// Do not cache admin API responses
app.use("/api/admin", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Admin login
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

  const valid =
    typeof username === "string" &&
    typeof password === "string" &&
    safeEqual(username, process.env.ADMIN_USER) &&
    safeEqual(password, process.env.ADMIN_PASSWORD);

  if (!valid) {
    attempt.count++;
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ error: "Invalid username or password." });
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

// Check session
app.get("/api/admin/me", adminOnly, (req, res) => {
  res.json({ authenticated: true });
});

// Read all orders
app.get("/api/admin/orders", adminOnly, (req, res) => {
  try {
    const orders = readOrders().sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    res.json(orders);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Could not read orders." });
  }
});

// Update order status
app.patch("/api/admin/orders/:id/status", adminOnly, (req, res) => {
  const allowed = ["Pending", "Preparing", "Delivered", "Cancelled"];
  const { status } = req.body || {};

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "Invalid order status." });
  }

  try {
    const orders = readOrders();
    const order = orders.find(o => String(o.id) === req.params.id);

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    order.status = status;
    saveOrders(orders);

    res.json({ success: true, order });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Could not update order." });
  }
});

// Logout
app.post("/api/admin/logout", adminOnly, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie("spicy_admin");
    res.json({ success: true });
  });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Spicy Food server: http://127.0.0.1:${PORT}`);
  console.log(`Admin Dashboard: http://127.0.0.1:${PORT}/admin.html`);
});
