require("dotenv").config();
require('events').EventEmitter.defaultMaxListeners = 20;

const express = require("express");
const nunjucks = require("nunjucks");
const { customAlphabet } = require("nanoid");
const nanoid = customAlphabet("1234567890", 12);
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const cookie = require("cookie")
const bodyParser = require("body-parser");
const { WebSocketServer } = require("ws");
const {createServer} = require("http");

const app = express();

const { MongoClient, ObjectId } = require("mongodb");
const clientPromise = MongoClient.connect(process.env.DB_URI, {
  maxPoolSize: 10,
  useUnifiedTopology: true,
});

nunjucks.configure("views", {
  autoescape: true,
  express: app,
  tags: {
    blockStart: "[%",
    blockEnd: "%]",
    variableStart: "[[",
    variableEnd: "]]",
    commentStart: "[#",
    commentEnd: "#]",
  },
});

app.set("view engine", "njk");
app.use(express.json());
app.use(express.static("public"));
app.use(cookieParser());
app.use(async (req, res, next) => {
  try {
    const client = await clientPromise;
    req.db = client.db("users");
    next();
  } catch (error) {
    next(error);
  }
});
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  res.status(500).send(err.message);
});

const hash = (d) => crypto.createHash("sha256").update(d).digest("hex");

const auth = () => async (req, res, next) => {
  if (!req.cookies["sessionId"]) {
    return req.baseUrl === 'api/timers' ? res.sendStatus(401) : next();
  }
  const user = await findUserBySessionId(req.db, req.cookies["sessionId"]);
  req.user = user;
  req.sessionId = req.cookies["sessionId"];
  next();
};

const findUserByUsername = async (db, username) => db.collection("users").findOne({ username });

const findUserBySessionId = async (db, sessionId) => {
  const session = await db.collection("sessions").findOne({ sessionId }, { projection: { userId: 1 } });

  if (!session) {
    return;
  }

  return db.collection("users").findOne({ _id: new ObjectId(session.userId) });
};

const createSession = async (db, userId) => {
  const sessionId = nanoid();
  await db.collection("sessions").insertOne({
    userId,
    sessionId,
  });

  return sessionId;
};

const deleteSession = async (db, sessionId) => {
  await db.collection("sessions").deleteOne({ sessionId });
};

// functions fo wss
const sendTimers = async (db, userId, ws) => {
  const timers = await db.collection("timers").find({ userId: userId }).toArray();

  const timersUpdated = timers.map((t) => {
    if (!t.end) {
      return {
        ...t,
        start: +t.start,
        progress: Date.now() - +t.start,
      }
    }
    return {
      ...t,
      start: +t.start,
      end: +t.end,
      duration: +t.end - +t.start,
    }
  });

  ws.send(
    JSON.stringify({
      type: 'all_timers',
      timers: timersUpdated,
    })
  );
}

const getActiveTimers = async (db, userId) => {
  const timers = await db.collection("timers").find({ userId: userId, isActive: true }).toArray();

  return timers.map((t) => {
    return {
      ...t,
      progress: Date.now() - t.start,
    }
  })
}

app.get("/", auth(), (req, res) => {
  res.render("index", {
    user: req.user,
    authError: req.query.authError === "true",
    createdUser: req.query.user,
    sessionId: req.sessionId,
  });
});

app.post("/login", bodyParser.urlencoded({ extended: false }), async (req, res) => {
  const { username, password } = req.body;
  const user = await findUserByUsername(req.db, username);
  if (!user || user.password !== hash(password)) {
    return res.redirect("/?authError=true");
  }
  const sessionId = await createSession(req.db, user._id);
  res.cookie("sessionId", sessionId, { httpOnly: true }).redirect("/");
});

app.post("/signup", bodyParser.urlencoded({ extended: false }), async (req, res) => {
  const { username, password } = req.body;
  const userPassword = hash(password);

  const { insertedId } = await req.db.collection("users").insertOne({
    username,
    password: userPassword,
  });

  const sessionId = await createSession(req.db, insertedId);
  res.cookie("sessionId", sessionId, { httpOnly: true }).redirect("/");
});

app.get("/logout", auth(), async (req, res) => {
  if (!req.user) {
    return res.redirect("/");
  }
  await deleteSession(req.db, req.sessionId);
  res.clearCookie("sessionId").redirect("/");
});

app.get("/api/timers", auth(), async (req, res) => {
  const user = await findUserByUsername(req.db, req.user.username);
  const timers = await req.db.collection("timers").find({ userId: user._id }).toArray();
  if (req.query.isActive === "true") {
    const activeArr = timers.filter((t) => t.isActive === true);
    activeArr.map((t) => {
      t.progress = Date.now() - t.start;
    });
    return res.json(activeArr);
  }

  if (req.query.isActive === "false") {
    const notActiveArr = timers.filter((t) => t.isActive === false);
    notActiveArr.map((t) => {
      t.duration = t.end - t.start;
    });
    return res.json(notActiveArr);
  }
});

app.post("/api/timers", auth(), async (req, res) => {
  const user = await findUserByUsername(req.db, req.user.username);
  const newTimer = {
    _id: nanoid(),
    start: Date.now(),
    description: req.body.description,
    isActive: true,
    userId: user._id,
  };

  const timer = await req.db.collection("timers").insertOne({
    id: newTimer._id,
    start: newTimer.start,
    isActive: newTimer.isActive,
    description: newTimer.description,
    userId: newTimer.userId,
  });

  res.json(timer.insertedId);
});

app.post("/api/timers/:id/stop", auth(), async (req, res) => {
  const timerId = req.params.id;
  const end = Date.now();
  const timer = await req.db
    .collection("timers")
    .findOneAndUpdate({ id: timerId }, { $set: { isActive: false, end: end } }, { returnOriginal: false });

  res.json(timer);
});

const server = createServer(app);
const wss = new WebSocketServer({ clientTracking: false, noServer: true });

server.on('upgrade', async (req, socket, head) => {
  const mongoClient = await clientPromise;
  const db = mongoClient.db('users');
  const cookies = cookie.parse(req.headers.cookie);
  const sessionId = cookies['sessionId'];

  const user = await findUserBySessionId(db, sessionId);
  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  req.db = db;
  req.user = user;
  
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  })
});

wss.on('connection', async (ws, req) => {
  const userId = req.user._id;

  await sendTimers(req.db, userId, ws);

  setInterval(async () => {
    const activeTimers = await getActiveTimers(req.db, userId);
    ws.send(
      JSON.stringify({
        type: 'active_timers',
        timers: activeTimers,
      })
    )
  }, 1000);

  ws.on('message', async (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (error) {
      return;
    }

    if (data.message === 'get_timers') {
      await sendTimers(req.db, userId, ws);
    }
  });
});

const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log(`  Listening on http://localhost:${port}`);
});
