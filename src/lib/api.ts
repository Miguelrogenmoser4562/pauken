import type { ActivityEvent, PaukenUser } from "./types";
import type { Store } from "./db";

export interface VerifyResult {
  user: PaukenUser | null;
  error?: string;
}

/* Verify a user key against the server and return user info. */
export async function verifyKey(
  serverUrl: string,
  key: string,
): Promise<PaukenUser | null> {
  try {
    const res = await fetch(`${serverUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.user as PaukenUser;
  } catch {
    return null;
  }
}

/* Like verifyKey but returns the raw body on failure. */
export async function verifyKeyWithError(
  serverUrl: string,
  key: string,
): Promise<VerifyResult> {
  try {
    const res = await fetch(`${serverUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { user: null, error: body.error || `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { user: data.user as PaukenUser };
  } catch (err) {
    return { user: null, error: String(err) };
  }
}

/* Check server health. */
export async function serverHealth(
  serverUrl: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* Fetch activity events for a class. */
export async function fetchActivity(
  serverUrl: string,
  userKey: string,
  classId: string,
): Promise<ActivityEvent[]> {
  try {
    const res = await fetch(`${serverUrl}/api/activity/${classId}`, {
      headers: { authorization: `Bearer ${userKey}` },
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

/* ---- Admin API helpers ------------------------------------------------- */

export async function fetchAdminUsers(
  serverUrl: string,
  userKey: string,
): Promise<Array<{ id: string; name: string; key: string; isAdmin: boolean }>> {
  try {
    const res = await fetch(`${serverUrl}/api/admin/users`, {
      headers: { authorization: `Bearer ${userKey}` },
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export async function deleteUserData(
  serverUrl: string,
  userKey: string,
  userId: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/api/admin/users/${userId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${userKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function updateMyAvatar(
  serverUrl: string,
  userKey: string,
  avatar: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/api/users/me`, {
      method: "PUT",
      headers: { authorization: `Bearer ${userKey}`, "content-type": "application/json" },
      body: JSON.stringify({ avatar }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function createUser(
  serverUrl: string,
  userKey: string,
  name: string,
): Promise<{ id: string; name: string; key: string; isAdmin: boolean } | null> {
  try {
    const res = await fetch(`${serverUrl}/api/admin/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${userKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function updateAdminUser(
  serverUrl: string,
  userKey: string,
  userId: string,
  patch: { isAdmin?: boolean; name?: string },
): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/api/admin/users/${userId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${userKey}`, "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function resetDatabase(
  serverUrl: string,
  userKey: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/api/admin/reset-db`, {
      method: "POST",
      headers: { authorization: `Bearer ${userKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* A Store implementation that proxies all operations to the Pauken API server. */
export class ServerStore implements Store {
  constructor(
    private baseUrl: string,
    private userKey: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.userKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const msg = `API ${method} ${path}: ${res.status}`;
      throw new Error(msg);
    }
    if (res.status === 204) return undefined as T;
    return res.json();
  }

  async get<T>(collection: string, id: string): Promise<T | undefined> {
    try {
      return await this.request<T>("GET", `/api/${collection}/${id}`);
    } catch {
      return undefined;
    }
  }

  async put<T extends { id: string }>(
    collection: string,
    value: T,
  ): Promise<T> {
    return this.request<T>("PUT", `/api/${collection}/${value.id}`, value);
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.request("DELETE", `/api/${collection}/${id}`);
  }

  async all<T>(collection: string): Promise<T[]> {
    return this.request<T[]>("GET", `/api/${collection}`);
  }

  async where<T>(
    collection: string,
    match: Partial<T>,
  ): Promise<T[]> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(match)) {
      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    }
    const qs = params.toString();
    const path = qs ? `/api/${collection}?${qs}` : `/api/${collection}`;
    return this.request<T[]>("GET", path);
  }

  async clear(collection: string): Promise<void> {
    const items = await this.all<{ id: string }>(collection);
    await Promise.all(items.map((item) => this.delete(collection, item.id)));
  }
}
