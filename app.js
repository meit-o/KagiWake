import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { CosmosClient } from "@azure/cosmos";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
const storePath = path.join(dataDir, "store.json");
const distDir = path.join(__dirname, "dist");

const memberColors = ["#0f766e", "#c2410c", "#2563eb", "#7c3aed", "#ca8a04", "#be123c", "#475569", "#0891b2"];

const firebaseProjectId = process.env.FIREBASE_PROJECT_ID || "";
const firebaseClientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
const firebasePrivateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const firebaseAdminAuth =
  firebaseProjectId && firebaseClientEmail && firebasePrivateKey
    ? getAuth(
        getApps()[0] ||
          initializeApp({
            credential: cert({
              projectId: firebaseProjectId,
              clientEmail: firebaseClientEmail,
              privateKey: firebasePrivateKey
            })
          })
      )
    : null;

const defaultStore = {
  users: [],
  sessions: [],
  groups: []
};

const app = express();
// Vercel (and most PaaS hosts) sit behind a reverse proxy that terminates TLS.
// Without this, req.protocol always reports "http", which made invite links
// render as http://... instead of https://... in production.
app.set("trust proxy", true);
app.use(express.json({ limit: "64kb" }));

// ---------------------------------------------------------------------------
// storage
//
// Two backends are supported behind the same readStore()/writeStore() shape:
//   - Azure Cosmos DB, used automatically when COSMOS_ENDPOINT and COSMOS_KEY
//     are set (this is what runs in production, on Azure App Service or
//     Vercel — both are fine since state now lives in Cosmos DB, not on disk).
//   - A local JSON file (data/store.json), used otherwise, so local
//     development doesn't require an Azure account.
// ---------------------------------------------------------------------------

const cosmosEndpoint = process.env.COSMOS_ENDPOINT || "";
const cosmosKey = process.env.COSMOS_KEY || "";
const cosmosDatabaseName = process.env.COSMOS_DATABASE || "rapan";
const cosmosContainerName = process.env.COSMOS_CONTAINER || "state";
const useCosmos = Boolean(cosmosEndpoint && cosmosKey);
const STATE_DOC_ID = "app-state";

if ((cosmosEndpoint && !cosmosKey) || (!cosmosEndpoint && cosmosKey)) {
  console.warn(
    "COSMOS_ENDPOINT and COSMOS_KEY must both be set to use Azure Cosmos DB. Falling back to local file storage."
  );
}

let readStore;
let writeStore;

