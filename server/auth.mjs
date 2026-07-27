import fs from "node:fs";

export function loadUsers(usersPath) {
  const raw = fs.readFileSync(usersPath, "utf8");
  const { users } = JSON.parse(raw);
  const byKey = new Map();
  const byId = new Map();
  for (const u of users) {
    byKey.set(u.key, u);
    byId.set(u.id, u);
  }
  return { users, byKey, byId };
}

export function authMiddleware(usersByKey) {
  return (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return res.status(401).json({ error: "missing authorization" });
    }
    const user = usersByKey.get(auth.slice(7));
    if (!user) {
      return res.status(401).json({ error: "invalid key" });
    }
    req.user = user;
    next();
  };
}
