const express = require("express");
const session = require("express-session");
const path = require("path");
const db = require("./db");
const multer = require("multer");

const app = express();
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/properties/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "_" + file.originalname);
  }
});

const upload = multer({ storage });

app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use(session({
  secret: "realestate",
  resave: false,
  saveUninitialized: true
}));
app.use("/uploads", express.static("uploads"));

app.set("view engine", "ejs");

/* ================= LOGIN ================= */
app.get("/", (req, res) => {

  const localitiesQuery = `
    SELECT location, COUNT(*) AS total_properties
    FROM properties
    WHERE status = 'live'
    GROUP BY location
    ORDER BY total_properties DESC
    LIMIT 10
  `;

  db.query(localitiesQuery, (err, localities) => {
    if (err) {
      console.log("LOCALITIES ERROR:", err);
      localities = [];
    }

    res.render("main", { localities });
  });
});


app.get("/login", (req, res) => {
  res.render("common/login");
});

app.post("/login", (req, res) => {
  const { email, password, role } = req.body;

  let table =
    role === "admin" ? "admins" :
    role === "agent" ? "agents" :
    "users";

  db.query(
    `SELECT * FROM ${table} WHERE email=? AND password=?`,
    [email, password],
    (err, result) => {
      if (err) {
        console.log(err);
        return res.send("Database error");
      }

      // ✅ STEP 1: No user found
      if (!result || result.length === 0) {
        return res.send("Invalid email or password");
      }

      const user = result[0];

      // ✅ STEP 2: Agent approval check
      if (role === "agent" && user.status !== "approved") {
        return res.send("Agent not approved by admin");
      }

      // ✅ STEP 3: Login success
      req.session.user = user;
      req.session.role = role;

      res.redirect(`/${role}/dashboard`);
    }
  );
});

app.get("/register", (req, res) => {
  res.render("common/register");
});
app.post("/register", (req, res) => {
  const { name, email, phone, password } = req.body;

  if (!name || !email || !phone || !password) {
    return res.send("All fields are required");
  }

  db.query(
    "INSERT INTO users (name, email, phone, password) VALUES (?,?,?,?)",
    [name, email, phone, password],
    (err) => {
      if (err) {
        console.log(err);
        return res.send("User already exists or DB error");
      }
      res.redirect("/");
    }
  );
});

/* ================= DASHBOARDS ================= */

app.get("/user/dashboard", async (req, res) => {
  if (req.session.role !== "user") return res.redirect("/");

  const userId = req.session.user.id;

  try {
    /* =======================
       1️⃣ TOP STATS
       ======================= */
    const [[stats]] = await db.promise().query(`
      SELECT
        COUNT(*) AS totalListings,
        SUM(status = 'live') AS activeProperties,
        SUM(booking_status = 'sold') AS soldProperties
      FROM properties
      WHERE seller_id = ?
    `, [userId]);

    /* =======================
       2️⃣ RECENT ACTIVITY
       live OR hold
       ======================= */
    const [recentProperties] = await db.promise().query(`
      SELECT title, location, status, booking_status
      FROM properties
      WHERE seller_id = ?
        AND (status = 'live' OR booking_status = 'hold')
      ORDER BY created_at DESC
      LIMIT 5
    `, [userId]);

    /* =======================
       3️⃣ NOTIFICATIONS
       ======================= */

    // ✔ Property verified by agent
    const [verified] = await db.promise().query(`
      SELECT title, location
      FROM properties
      WHERE seller_id = ?
        AND status = 'verified'
      ORDER BY created_at DESC
      LIMIT 3
    `, [userId]);

    // 📞 Buyer enquiry accepted / hold
    const [enquiries] = await db.promise().query(`
      SELECT p.title, p.location
      FROM properties p
      WHERE p.seller_id = ?
        AND p.booking_status = 'hold'
      ORDER BY p.created_at DESC
      LIMIT 3
    `, [userId]);

    // 💰 Price updated (using final_amount change proxy)
    const [priceUpdates] = await db.promise().query(`
  SELECT title, market_amount, final_amount
  FROM properties
  WHERE seller_id = ?
    AND final_amount IS NOT NULL
  ORDER BY created_at DESC
  LIMIT 3
`, [userId]);


    /* =======================
       4️⃣ RENDER
       ======================= */
    res.render("user/dashboard", {
      user: req.session.user,
      stats,
      recentProperties,
      notifications: {
        verified,
        enquiries,
        priceUpdates
      }
    });

  } catch (err) {
    console.error("USER DASHBOARD ERROR:", err);
    res.send("Dashboard loading failed");
  }
});


