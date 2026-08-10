import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, PenLine, Server, ToggleLeft, ToggleRight } from "lucide-react";
import { useApp } from "../lib/app";
import { serverHealth, verifyKey } from "../lib/api";
import { getEnginePrefs } from "../lib/prefs";

const DEFAULT_SERVER = "https://pauken.memorax.us";

export default function Onboarding() {
  const navigate = useNavigate();
  const { savePrefs, reconnect } = useApp();
  const [useDefault, setUseDefault] = useState(true);
  const [customUrl, setCustomUrl] = useState("");
  const [userKey, setUserKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverStatus, setServerStatus] = useState<"" | "ok" | "err">("");
  const [errMsg, setErrMsg] = useState("");

  const serverUrl = useDefault ? DEFAULT_SERVER : customUrl.trim();

  async function checkServer() {
    if (!serverUrl) return;
    setBusy(true);
    const ok = await serverHealth(serverUrl);
    setServerStatus(ok ? "ok" : "err");
    setBusy(false);
  }

  async function finish() {
    if (!serverUrl || !userKey.trim() || busy) return;
    setBusy(true);
    setErrMsg("");

    const user = await verifyKey(serverUrl, userKey.trim());
    if (!user) {
      setBusy(false);
      setErrMsg("Invalid user key — check with your server admin.");
      return;
    }
    const p = {
      ...getEnginePrefs(),
      mode: "cloud" as const,
      onboarded: true,
      serverUrl,
      userKey: userKey.trim(),
    };

    savePrefs(p);
    await reconnect(serverUrl, userKey.trim());
    navigate("/", { replace: true });
  }

  return (
    <div className="flex h-full flex-col items-center justify-center bg-bg px-6">
      <div className="flex items-center gap-2">
        <PenLine className="size-7 text-accent" />
        <span className="font-display text-2xl font-bold tracking-tight">pauken</span>
      </div>
      <h1 className="mt-6 text-center font-display text-4xl font-bold">
        Welcome
      </h1>
      <p className="mt-2 max-w-lg text-center text-ink-dim">
        Connect to a Pauken server to get started. You'll need a user key
        provided by your server admin.
      </p>

      {/* Server connection */}
      <div className="mt-8 w-full max-w-3xl space-y-3">
        <div className="flex items-center gap-2 rounded-xl border border-edge bg-card px-4 py-3 shadow-soft">
          <Server className="size-4 shrink-0 text-ink-faint" />
          <input
            value={useDefault ? "memorax (pauken.memorax.us)" : serverUrl}
            onChange={(e) => {
              if (!useDefault) {
                setCustomUrl(e.target.value);
                setServerStatus("");
              }
            }}
            onBlur={useDefault ? checkServer : undefined}
            readOnly={useDefault}
            placeholder="Server URL"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint read-only:text-ink-dim read-only:cursor-default"
          />
          <button
            onClick={() => {
              setUseDefault(!useDefault);
              setServerStatus("");
              if (!useDefault) setCustomUrl("");
            }}
            className="flex items-center gap-1 shrink-0 text-xs font-semibold text-ink-faint hover:text-ink"
            title={useDefault ? "Use a different server" : "Use the default memorax server"}
          >
            {useDefault ? <ToggleLeft className="size-4" /> : <ToggleRight className="size-4 text-accent" />}
            {useDefault ? "Default" : "Custom"}
          </button>
          {serverStatus === "ok" && <span className="shrink-0 text-xs font-bold text-green-600">Connected</span>}
          {serverStatus === "err" && <span className="shrink-0 text-xs font-bold text-red-500">Unreachable</span>}
        </div>

        <div className="flex items-center gap-2 rounded-xl border border-edge bg-card px-4 py-3 shadow-soft">
          <KeyRound className="size-4 shrink-0 text-ink-faint" />
          <input
            type="password"
            value={userKey}
            onChange={(e) => setUserKey(e.target.value)}
            onBlur={checkServer}
            placeholder="Your Pauken user key"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
          />
        </div>
      </div>

      {errMsg && (
        <p className="mt-4 text-sm font-semibold text-danger-ink">{errMsg}</p>
      )}

      <button
        onClick={finish}
        disabled={!serverUrl || !userKey.trim() || busy}
        className={`mt-4 w-full max-w-3xl rounded-xl py-3.5 font-display font-bold transition ${
          serverUrl && userKey.trim() && !busy
            ? "bg-accent text-white hover:bg-accent-hover"
            : "cursor-not-allowed bg-accent-softer text-ink-faint"
        }`}
      >
        {busy ? "Connecting…" : "Connect to Pauken"}
      </button>
    </div>
  );
}
