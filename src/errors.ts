export class BrightspaceError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = 'BrightspaceError';
  }
}

export function safeError(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof BrightspaceError) return { code: error.code, message: error.message, details: error.details };
  // Network/library errors can include URLs, cookies or response bodies. Do not forward them to the model.
  return { code: 'INTERNAL_ERROR', message: 'The operation failed. Run the doctor command to check connectivity and authentication.' };
}