app.get("/user/sell", (req, res) => {
  if (req.session.role !== "user") return res.redirect("/");
  res.render("user/sell_property");
});
app.post("/user/sell", (req, res) => {
  if (req.session.role !== "user") return res.redirect("/");

  const {
    title,
    type,
    purpose,
    location,
    description,
    market_amount
  } = req.body;

  db.query(
    `
    INSERT INTO properties
    (
      seller_id,
      title,
      type,
      purpose,
      location,
      description,
      market_amount,
      status,
      booking_status
    )
   VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'available')

    `,
    [
      req.session.user.id,
      title,
      type,
      purpose,
      location,
      description,
      parseFloat(market_amount) || 0
    ],
    (err, result) => {
      if (err) {
        console.error("❌ INSERT ERROR:", err);
        return res.send("Error saving property");
      }

      console.log("✅ PROPERTY INSERTED:", result.insertId);
      res.redirect("/user/dashboard");
    }
  );
});
app.post("/agent/login", (req, res) => {
  const { email, password } = req.body;

  db.query(
    "SELECT * FROM agents WHERE email=? AND password=? AND status='approved'",
    [email, password],
    (err, rows) => {
      if (err) return res.send("DB Error");

      if (rows.length === 0) {
        return res.send("Invalid credentials or not approved");
      }

      // ✅ VERY IMPORTANT
      req.session.role = "agent";
      req.session.user = {
        id: rows[0].id,       // MUST MATCH agents table PK
        name: rows[0].name,
        email: rows[0].email
      };

      res.redirect("/agent/dashboard");
    }
  );
});

app.get("/agent/requests", (req, res) => {
  if (req.session.role !== "agent") return res.redirect("/");

  db.query(
    "SELECT * FROM properties WHERE status='pending'",
    (err, rows) => {
      res.render("agent/requests", { properties: rows });
    }
  );
});
app.get("/agent/verify/:id", (req, res) => {
  if (req.session.role !== "agent") return res.redirect("/");

  db.query(
    "SELECT * FROM properties WHERE id=?",
    [req.params.id],
    (err, rows) => {
      res.render("agent/verify_property", {
        property: rows[0]
      });
    }
  );
});
app.post("/agent/fix-price/:id", (req, res) => {
  const { final_amount, govt_amount } = req.body;

  db.query(
    `
    UPDATE properties
    SET final_amount=?, govt_amount=?
    WHERE id=?
    `,
    [final_amount, govt_amount, req.params.id],
    () => res.redirect("/agent/verify/" + req.params.id)
  );
});

app.post("/agent/verify/:id", (req, res) => {
  if (req.session.role !== "agent") return res.redirect("/");

  db.query(
    "UPDATE properties SET status='live', agent_id=? WHERE id=?",
    [req.session.user.id, req.params.id],
    () => res.redirect("/agent/dashboard")
  );
});
app.get("/admin/add-agent", (req, res) => {
  if (req.session.role !== "admin") return res.redirect("/");
  res.render("admin/add_agent");
});
app.post("/admin/add-agent", (req, res) => {
  if (req.session.role !== "admin") return res.redirect("/");

  const { name, email, phone, area, license_no, password } = req.body;

  db.query(
    `INSERT INTO agents 
     (name, email, phone, area, license_no, password, status)
     VALUES (?,?,?,?,?,?, 'approved')`,
    [name, email, phone, area, license_no, password],
    (err) => {
      if (err) {
        console.log(err);
        return res.send("Agent already exists");
      }
      res.redirect("/admin/agents");
    }
  );
});
app.get("/admin/bookings", (req, res) => {
  if (req.session.role !== "admin") return res.redirect("/");

  db.query(
    `
    SELECT 
      p.location,
      p.booking_status,
      b.buyer_name,
      b.buyer_phone,
      a.name AS agent_name
    FROM property_bookings b
    JOIN properties p ON p.id = b.property_id
    LEFT JOIN agents a ON a.id = p.agent_id
    `,
    (err, rows) => {
      if (err) {
        console.log("❌ ADMIN BOOKINGS ERROR:", err);
        return res.render("admin/bookings", { bookings: [] });
      }

      res.render("admin/bookings", {
        bookings: rows || []
      });
    }
  );
});

