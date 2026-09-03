interface Env {
  TERMINAL_TREE: DurableObjectNamespace;
  ENVIRONMENT: string;
  /** Shared secret gating tree creation, sandbox attach, and viewer write. */
  SANDBOX_TOKEN?: string;
}
