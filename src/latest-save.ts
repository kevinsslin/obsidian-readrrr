/** Coalesce writes that arrive during an active save into the latest snapshot. */
export class LatestSave<T> {
  private readonly save: (value: T) => Promise<void>;
  private pending: T | undefined;
  private active: Promise<void> | null = null;

  constructor(save: (value: T) => Promise<void>) {
    this.save = save;
  }

  enqueue(value: T): Promise<void> {
    this.pending = value;
    if (!this.active) this.active = this.flush();
    return this.active;
  }

  private async flush(): Promise<void> {
    try {
      while (this.pending !== undefined) {
        const value = this.pending;
        this.pending = undefined;
        await this.save(value);
      }
    } finally {
      this.active = null;
    }
  }
}