// Show payment page
app.get("/payment/:bookingId", (req, res) => {
  res.render("user/payment", { bookingId: req.params.bookingId });
});

// Submit payment
app.post("/payment/:bookingId", (req, res) => {
  const { amount } = req.body;
  const bookingId = req.params.bookingId;

  // get property_id from booking
  db.query(
    "SELECT property_id FROM property_bookings WHERE id=?",
    [bookingId],
    (err, rows) => {

      if (err || rows.length === 0) {
        return res.send("Invalid booking");
      }

      const propertyId = rows[0].property_id;

      db.query(
        `
        INSERT INTO property_payments
        (property_id, booking_id, amount, payment_status)
        VALUES (?, ?, ?, 'paid')
        `,
        [propertyId, bookingId, amount],
        () => res.redirect("/user/dashboard")
      );
    }
  );
});


app.post("/agent/mark-sold/:propertyId", (req, res) => {
  const propertyId = req.params.propertyId;

  db.query(
    `
    SELECT * FROM property_payments
    WHERE property_id = ? AND payment_status = 'verified'
    `,
    [propertyId],
    (err, rows) => {

      // 🔴 MUST check error first
      if (err) {
        console.error("Payment check error:", err);
        return res.send("Database error while checking payment");
      }

      // 🔴 rows may be empty
      if (!rows || rows.length === 0) {
        return res.send("❌ Payment not verified. Cannot mark as SOLD.");
      }

      // ✅ Payment verified → allow sold
      db.query(
        `
        UPDATE properties 
        SET booking_status = 'sold', status = 'Sold' 
        WHERE id = ?
        `,
        [propertyId],
        (err) => {

          if (err) {
            console.error("Property update error:", err);
            return res.send("Failed to mark property as sold");
          }

          db.query(
            `
            UPDATE property_bookings 
            SET status = 'completed' 
            WHERE property_id = ?
            `,
            [propertyId],
            (err) => {

              if (err) {
                console.error("Booking update error:", err);
                return res.send("Failed to complete booking");
              }

              // ✅ SUCCESS
              res.redirect("/agent/bookings");
            }
          );
        }
      );
    }
  );
});

app.get("/booking/:id", (req, res) => {
  db.query(
    "SELECT * FROM properties WHERE id=?",
    [req.params.id],
    (err, rows) => {
      if (!rows.length) return res.send("Property not found");

      if (rows[0].booking_status !== "available") {
        return res.send("❌ Property already booked");
      }

      res.render("user/booking_form", { property: rows[0] });
    }
  );
});



app.post("/agent/cancel-booking/:propertyId", (req, res) => {
  const propertyId = req.params.propertyId;

  // 1️⃣ Release property
  db.query(
    "UPDATE properties SET booking_status='available' WHERE id=?",
    [propertyId],
    () => {
      // 2️⃣ Mark booking cancelled
      db.query(
        "UPDATE property_bookings SET status='cancelled' WHERE property_id=?",
        [propertyId],
        () => res.redirect("/agent/bookings")
      );
    }
  );
});
app.post("/booking/:id", (req, res) => {
  const { name, phone, email } = req.body;
  const propertyId = req.params.id;

  // 1️⃣ Create booking
  db.query(
    `
    INSERT INTO property_bookings
    (property_id, buyer_name, buyer_phone, buyer_email, status)
    VALUES (?, ?, ?, ?, 'hold')
    `,
    [propertyId, name, phone, email],
    (err, result) => {

      if (err) {
        console.error(err);
        return res.send("Booking failed");
      }

      const bookingId = result.insertId;

      // 2️⃣ Update property status
      db.query(
        "UPDATE properties SET booking_status='hold' WHERE id=?",
        [propertyId],
        () => {
          // 3️⃣ Redirect to payment page
          res.redirect(`/payment/${bookingId}`);
        }
      );
    }
  );
});


