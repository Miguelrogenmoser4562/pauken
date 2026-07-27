export type Theme = "light" | "dark";

const KEY = "pauken.theme";

export function getTheme(): Theme {
  const stored = localStorage.getItem(KEY);
  if (stored === "dark") return "dark";
  if (stored === "light") return "light";
  return "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(KEY, theme);
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