async function setupFileStore() {
  readStore = async function readStore() {
    await fs.mkdir(dataDir, { recursive: true });

    try {
      const raw = await fs.readFile(storePath, "utf8");
      const parsed = JSON.parse(raw);

      return {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        groups: Array.isArray(parsed.groups) ? parsed.groups : []
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn("Could not read data store. Starting with defaults.", error);
      }

      await writeStore(defaultStore);
      return structuredClone(defaultStore);
    }
  };

  writeStore = async function writeStore(store) {
    await fs.mkdir(dataDir, { recursive: true });
    const tempPath = `${storePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, storePath);
  };

  console.log("Storage: local file (data/store.json).");
}

async function setupCosmosStore() {
  const client = new CosmosClient({ endpoint: cosmosEndpoint, key: cosmosKey });

  const { database } = await client.databases.createIfNotExists({
    id: cosmosDatabaseName,
    throughput: 400
  });

  const { container } = await database.containers.createIfNotExists({
    id: cosmosContainerName,
    partitionKey: { paths: ["/id"] }
  });

  readStore = async function readStore() {
    try {
      const { resource } = await container.item(STATE_DOC_ID, STATE_DOC_ID).read();

      if (!resource) {
        await writeStore(defaultStore);
        return structuredClone(defaultStore);
      }

      return {
        users: Array.isArray(resource.users) ? resource.users : [],
        sessions: Array.isArray(resource.sessions) ? resource.sessions : [],
        groups: Array.isArray(resource.groups) ? resource.groups : []
      };
    } catch (error) {
      if (error.code === 404) {
        await writeStore(defaultStore);
        return structuredClone(defaultStore);
      }
      throw error;
    }
  };

  writeStore = async function writeStore(store) {
    await container.items.upsert({ id: STATE_DOC_ID, ...store });
  };

  console.log(`Storage: Azure Cosmos DB (database: ${cosmosDatabaseName}, container: ${cosmosContainerName}).`);
}

if (useCosmos) {
  await setupCosmosStore();
} else {
  await setupFileStore();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

function firebaseUsername(decodedToken) {
  const preferred = cleanText(decodedToken.name || decodedToken.email?.split("@")[0] || "Googleユーザー", 24);
  return preferred || "Googleユーザー";
}

function uniqueUsername(store, preferred, userId) {
  const base = preferred.slice(0, 24) || "Googleユーザー";
  let username = base;
  let suffix = 2;
  while (store.users.some((user) => user.id !== userId && user.username.toLowerCase() === username.toLowerCase())) {
    const suffixText = ` (${suffix})`;
    username = `${base.slice(0, 24 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return username;
}

function generateInviteCode(existingCodes) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  do {
    code = Array.from({ length: 10 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  } while (existingCodes.has(code));

  return code;
}

function publicUser(user) {
  return { id: user.id, username: user.username };
}

function findGroupByUserId(store, userId) {
  return store.groups.find((group) => group.members.some((member) => member.userId === userId)) || null;
}

function inviteLinkFor(request, code) {
  if (!code) return null;
  return `${request.protocol}://${request.get("host")}/join?code=${code}`;
}

function nextColor(group) {
  return memberColors[group.members.length % memberColors.length];
}

function publicGroup(group, request) {
  return {
    id: group.id,
    name: group.name,
    inviteCode: group.inviteCode,
    inviteLink: inviteLinkFor(request, group.inviteCode),
    members: group.members.map((member) => ({
      userId: member.userId,
      displayName: member.displayName,
      color: member.color
    })),
    reservations: group.reservations
  };
}

// ---------------------------------------------------------------------------
// reservation logic
// ---------------------------------------------------------------------------

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hours, minutes] = value.split(":").map(Number);
  return hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60;
}

function dateIndex(value) {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function timeMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function reservationInterval(reservation) {
  const startDay = dateIndex(reservation.startDate);
  const endDay = dateIndex(reservation.endDate);

  if (reservation.allDay) {
    return {
      start: startDay * 1440,
      end: (endDay + 1) * 1440
    };
  }

  return {
    start: startDay * 1440 + timeMinutes(reservation.startTime),
    end: endDay * 1440 + timeMinutes(reservation.endTime)
  };
}

function reservationsOverlap(first, second) {
  const a = reservationInterval(first);
  const b = reservationInterval(second);
  return a.start < b.end && b.start < a.end;
}

function findConflicts(candidate, reservations, skipId) {
  return reservations.filter((reservation) => reservation.id !== skipId && reservationsOverlap(candidate, reservation));
}

function validateReservation(reservation) {
  const { startDate, endDate, allDay, startTime, endTime } = reservation;

  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw httpError(400, "日付を確認してください。");
  }

  if (dateIndex(endDate) < dateIndex(startDate)) {
    throw httpError(400, "終了日は開始日以降にしてください。");
  }

  if (!allDay) {
    if (!isTime(startTime) || !isTime(endTime)) {
      throw httpError(400, "時間を確認してください。");
    }

    const span = reservationInterval(reservation);
    if (span.end <= span.start) {
      throw httpError(400, "終了時刻は開始時刻より後にしてください。");
    }
  }
}

function normalizeReservation(body, userId, existingId) {
  const reservation = {
    id: existingId || crypto.randomUUID(),
    userId,
    title: cleanText(body.title, 40),
    startDate: cleanText(body.startDate, 10),
    endDate: cleanText(body.endDate, 10),
    allDay: body.allDay !== false,
    startTime: cleanText(body.startTime, 5),
    endTime: cleanText(body.endTime, 5),
    notes: cleanText(body.notes, 160),
    createdAt: body.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  validateReservation(reservation);

  if (reservation.allDay) {
    reservation.startTime = "";
    reservation.endTime = "";
  }

  return reservation;
}

// ---------------------------------------------------------------------------
// auth middleware
// ---------------------------------------------------------------------------

async function authenticate(request, response, next) {
  try {
    const header = request.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

    if (!token) {
      throw httpError(401, "ログインしてください。");
    }

    const store = await readStore();
    const session = store.sessions.find((item) => item.token === token);
    if (!session) {
      throw httpError(401, "ログインしてください。");
    }

    const user = store.users.find((item) => item.id === session.userId);
    if (!user) {
      throw httpError(401, "ログインしてください。");
    }

    request.store = store;
    request.token = token;
    request.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function requireGroup(request, response, next) {
  const group = findGroupByUserId(request.store, request.user.id);
  if (!group) {
    next(httpError(409, "グループに参加してください。"));
    return;
  }
  request.group = group;
  next();
}

// ---------------------------------------------------------------------------
// auth routes
// ---------------------------------------------------------------------------

app.post("/api/auth/signup", async (request, response, next) => {
  try {
    const username = cleanText(request.body.username, 24);
    const password = typeof request.body.password === "string" ? request.body.password : "";

    if (username.length < 2) {
      throw httpError(400, "ユーザー名は2文字以上で入力してください。");
    }
    if (password.length < 4) {
      throw httpError(400, "パスワードは4文字以上で入力してください。");
    }

    const store = await readStore();
    const exists = store.users.some((user) => user.username.toLowerCase() === username.toLowerCase());
    if (exists) {
      throw httpError(409, "そのユーザー名はすでに使われています。");
    }

    const { salt, hash } = hashPassword(password);
    const user = { id: crypto.randomUUID(), username, salt, hash, createdAt: new Date().toISOString() };
    store.users.push(user);

    const token = generateToken();
    store.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });

    await writeStore(store);
    response.status(201).json({ token, user: publicUser(user), group: null });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", async (request, response, next) => {
  try {
    const username = cleanText(request.body.username, 24);
    const password = typeof request.body.password === "string" ? request.body.password : "";

    const store = await readStore();
    const user = store.users.find((item) => item.username.toLowerCase() === username.toLowerCase());

    if (!user || !verifyPassword(password, user.salt, user.hash)) {
      throw httpError(401, "ユーザー名またはパスワードが違います。");
    }

    const token = generateToken();
    store.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
    await writeStore(store);

    const group = findGroupByUserId(store, user.id);
    response.json({ token, user: publicUser(user), group: group ? publicGroup(group, request) : null });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/firebase", async (request, response, next) => {
  try {
    if (!firebaseAdminAuth) {
      throw httpError(503, "Firebase認証のサーバー設定がありません。");
    }

    const idToken = typeof request.body.idToken === "string" ? request.body.idToken : "";
    if (!idToken) throw httpError(401, "Firebaseの認証情報がありません。");

    const decodedToken = await firebaseAdminAuth.verifyIdToken(idToken);
    const store = await readStore();
    let user = store.users.find((item) => item.firebaseUid === decodedToken.uid);

    if (!user) {
      user = {
        id: crypto.randomUUID(),
        username: uniqueUsername(store, firebaseUsername(decodedToken)),
        firebaseUid: decodedToken.uid,
        authProvider: "google",
        createdAt: new Date().toISOString()
      };
      store.users.push(user);
    }

    const token = generateToken();
    store.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
    await writeStore(store);

    const group = findGroupByUserId(store, user.id);
    response.json({ token, user: publicUser(user), group: group ? publicGroup(group, request) : null });
  } catch (error) {
    if (
      error.code === "auth/id-token-expired" ||
      error.code === "auth/argument-error" ||
      error.code === "auth/invalid-id-token"
    ) {
      next(httpError(401, "Google認証の有効期限が切れています。もう一度ログインしてください。"));
      return;
    }
    next(error);
  }
});

app.post("/api/auth/logout", authenticate, async (request, response, next) => {
  try {
    request.store.sessions = request.store.sessions.filter((item) => item.token !== request.token);
    await writeStore(request.store);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/me", authenticate, async (request, response) => {
  const group = findGroupByUserId(request.store, request.user.id);
  response.json({ user: publicUser(request.user), group: group ? publicGroup(group, request) : null });
});

// ---------------------------------------------------------------------------
// group routes
// ---------------------------------------------------------------------------

app.post("/api/groups", authenticate, async (request, response, next) => {
  try {
    const existingGroup = findGroupByUserId(request.store, request.user.id);
    if (existingGroup) {
      throw httpError(409, "すでにグループに参加しています。");
    }

    const name = cleanText(request.body.name, 28) || "わが家";

    const group = {
      id: crypto.randomUUID(),
      name,
      inviteCode: null,
      createdAt: new Date().toISOString(),
      members: [
        {
          userId: request.user.id,
          displayName: request.user.username,
          color: memberColors[0],
          joinedAt: new Date().toISOString()
        }
      ],
      reservations: []
    };

    request.store.groups.push(group);
    await writeStore(request.store);
    response.status(201).json(publicGroup(group, request));
  } catch (error) {
    next(error);
  }
});

app.post("/api/groups/join", authenticate, async (request, response, next) => {
  try {
    const existingGroup = findGroupByUserId(request.store, request.user.id);
    if (existingGroup) {
      throw httpError(409, "すでにグループに参加しています。");
    }

    const code = cleanText(request.body.code, 12).toUpperCase();
    const group = request.store.groups.find((item) => item.inviteCode === code);
    if (!group) {
      throw httpError(404, "招待コードが見つかりません。");
    }

    group.members.push({
      userId: request.user.id,
      displayName: request.user.username,
      color: nextColor(group),
      joinedAt: new Date().toISOString()
    });

    await writeStore(request.store);
    response.json(publicGroup(group, request));
  } catch (error) {
    next(error);
  }
});

app.get("/api/group", authenticate, requireGroup, async (request, response) => {
  response.json(publicGroup(request.group, request));
});

app.post("/api/group/invite-code", authenticate, requireGroup, async (request, response, next) => {
  try {
    const existingCodes = new Set(request.store.groups.map((item) => item.inviteCode).filter(Boolean));
    request.group.inviteCode = generateInviteCode(existingCodes);
    await writeStore(request.store);
    response.json(publicGroup(request.group, request));
  } catch (error) {
    next(error);
  }
});

app.put("/api/group", authenticate, requireGroup, async (request, response, next) => {
  try {
    const name = cleanText(request.body.name, 28);
    if (!name) {
      throw httpError(400, "名前を入力してください。");
    }

    request.group.name = name;
    await writeStore(request.store);
    response.json(publicGroup(request.group, request));
  } catch (error) {
    next(error);
  }
});

app.put("/api/profile", authenticate, requireGroup, async (request, response, next) => {
  try {
    const displayName = cleanText(request.body.displayName, 20);
    if (!displayName) {
      throw httpError(400, "表示名を入力してください。");
    }

    const member = request.group.members.find((item) => item.userId === request.user.id);
    member.displayName = displayName;
    await writeStore(request.store);
    response.json(publicGroup(request.group, request));
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// reservation routes
// ---------------------------------------------------------------------------

app.post("/api/reservations", authenticate, requireGroup, async (request, response, next) => {
  try {
    const reservation = normalizeReservation(request.body, request.user.id);

    const conflicts = findConflicts(reservation, request.group.reservations);
    if (conflicts.length > 0) {
      response.status(409).json({ message: "その時間帯はすでに予約されています。", conflicts });
      return;
    }

    request.group.reservations.push(reservation);
    await writeStore(request.store);
    response.status(201).json(reservation);
  } catch (error) {
    next(error);
  }
});

app.put("/api/reservations/:id", authenticate, requireGroup, async (request, response, next) => {
  try {
    const index = request.group.reservations.findIndex((item) => item.id === request.params.id);
    if (index === -1) {
      throw httpError(404, "予約が見つかりません。");
    }

    const existing = request.group.reservations[index];
    if (existing.userId !== request.user.id) {
      throw httpError(403, "ほかの人の予約は編集できません。");
    }

    const reservation = normalizeReservation(
      { ...request.body, createdAt: existing.createdAt },
      request.user.id,
      request.params.id
    );

    const conflicts = findConflicts(reservation, request.group.reservations, request.params.id);
    if (conflicts.length > 0) {
      response.status(409).json({ message: "その時間帯はすでに予約されています。", conflicts });
      return;
    }

    request.group.reservations[index] = reservation;
    await writeStore(request.store);
    response.json(reservation);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/reservations/:id", authenticate, requireGroup, async (request, response, next) => {
  try {
    const target = request.group.reservations.find((item) => item.id === request.params.id);
    if (!target) {
      throw httpError(404, "予約が見つかりません。");
    }

    if (target.userId !== request.user.id) {
      throw httpError(403, "ほかの人の予約は取り消せません。");
    }

    request.group.reservations = request.group.reservations.filter((item) => item.id !== request.params.id);
    await writeStore(request.store);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// static + error handling
// ---------------------------------------------------------------------------

let distAvailable = false;
try {
  await fs.access(distDir);
  distAvailable = true;
} catch {
  distAvailable = false;
}

if (distAvailable) {
  app.use(express.static(distDir));
  // Express 5 rejects the old Express 4 "*" wildcard path, so the SPA
  // fallback (needed for deep links like /join?code=...) is registered as
  // a path-less middleware instead, which matches any method/path.
  app.use((_request, response) => {
    response.sendFile(path.join(distDir, "index.html"));
  });
} else {
  app.get("/", (_request, response) => {
    response.type("text/plain").send("Run npm run dev and open the Vite URL.");
  });
}

app.use((error, _request, response, _next) => {
  const status = error.status || 500;
  response.status(status).json({
    message: status === 500 ? "サーバーでエラーが発生しました。" : error.message
  });
});

export default app;