app.get("/agent/bookings", (req, res) => {
  if (req.session.role !== "agent") return res.redirect("/");

  db.query(
    `
    SELECT 
      b.property_id,
      b.buyer_name,
      b.buyer_phone,
      b.buyer_email,
      p.location
    FROM property_bookings b
    JOIN properties p ON p.id = b.property_id
    WHERE b.status='hold'
    `,
    (err, rows) => {
      res.render("agent/bookings", { bookings: rows });
    }
  );
});
app.get("/agent/bookings", (req, res) => {
  if (req.session.role !== "agent") return res.redirect("/");

  const agentId = req.session.user.id;

  const sql = `
    SELECT
      b.id AS booking_id,
      b.buyer_name,
      b.buyer_phone,
      b.status,

      -- ✅ PROPERTY NAME GENERATED
      CONCAT(p.type, ' - ', p.location) AS property_name,

      p.price

    FROM property_bookings b
    JOIN properties p ON p.id = b.property_id
    WHERE p.agent_id = ?
    ORDER BY b.id DESC
  `;

  db.query(sql, [agentId], (err, rows) => {
    if (err) {
      console.log("❌ AGENT BOOKINGS ERROR:", err);
      return res.render("agent/bookings", { bookings: [] });
    }

    res.render("agent/bookings", { bookings: rows });
  });
});




app.get("/admin/agents", (req, res) => {
  if (req.session.role !== "admin") return res.redirect("/");

  db.query("SELECT * FROM agents", (err, agents) => {
    res.render("admin/agents", { agents });
  });
});
app.get("/admin/approve-agent/:id", (req, res) => {
  if (req.session.role !== "admin") return res.redirect("/");

  db.query(
    "UPDATE agents SET status='approved' WHERE id=?",
    [req.params.id],
    () => res.redirect("/admin/dashboard")
  );
});

app.get("/admin/reject-agent/:id", (req, res) => {
  if (req.session.role !== "admin") return res.redirect("/");

  db.query(
    "UPDATE agents SET status='rejected' WHERE id=?",
    [req.params.id],
    () => res.redirect("/admin/dashboard")
  );
});

app.get("/admin/dashboard", (req, res) => {
  if (req.session.role !== "admin") return res.redirect("/");

  const statsQuery = `
    SELECT
      (SELECT COUNT(*) FROM agents) AS totalAgents,
      (SELECT COUNT(*) FROM agents WHERE status='pending') AS pendingAgents,
      (SELECT COUNT(*) FROM properties) AS totalProperties
  `;

  const agentsQuery = `SELECT id, name, email, status FROM agents`;

  const bookingsQuery = `
    SELECT 
      p.location,
      p.booking_status,
      b.buyer_name,
      b.buyer_phone,
      a.name AS agent_name
    FROM property_bookings b
    JOIN properties p ON p.id = b.property_id
    LEFT JOIN agents a ON a.id = p.agent_id
  `;

  db.query(statsQuery, (err, statsResult) => {
    if (err) return res.send("DB Error");

    db.query(agentsQuery, (err, agents) => {
      if (err) return res.send("DB Error");

      db.query(bookingsQuery, (err, bookings) => {
        if (err) return res.send("DB Error");

        res.render("admin/dashboard", {
          stats: statsResult[0],
          agents,
          bookings
        });
      });
    });
  });
});


app.get("/user/upload-images/:id", (req, res) => {
  if (req.session.role !== "user") return res.redirect("/");
  res.render("user/upload_images", { propertyId: req.params.id });
});
app.post(
  "/user/upload-images/:id",
  upload.array("images", 10),
  (req, res) => {
    if (req.session.role !== "user") return res.redirect("/");

    const propertyId = req.params.id;

    req.files.forEach(file => {
      db.query(
        `
        INSERT INTO property_images 
        (property_id, uploaded_by, image_path)
        VALUES (?, 'seller', ?)
        `,
        [propertyId, file.filename]
      );
    });

    res.redirect("/user/my-properties");
  }
);

app.get("/agent/upload-images/:id", (req, res) => {
  if (req.session.role !== "agent") return res.redirect("/");
  res.render("agent/upload_images", { propertyId: req.params.id });
});
app.post(
  "/agent/upload-images/:id",
  upload.array("images", 10),   // ✅ MULTIPLE IMAGES
  (req, res) => {
    if (req.session.role !== "agent") return res.redirect("/");

    const propertyId = req.params.id;

    if (!req.files || req.files.length === 0) {
      return res.send("No images selected");
    }

    req.files.forEach(file => {
      db.query(
        `
        INSERT INTO property_images 
        (property_id, uploaded_by, image_path)
        VALUES (?, 'agent', ?)
        `,
        [propertyId, file.filename]
      );
    });

    // 🔁 VERY IMPORTANT: stay on verify page
    res.redirect("/agent/verify/" + propertyId);
  }
);


