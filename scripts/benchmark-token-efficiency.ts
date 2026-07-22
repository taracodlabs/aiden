import { runTokenEfficiencyBenchmark } from '../core/v4/tokenEfficiencyBenchmark';

async function main(): Promise<void> {
  const rows = await runTokenEfficiencyBenchmark();
  process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
