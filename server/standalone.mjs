/* Run the server standalone: `node server/standalone.mjs`
 *
 * Reads from environment:
 *   PORT          — listen port (default 4180)
 *   HOST          — listen host (default 127.0.0.1)
 *   DATABASE_URL  — Postgres connection string (omit for local-only mode)
 *   USERS_PATH    — path to users.json (default ./users.json)
 *   WHISPER_API_URL — URL of self-hosted Whisper instance
 */

import { startServer } from "./httpServer.mjs";

const port = Number(process.env.PORT) || 4180;
const host = process.env.HOST || "127.0.0.1";
const dbUrl = process.env.DATABASE_URL;
const usersPath = process.env.USERS_PATH;

const dbConfig = dbUrl ? { connectionString: dbUrl } : undefined;

const { url } = await startServer({
  port,
  host,
  dbConfig,
  usersPath,
});

console.log(`Pauken server running at ${url}`);