app.post("/agent/verify-property/:id", (req, res) => {
  if (req.session.role !== "agent") return res.redirect("/");

  const propertyId = req.params.id;
  const agentId = req.session.user.id;

  // 1️⃣ Check images
  db.query(
    `
    SELECT COUNT(*) AS imgCount
    FROM property_images
    WHERE property_id=?
    `,
    [propertyId],
    (err, imgRows) => {

      if (err || imgRows[0].imgCount === 0) {
        return res.send("Upload images before verification");
      }

      // 2️⃣ Check price
      db.query(
        `
        SELECT final_amount, govt_amount
        FROM properties
        WHERE id=? AND status='pending'
        `,
        [propertyId],
        (err, propRows) => {

          if (
            err ||
            propRows.length === 0 ||
            !propRows[0].final_amount ||
            !propRows[0].govt_amount
          ) {
            return res.send("Fix price before verification");
          }

          // 3️⃣ VERIFY
          db.query(
            `
            UPDATE properties
            SET status='live', agent_id=?
            WHERE id=?
            `,
            [agentId, propertyId],
            (err) => {
              if (err) {
                console.log(err);
                return res.send("Verification failed");
              }
              res.redirect("/agent/dashboard");
            }
          );
        }
      );
    }
  );
});

app.get("/property/:id", (req, res) => {
  const propertyId = req.params.id;

  // 1️⃣ Get property + agent info
  db.query(
    `
    SELECT p.*, a.name AS agent_name, a.phone AS agent_phone
    FROM properties p
    LEFT JOIN agents a ON p.agent_id = a.id
    WHERE p.id = ?
    `,
    [propertyId],
    (err, propResult) => {
      if (err || propResult.length === 0) {
        return res.send("Property not found");
      }

      // 2️⃣ Get ONLY images of THIS property
      db.query(
        `
        SELECT image_path, uploaded_by 
        FROM property_images 
        WHERE property_id = ?
        `,
        [propertyId],
        (err, imageResult) => {
          if (err) {
            console.log(err);
            return res.send("Image error");
          }

          res.render("user/property_details", {
            p: propResult[0],
            images: imageResult   // ✅ ONLY THIS PROPERTY IMAGES
          });
        }
      );
    }
  );
});

app.get("/user/my-properties", (req, res) => {
  if (req.session.role !== "user") return res.redirect("/");

  db.query(
    "SELECT * FROM properties WHERE seller_id=?",
    [req.session.user.id],
    (err, rows) => {
      res.render("user/my_properties", { properties: rows });
    }
  );
});

app.get("/properties", (req, res) => {
  const { type, location } = req.query;

  let sql = `
    SELECT p.*,
    (
      SELECT image_path 
      FROM property_images 
      WHERE property_id = p.id 
      ORDER BY uploaded_by='agent' DESC
      LIMIT 1
    ) AS main_image
    FROM properties p
    WHERE p.status='live'
  `;

  let values = [];

  if (type) {
    sql += " AND p.type=?";
    values.push(type);
  }

  if (location) {
    sql += " AND p.location LIKE ?";
    values.push("%" + location + "%");
  }

  db.query(sql, values, (err, rows) => {
    res.render("user/property_list", {
      properties: rows,
      filters: req.query || {}
    });
  });
});


