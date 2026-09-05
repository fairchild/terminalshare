interface Env {
  TERMINAL_TREE: DurableObjectNamespace;
  ENVIRONMENT: string;
  /** Shared secret gating tree creation, sandbox attach, and viewer write. */
  SANDBOX_TOKEN?: string;
  /**
   * Comma-separated CORS origin allowlist. Overrides the per-environment
   * default in `src/cors.ts` when set; needed for any environment whose
   * hostname is not known at build time.
   */
  ALLOWED_ORIGINS?: string;
}
