export interface ActionLockSnapshot {
  busy: boolean;
  currentAction: string | null;
  startedAt: string | null;
}

export class ActionLock {
  private currentAction: string | null = null;
  private startedAt: string | null = null;

  snapshot(): ActionLockSnapshot {
    return {
      busy: this.currentAction !== null,
      currentAction: this.currentAction,
      startedAt: this.startedAt,
    };
  }

  async run<T>(label: string, task: () => Promise<T>): Promise<T> {
    if (this.currentAction) {
      const error = new Error(`Action already running: ${this.currentAction}`);
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }
    this.currentAction = label;
    this.startedAt = new Date().toISOString();
    try {
      return await task();
    } finally {
      this.currentAction = null;
      this.startedAt = null;
    }
  }
}
