// Request counting, so a run can report requests per written document.

export class RequestStats {
  /** Requests sent to Linear's API, including retries and OAuth token calls. */
  total = 0;
  /** Requests per operation name. */
  readonly byOperation = new Map<string, number>();
  /** Upload PUTs to file storage; these do not count against Linear's API budget. */
  storagePuts = 0;
  /** Writes the run tried after the client stopped; each was refused without a request. */
  writesAfterStop = 0;

  count(operation: string): void {
    this.total += 1;
    this.byOperation.set(operation, (this.byOperation.get(operation) ?? 0) + 1);
  }

  toJSON(): { total: number; storagePuts: number; writesAfterStop: number; byOperation: Record<string, number> } {
    return {
      total: this.total,
      storagePuts: this.storagePuts,
      writesAfterStop: this.writesAfterStop,
      byOperation: Object.fromEntries([...this.byOperation].sort(([a], [b]) => a.localeCompare(b))),
    };
  }
}
