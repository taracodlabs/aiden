import {
  ProviderPhaseTimeoutError,
  type ProviderTimeoutPhase,
} from './errors';

export interface RequestDeadlines {
  connectionMs: number;
  firstByteMs: number;
  bodyIdleMs: number;
  totalMs: number;
}

export function requestDeadlines(totalMs: number, overrides: Partial<RequestDeadlines> = {}): RequestDeadlines {
  return {
    connectionMs: overrides.connectionMs ?? totalMs,
    firstByteMs: overrides.firstByteMs ?? totalMs,
    bodyIdleMs: overrides.bodyIdleMs ?? totalMs,
    totalMs: overrides.totalMs ?? totalMs,
  };
}

function abortError(error?: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') return error;
  const result = new Error('Provider request cancelled by caller');
  result.name = 'AbortError';
  (result as Error & { cause?: unknown }).cause = error;
  return result;
}

export class RequestLifecycle {
  readonly controller = new AbortController();
  private phase: ProviderTimeoutPhase | 'external' | null = null;
  private phaseTimeoutMs = 0;
  private settled = false;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private externalHandler: (() => void) | null = null;
  private rejectAbort!: (error: unknown) => void;
  private readonly abortPromise: Promise<never>;
  private sawBodyByte = false;

  constructor(
    private readonly provider: string,
    private readonly deadlines: RequestDeadlines,
    private readonly externalSignal?: AbortSignal,
  ) {
    this.abortPromise = new Promise<never>((_resolve, reject) => { this.rejectAbort = reject; });
    this.totalTimer = setTimeout(() => this.abortFor('total_timeout', deadlines.totalMs), deadlines.totalMs);
    this.armPhase('connection_timeout', deadlines.connectionMs);
    if (externalSignal) {
      if (externalSignal.aborted) this.abortFor('external', 0);
      else {
        this.externalHandler = () => this.abortFor('external', 0);
        externalSignal.addEventListener('abort', this.externalHandler, { once: true });
      }
    }
  }

  get signal(): AbortSignal { return this.controller.signal; }

  markHeaders(): void {
    if (this.settled) return;
    this.armPhase('first_byte_timeout', this.deadlines.firstByteMs);
  }

  async race<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.abortPromise]);
  }

  async readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<{ done: boolean; value?: Uint8Array }> {
    const result = await this.race(reader.read());
    if (!result.done && result.value && result.value.byteLength > 0) {
      this.sawBodyByte = true;
      this.armPhase('body_idle_timeout', this.deadlines.bodyIdleMs);
    } else if (result.done) {
      this.clearPhaseTimer();
    } else if (this.sawBodyByte) {
      this.armPhase('body_idle_timeout', this.deadlines.bodyIdleMs);
    }
    return result;
  }

  async readText(response: Response): Promise<string> {
    if (!response.body) {
      this.clearPhaseTimer();
      return '';
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (true) {
        const chunk = await this.readChunk(reader);
        if (chunk.done) break;
        if (chunk.value) text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  classify(error: unknown): unknown {
    if (this.phase === 'external' || this.externalSignal?.aborted) return abortError(error);
    if (this.phase) {
      return new ProviderPhaseTimeoutError(this.provider, this.phaseTimeoutMs, this.phase);
    }
    return error;
  }

  cleanup(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.totalTimer) clearTimeout(this.totalTimer);
    this.totalTimer = null;
    this.clearPhaseTimer();
    if (this.externalHandler && this.externalSignal) {
      this.externalSignal.removeEventListener('abort', this.externalHandler);
    }
    this.externalHandler = null;
  }

  private armPhase(phase: ProviderTimeoutPhase, timeoutMs: number): void {
    this.clearPhaseTimer();
    this.phaseTimer = setTimeout(() => this.abortFor(phase, timeoutMs), timeoutMs);
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
  }

  private abortFor(phase: ProviderTimeoutPhase | 'external', timeoutMs: number): void {
    if (this.settled || this.phase !== null) return;
    this.phase = phase;
    this.phaseTimeoutMs = timeoutMs;
    this.controller.abort();
    this.rejectAbort(
      phase === 'external'
        ? abortError()
        : new ProviderPhaseTimeoutError(this.provider, timeoutMs, phase),
    );
  }
}
