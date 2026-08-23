export function normalizeTopic(s: string): string {
  return s.trim().toLowerCase();
}

export function deduplicateTopics(topics: string[]): string[] {
  const seen = new Map<string, string>();
  for (const t of topics) {
    if (!t) continue;
    const key = normalizeTopic(t);
    if (!seen.has(key)) {
      seen.set(key, t);
    }
  }
  return [...seen.values()].sort();
}
