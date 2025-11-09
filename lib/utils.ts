export function calculatePercent(loaded: number, total: number): number {
  return total > 0 ? (loaded / total) * 100 : 0;
}

export function isOnline(): boolean {
  return window.navigator.onLine;
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
