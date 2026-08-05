import { appendFileSync } from 'node:fs';

export function runtimeTrace(
  scope: string,
  event: string,
  data: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): void {
  const target = env.AIDEN_RUNTIME_TRACE_FILE
    ?? (env.AIDEN_P2A_DIAG === '1' ? env.AIDEN_P2A_DIAG_FILE : undefined);
  if (!target) return;
  try {
    appendFileSync(target, `${JSON.stringify({
      monoMs: Number(process.hrtime.bigint() / 1_000_000n),
      scope,
      event,
      ...data,
    })}\n`, 'utf8');
  } catch {
    // Diagnostics cannot affect runtime execution.
  }
}
