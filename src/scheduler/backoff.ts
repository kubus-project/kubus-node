export class Backoff {
  private attempt = 0;

  constructor(
    private readonly baseMs = 1000,
    private readonly maxMs = 60000,
  ) {}

  success(): void {
    this.attempt = 0;
  }

  failure(): number {
    this.attempt += 1;
    const exponential = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(this.attempt - 1, 8));
    return Math.round(exponential * (0.75 + Math.random() * 0.5));
  }
}
