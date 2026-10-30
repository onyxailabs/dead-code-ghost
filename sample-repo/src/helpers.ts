// Exported, so outside code may use it — review candidate, not confirmed dead.
export function formatDate(d: string): string {
  return d;
}

// Never called anywhere in this sample repo.
function deadTsHelper(x: number): number {
  return x + 1;
}
