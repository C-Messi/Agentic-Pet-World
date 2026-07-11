export type ProviderMessageRole = 'user' | 'assistant';

export interface ProviderMessage {
  readonly role: ProviderMessageRole;
  readonly content: string;
}

export interface UntrustedProviderContext {
  readonly source: 'memories' | 'messages' | 'turn-state';
  readonly content: string;
}

export interface ProviderCompletionRequest {
  readonly trustedInstructions: readonly string[];
  readonly untrustedContext: readonly UntrustedProviderContext[];
  readonly messages: readonly ProviderMessage[];
  readonly signal: AbortSignal;
  readonly correlationId: string;
}

export interface ProviderAdapter {
  complete(request: ProviderCompletionRequest): Promise<unknown>;
}

export type ProviderErrorCode =
  | 'cancelled'
  | 'configuration'
  | 'invalid_output'
  | 'rate_limited'
  | 'request_failed'
  | 'server_error'
  | 'timeout';

export class ProviderError extends Error {
  public readonly code: ProviderErrorCode;
  public readonly status?: number;
  public readonly correlationId?: string;

  public constructor(
    code: ProviderErrorCode,
    options: { readonly status?: number; readonly correlationId?: string } = {},
  ) {
    super(providerErrorMessage(code));
    this.name = 'ProviderError';
    this.code = code;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.correlationId !== undefined) {
      this.correlationId = options.correlationId;
    }
  }

  public get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'server_error';
  }

  public toJSON(): Readonly<Record<string, string | number | undefined>> {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      correlationId: this.correlationId,
    };
  }
}

function providerErrorMessage(code: ProviderErrorCode): string {
  switch (code) {
    case 'cancelled':
      return 'Provider request was cancelled';
    case 'configuration':
      return 'Provider is not configured';
    case 'invalid_output':
      return 'Provider returned invalid structured output';
    case 'rate_limited':
      return 'Provider rate limit exceeded';
    case 'server_error':
      return 'Provider server error';
    case 'timeout':
      return 'Provider request timed out';
    case 'request_failed':
      return 'Provider request failed';
  }
}
