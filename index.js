require("dotenv").config();

const express = require("express");
const nunjucks = require("nunjucks");
const { customAlphabet } = require("nanoid");
const nanoid = customAlphabet("1234567890", 12);
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");

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

const hash = (d) => crypto.createHash("sha256").update(d).digest("hex");

const auth = () => async (req, res, next) => {
  if (!req.cookies["sessionId"]) {
    return next();
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

app.get("/", auth(), (req, res) => {
  res.render("index", {
    user: req.user,
    authError: req.query.authError === "true",
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
  console.log(timerId);
  const end = Date.now();
  const timer = await req.db
    .collection("timers")
    .findOneAndUpdate({ id: timerId }, { $set: { isActive: false, end: end } }, { returnOriginal: false });

  res.json(timer);
});

app.get("/", auth(), (req, res) => {
  res.render("index", {
    user: req.user,
    authError: req.query.authError === "true" ? "Wrong username or password" : req.query.authError,
  });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`  Listening on http://localhost:${port}`);
});
