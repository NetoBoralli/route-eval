// Parse "$1,234.56" / "USD 12.34" / "12.34" → 1234 (cents). Throws if no number found.
export function parseMoneyCents(input: string): number {
  const match = input.replace(/[,\s]/g, '').match(/(-?\d+(?:\.\d{1,2})?)/);
  if (!match) throw new Error(`Could not parse money from: ${JSON.stringify(input)}`);
  const dollars = Number(match[1]);
  return Math.round(dollars * 100);
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

export function withinTolerance(a: number, b: number, toleranceCents = 2): boolean {
  return Math.abs(a - b) <= toleranceCents;
}