app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});
app.post("/enquiry", (req, res) => {
  const { property_id, agent_id, buyer_name, buyer_phone, message } = req.body;

  db.query(
    "INSERT INTO enquiries (property_id, agent_id, buyer_name, buyer_phone, message) VALUES (?,?,?,?,?)",
    [property_id, agent_id, buyer_name, buyer_phone, message],
    () => res.send("✅ Enquiry sent successfully")
  );
});
app.get("/agent/enquiries", (req, res) => {
  if (req.session.role !== "agent") return res.redirect("/");

  db.query(
    "SELECT * FROM enquiries WHERE agent_id=?",
    [req.session.user.id],
    (err, rows) => {
      res.render("agent/enquiries", { enquiries: rows });
    }
  );
});
app.get("/feedback/:agentId", (req, res) => {
  res.render("user/feedback", { agentId: req.params.agentId });
});
app.post("/feedback", (req, res) => {
  const { agent_id, rating, comment } = req.body;

  db.query(
    "INSERT INTO feedback (agent_id, rating, comment) VALUES (?,?,?)",
    [agent_id, rating, comment],
    () => res.send("✅ Feedback submitted")
  );
});
app.get("/admin/reports", (req, res) => {
  if (req.session.role !== "admin") return res.redirect("/");

  db.query(
    `
    SELECT a.name, COUNT(p.id) AS total_properties
    FROM agents a
    LEFT JOIN properties p ON a.id = p.agent_id
    GROUP BY a.id
    `,
    (err, rows) => {
      res.render("admin/reports", { reports: rows });
    }
  );
});
app.get("/agent/dashboard", (req, res) => {
  if (req.session.role !== "agent") return res.redirect("/");

  const agentId = req.session.user.id;

  const statsQuery = `
    SELECT
      (SELECT COUNT(*) FROM properties WHERE agent_id=?) AS totalProperties,
      (SELECT COUNT(*) FROM properties WHERE agent_id=? AND status='live') AS liveProperties,
      (SELECT COUNT(*) FROM enquiries e
         JOIN properties p ON p.id = e.property_id
         WHERE p.agent_id=?) AS enquiriesCount
  `;

  const agentPropertiesQuery = `
    SELECT id, location, status
    FROM properties
    WHERE agent_id = ?
  `;

  // ✅ ADD THIS (THIS WAS MISSING)
  const pendingPropertiesQuery = `
    SELECT id, location, status
    FROM properties
    WHERE status = 'pending'
  `;

  const bookingsQuery = `
    SELECT 
      b.id, b.buyer_name, b.buyer_phone, b.status
    FROM property_bookings b
    JOIN properties p ON p.id = b.property_id
    WHERE p.agent_id=?
  `;

  const enquiriesQuery = `
    SELECT 
      id,
      buyer_name AS name,
      buyer_phone,
      message,
      created_at
    FROM enquiries
    WHERE agent_id = ?
    ORDER BY created_at DESC
  `;

  db.query(statsQuery, [agentId, agentId, agentId], (err, statsResult) => {
    if (err) return res.send("DB error");

    db.query(agentPropertiesQuery, [agentId], (err, properties) => {
      if (err) return res.send("DB error");

      db.query(pendingPropertiesQuery, (err, verifyList) => {
        if (err) return res.send("DB error");

        db.query(bookingsQuery, [agentId], (err, bookings) => {
          if (err) return res.send("DB error");

          db.query(enquiriesQuery, [agentId], (err, enquiries) => {
            if (err) return res.send("DB error");

            res.render("agent/dashboard", {
              agent: req.session.user,
              stats: statsResult[0],
              properties,   // agent-owned
              verifyList,    // ALL pending
              bookings,
              enquiries
            });
          });
        });
      });
    });
  });
});

app.get("/buy", (req, res) => {
  res.redirect("/user/buy");
});


app.get("/user/buy", async (req, res) => {
  try {
    const [properties] = await db.promise().query(`
      SELECT *
      FROM properties
      WHERE status = 'live'
    `);

    res.render("buy", {
      properties
    });
  } catch (err) {
    console.error(err);
    res.send("Error loading properties");
  }
});

app.get("/plots", (req, res) => {
  db.query(
    `SELECT * FROM properties
     WHERE status='live' AND type='plot'`,
    (err, rows) => {
      res.render("user/listings", {
        title: "Plots",
        properties: rows,
        user: req.session.user
      });
    }
  );
});
app.get("/projects", (req, res) => {
  db.query(
    `SELECT * FROM properties
     WHERE status='live' AND type='project'`,
    (err, rows) => {
      res.render("user/listings", {
        title: "Projects",
        properties: rows,
        user: req.session.user
      });
    }
  );
});
app.get("/search", (req, res) => {
  const { location, min, max, type, purpose } = req.query;

  let sql = `SELECT * FROM properties WHERE status='live'`;
  let params = [];

  if (location) {
    sql += ` AND location LIKE ?`;
    params.push(`%${location}%`);
  }
  if (type) {
    sql += ` AND type=?`;
    params.push(type);
  }
  if (purpose) {
    sql += ` AND purpose=?`;
    params.push(purpose);
  }
  if (min && max) {
    sql += ` AND price BETWEEN ? AND ?`;
    params.push(min, max);
  }

  db.query(sql, params, (err, rows) => {
    res.render("user/listings", {
      title: "Search Results",
      properties: rows,
      user: req.session.user
    });
  });
});

/* ================= SERVER ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

