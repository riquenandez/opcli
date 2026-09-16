export function levenshtein(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const matrix: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0))
  for (let i = 0; i < rows; i++) {
    const row = matrix[i]
    if (row) row[0] = i
  }
  const first = matrix[0]
  if (first) {
    for (let j = 0; j < cols; j++) first[j] = j
  }
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const row = matrix[i]
      const prev = matrix[i - 1]
      if (!row || !prev) continue
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
    }
  }
  return matrix[a.length]?.[b.length] ?? Math.max(a.length, b.length)
}

export function suggest(got: string, allowed: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDist = 3
  for (const candidate of allowed) {
    const dist = levenshtein(got, candidate)
    if (dist < bestDist) {
      best = candidate
      bestDist = dist
    }
  }
  return best
}
