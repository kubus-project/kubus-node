export interface AuthProvider {
  headers(): Record<string, string>;
}

export class BearerAuthProvider implements AuthProvider {
  constructor(private readonly token: string) {}

  headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }
}
