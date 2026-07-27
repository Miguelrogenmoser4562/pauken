import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Copy,
  Download,
  Pencil,
  Server,
  Settings as SettingsIcon,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useApp } from "../lib/app";
import { exportMarkdown, downloadText } from "../lib/export";
import { serverHealth, verifyKeyWithError, fetchAdminUsers, deleteUserData, resetDatabase, createUser, updateAdminUser, updateMyAvatar } from "../lib/api";
import type { PaukenUser } from "../lib/types";

const DATA_FOLDER = (() => {
  if (typeof navigator === "undefined") return "~/.local/share/Pauken";
  const p = navigator.platform;
  if (p.startsWith("Win")) return "%APPDATA%\\Pauken";
  if (p.startsWith("Linux")) return "~/.local/share/Pauken";
  return "~/Library/Application Support/Pauken";
})();

export default function Settings() {
  const location = useLocation();
  const { prefs, savePrefs, repo, user, reconnect, disconnect, clearLocalData } = useApp();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [navMsg] = useState((location.state as { msg?: string })?.msg ?? "");
  const [exportMsg, setExportMsg] = useState("");

  /* Server connection state */
  const [serverUrl, setServerUrl] = useState(prefs.serverUrl ?? "");
  const [userKey, setUserKey] = useState(prefs.userKey ?? "");
  const [connStatus, setConnStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [connMsg, setConnMsg] = useState("");
  const [serverUsers, setServerUsers] = useState<PaukenUser[]>([]);

  /* Admin state */
  const [adminUsers, setAdminUsers] = useState<Array<{ id: string; name: string; key: string; isAdmin: boolean; avatar?: string }>>([]);
  const [adminMsg, setAdminMsg] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserResult, setNewUserResult] = useState<string | null>(null);

  const handleAvatarPicked = (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      savePrefs({ ...prefs, avatar: dataUrl });
      if (prefs.serverUrl && prefs.userKey) {
        updateMyAvatar(prefs.serverUrl, prefs.userKey, dataUrl).catch(() => {});
      }
    };
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  async function connect() {
    if (!serverUrl.trim()) return;
    setConnStatus("connecting");
    setConnMsg("");

    const alive = await serverHealth(serverUrl.trim());
    if (!alive) {
      setConnStatus("error");
      setConnMsg("Server unreachable — check the URL.");
      return;
    }

    if (!userKey.trim()) {
      setConnStatus("error");
      setConnMsg("Enter your Pauken user key.");
      return;
    }

    const result = await verifyKeyWithError(serverUrl.trim(), userKey.trim());
    if (!result.user) {
      setConnStatus("error");
      setConnMsg(result.error ? `Invalid key: ${result.error}` : "Invalid user key.");
      return;
    }
    await reconnect(serverUrl.trim(), userKey.trim());
    setConnStatus("connected");
  }

  async function doDisconnect() {
    disconnect();
    setConnStatus("idle");
    setConnMsg("");
    setUserKey("");
  }

  useEffect(() => {
    if (user && repo) {
      repo.listUsers().then(setServerUsers).catch(() => {});
      if (user.isAdmin && prefs.serverUrl && prefs.userKey) {
        fetchAdminUsers(prefs.serverUrl, prefs.userKey).then(setAdminUsers).catch(() => {});
      }
    } else {
      setServerUsers([]);
      setAdminUsers([]);
    }
  }, [user, repo, prefs.serverUrl, prefs.userKey]);

  const initial = user?.name?.charAt(0).toUpperCase() ?? "?";

  return (
    <div className="px-10 py-8">
      <input ref={fileInputRef} type="file" accept="image/*" hidden
        onChange={(e) => void handleAvatarPicked(e.target.files)} />
      <div className="flex items-center gap-3">
        <SettingsIcon className="size-6 text-accent" />
        <h1 className="text-4xl font-bold tracking-tight">Settings</h1>
      </div>
      <p className="mt-1 text-lg text-ink-faint">Manage your profile and preferences</p>
      {navMsg && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-warning-ink/30 bg-warning-soft px-4 py-3 text-sm font-semibold text-warning-ink">
          <AlertCircle className="size-4 shrink-0" />
          {navMsg}
        </div>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-[380px_1fr]">
        <div className="overflow-hidden rounded-card border border-edge bg-card shadow-soft">
          <div className="h-24 bg-accent-soft" />
          <div className="-mt-10 flex flex-col items-center px-6 pb-6">
            <div className="relative">
              {prefs.avatar ? (
                <img src={prefs.avatar} alt="Avatar" className="size-20 rounded-full border-4 border-card object-cover" />
              ) : (
                <div className="flex size-20 items-center justify-center rounded-full border-4 border-card bg-accent-softer font-display text-2xl font-bold text-accent">
                  {initial}
                </div>
              )}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="absolute -bottom-1 -left-1 rounded-full border border-edge bg-card p-1.5 text-ink-dim shadow-soft hover:text-ink"
                aria-label="Change avatar"
              >
                <Camera className="size-3.5" />
              </button>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className="font-display text-xl font-bold">{user?.name ?? "You"}</span>
              <Pencil className="size-3.5 text-ink-faint" />
            </div>
            <span className="text-sm text-ink-faint">
              {user ? `Connected to ${prefs.serverUrl}` : "Local account — nothing leaves this device"}
            </span>

            <div className="mt-5 w-full space-y-3">
              <Field label="Language" value={prefs.language} editable />
              <div className="flex items-center justify-between rounded-xl border border-edge bg-panel px-4 py-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-ink-faint">Default reminder time</p>
                  <input
                    type="time"
                    value={prefs.defaultReminderTime}
                    onChange={(e) => savePrefs({ ...prefs, defaultReminderTime: e.target.value })}
                    className="bg-transparent text-sm font-semibold text-ink outline-none [color-scheme:dark]"
                  />
                </div>
              </div>
              <Field label="Data folder" value={DATA_FOLDER} copyable />
            </div>
          </div>
        </div>

        <div className="space-y-6">
          {/* Server connection */}
          <div className="rounded-card border border-edge bg-card p-6 shadow-soft">
            <h2 className="flex items-center gap-2 font-display text-xl font-bold">
              {user ? <Wifi className="size-5 text-accent" /> : <WifiOff className="size-5 text-ink-faint" />}
              Pauken Server
            </h2>
            <p className="mt-1 text-sm text-ink-faint">
              Connect to a multi-user Pauken server to share classes and sync progress.
            </p>

            {user ? (
              <div className="mt-4 space-y-3">
                <div className="flex items-center gap-2 rounded-xl border border-edge bg-panel px-3 py-2.5">
                  <Server className="size-4 text-ink-faint" />
                  <span className="text-sm">{prefs.serverUrl}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <CheckCircle2 className="size-4" />
                  Connected as <strong>{user.name}</strong>
                </div>
                <button
                  onClick={doDisconnect}
                  className="rounded-xl border border-danger-edge bg-danger-bg px-4 py-2 text-sm font-bold text-danger-ink hover:bg-danger-soft"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="flex items-center gap-2 rounded-xl border border-edge bg-panel px-3 py-2.5">
                  <Server className="size-4 shrink-0 text-ink-faint" />
                  <input
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    placeholder="Server URL (e.g. https://pauken.memorax.us:4181)"
                    className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
                  />
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-edge bg-panel px-3 py-2.5">
                  <CheckCircle2 className="size-4 shrink-0 text-ink-faint" />
                  <input
                    type="password"
                    value={userKey}
                    onChange={(e) => setUserKey(e.target.value)}
                    placeholder="Your Pauken user key"
                    className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={connect}
                    disabled={connStatus === "connecting"}
                    className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover disabled:opacity-60"
                  >
                    {connStatus === "connecting" ? "Connecting…" : "Connect"}
                  </button>
                  {connStatus === "connected" && (
                    <span className="flex items-center gap-1 text-sm font-semibold text-green-600">
                      <CheckCircle2 className="size-4" /> Connected
                    </span>
                  )}
                </div>
                {connStatus === "error" && (
                  <p className="text-xs font-semibold text-danger-ink">{connMsg}</p>
                )}
              </div>
            )}
          </div>

          {/* Server Users / Partners */}
          {user && serverUsers.length > 0 && (
            <div className="rounded-card border border-edge bg-card p-6 shadow-soft">
              <h2 className="flex items-center gap-2 font-display text-xl font-bold">
                <Users className="size-5 text-accent" />
                Users on Server
              </h2>
              <p className="mt-1 text-sm text-ink-faint">
                These users can be added as members of your classes.
              </p>
              <div className="mt-4 space-y-2">
                {serverUsers.map((u) => {
                  const isMe = u.id === user.id;
                  const userAvatar = u.avatar || prefs.avatar && isMe ? (isMe ? prefs.avatar : u.avatar) : undefined;
                  return (
                    <div
                      key={u.id}
                      className="flex items-center gap-3 rounded-xl border border-edge bg-panel px-4 py-3"
                    >
                      {userAvatar ? (
                        <img src={userAvatar} alt="" className="size-8 shrink-0 rounded-full object-cover" />
                      ) : (
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-softer text-xs font-bold text-accent">
                          {u.name.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span className="text-sm font-semibold">
                        {u.name}
                        {isMe && <span className="ml-2 text-xs text-ink-faint">(you)</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Admin Panel */}
          {user?.isAdmin && (
            <div className="rounded-card border border-accent/30 bg-card p-6 shadow-soft">
              <h2 className="flex items-center gap-2 font-display text-xl font-bold text-accent">
                Admin Panel
              </h2>
              <p className="mt-1 text-sm text-ink-faint">
                Manage users and data on the Pauken server.
              </p>

              <div className="mt-4 space-y-3">
                <div className="space-y-3 rounded-card border border-edge bg-panel p-4">
                  <h3 className="text-sm font-semibold">Create User</h3>
                  <div className="flex gap-2">
                    <input
                      value={newUserName}
                      onChange={(e) => setNewUserName(e.target.value)}
                      placeholder="User name"
                      className="flex-1 rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
                    />
                    <button
                      onClick={async () => {
                        if (!newUserName.trim()) return;
                        const r = await createUser(prefs.serverUrl!, prefs.userKey!, newUserName.trim());
                        if (r) {
                          setNewUserResult(`Created: ${r.name} (key: ${r.key})`);
                          setNewUserName("");
                          fetchAdminUsers(prefs.serverUrl!, prefs.userKey!).then(setAdminUsers).catch(() => {});
                        } else {
                          setNewUserResult("Failed to create user.");
                        }
                      }}
                      className="rounded-lg bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover"
                    >
                      Create
                    </button>
                  </div>
                  {newUserResult && <p className="text-xs text-ink-dim">{newUserResult}</p>}
                </div>

                {adminUsers.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-ink-faint">All users (with keys)</p>
                    {adminUsers.map((u) => (
                      <div
                        key={u.id}
                        className="flex items-center justify-between rounded-xl border border-edge bg-panel px-4 py-3"
                      >
                        <div className="flex items-center gap-3">
                          {u.avatar ? (
                            <img src={u.avatar} alt="" className="size-8 shrink-0 rounded-full object-cover" />
                          ) : (
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-softer text-xs font-bold text-accent">
                              {u.name.charAt(0).toUpperCase()}
                            </span>
                          )}
                          <div>
                            <span className="text-sm font-semibold">
                              {u.name}
                              {u.isAdmin && <span className="ml-2 text-xs text-accent">(admin)</span>}
                            </span>
                            <p className="text-xs text-ink-faint">Key: {u.key}</p>
                            <button
                              onClick={async () => {
                                const ok = await updateAdminUser(prefs.serverUrl!, prefs.userKey!, u.id, { isAdmin: !u.isAdmin });
                                if (ok) {
                                  setAdminUsers(prev => prev.map(usr =>
                                    usr.id === u.id ? { ...usr, isAdmin: !u.isAdmin } : usr
                                  ));
                                  setAdminMsg(`${u.name} ${u.isAdmin ? "removed as" : "made"} admin.`);
                                }
                              }}
                              className="mt-1 text-xs font-semibold text-accent hover:underline"
                            >
                              {u.isAdmin ? "Remove Admin" : "Make Admin"}
                            </button>
                          </div>
                        </div>
                        {u.id !== user.id && (
                          <button
                            onClick={async () => {
                              if (!confirm(`Delete all data for ${u.name}? This cannot be undone.`)) return;
                              const ok = await deleteUserData(prefs.serverUrl!, prefs.userKey!, u.id);
                              setAdminMsg(ok ? `${u.name} deleted.` : "Delete failed.");
                              if (ok) {
                                fetchAdminUsers(prefs.serverUrl!, prefs.userKey!).then(setAdminUsers).catch(() => {});
                              }
                            }}
                            className="rounded-lg border border-danger-edge px-2 py-1 text-xs font-semibold text-danger-ink hover:bg-danger-soft"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={async () => {
                      if (!confirm("Reset entire database? All data will be lost. This cannot be undone.")) return;
                      const ok = await resetDatabase(prefs.serverUrl!, prefs.userKey!);
                      if (ok) {
                        await clearLocalData();
                        setAdminMsg("Database reset.");
                      } else {
                        setAdminMsg("Reset failed.");
                      }
                    }}
                    className="rounded-xl border border-danger-edge bg-danger-bg px-4 py-2 text-sm font-bold text-danger-ink hover:bg-danger-soft"
                  >
                    Reset Database
                  </button>
                </div>

                {adminMsg && (
                  <p className="text-xs font-semibold text-ink-faint">{adminMsg}</p>
                )}
              </div>
            </div>
          )}

          {/* Export */}
          <div className="rounded-card border border-edge bg-card p-6 shadow-soft">
            <h2 className="flex items-center gap-2 font-display text-xl font-bold">
              <Download className="size-5 text-accent" />
              Your data
            </h2>
            <p className="mt-1 text-sm text-ink-faint">
              Pauken is free and open source (AGPL-3.0). Your notes are yours —
              export any single note as Markdown, PDF, or Word from its menu, or
              export everything at once here.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={async () => {
                  const notes = (await repo?.listNotes()) ?? [];
                  if (notes.length === 0) {
                    setExportMsg("You don't have any notes yet.");
                    return;
                  }
                  const all = notes.map((n) => exportMarkdown(n)).join("\n\n---\n\n");
                  downloadText("pauken-notes.md", all, "text/markdown");
                  setExportMsg(`Exported ${notes.length} note${notes.length > 1 ? "s" : ""}.`);
                }}
                className="rounded-xl border border-edge bg-panel px-4 py-2 text-sm font-semibold shadow-soft hover:bg-card-hover"
              >
                Export all notes (Markdown)
              </button>
              {exportMsg && <span className="text-sm text-ink-faint">{exportMsg}</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  editable,
  copyable,
}: {
  label: string;
  value: string;
  editable?: boolean;
  copyable?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-edge bg-panel px-4 py-3">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-ink-faint">{label}</p>
        <p className="truncate text-sm font-semibold">{value}</p>
      </div>
      {editable && <Pencil className="size-3.5 shrink-0 text-ink-faint" />}
      {copyable && (
        <button
          onClick={() => navigator.clipboard.writeText(value)}
          className="rounded-lg border border-edge bg-card p-2 text-ink-dim shadow-soft hover:text-ink"
          aria-label={`Copy ${label}`}
        >
          <Copy className="size-3.5" />
        </button>
      )}
    </div>
  );
}
