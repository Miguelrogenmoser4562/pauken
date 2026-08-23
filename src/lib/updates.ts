export const UPDATE_REPO = "Miguelrogenmoser4562/pauken";
export const UPDATE_LATEST_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

export interface UpdateInfo {
  current: string;
  latest: string | null;
  latestUrl: string | null;
  assetUrl: string | null;
  isUpdate: boolean;
  error?: string;
}

/* Numeric dot-segment comparison; a leading "v" and any prerelease suffix
   ("-beta.1") are ignored. Missing segments count as 0. */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((seg) => parseInt(seg, 10) || 0);
  const pa = nums(a);
  const pb = nums(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export function isNewer(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0;
}

function platformAssetExt(): string {
  if (typeof navigator === "undefined") return ".AppImage";
  const p = navigator.platform;
  if (p.startsWith("Mac")) return ".dmg";
  if (p.startsWith("Win")) return ".exe";
  return ".AppImage";
}

function pickPlatformAsset(
  assets: Array<{ name?: string; browser_download_url?: string }>,
) {
  const ext = platformAssetExt().toLowerCase();
  return assets.find((a) => a.name?.toLowerCase().endsWith(ext));
}

export async function checkForUpdates(
  current: string = __APP_VERSION__,
): Promise<UpdateInfo> {
  const base: UpdateInfo = {
    current,
    latest: null,
    latestUrl: null,
    assetUrl: null,
    isUpdate: false,
  };
  try {
    const res = await fetch(UPDATE_LATEST_URL, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return { ...base, error: `GitHub responded ${res.status}.` };
    }
    const release = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      assets?: Array<{ name?: string; browser_download_url?: string }>;
    };
    const latest = (release.tag_name ?? "").replace(/^v/i, "");
    if (!latest) return { ...base, error: "No releases found." };
    const asset = pickPlatformAsset(release.assets ?? []);
    return {
      current,
      latest,
      latestUrl: release.html_url ?? `https://github.com/${UPDATE_REPO}/releases`,
      assetUrl: asset?.browser_download_url ?? null,
      isUpdate: isNewer(current, latest),
    };
  } catch (err) {
    return { ...base, error: String(err) };
  }
}
