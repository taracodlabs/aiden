import { runModelPicker } from '../../../cli/v4/commands/modelPicker';
import { CredentialResolver } from '../../../providers/v4/credentialResolver';
import { RuntimeResolver } from '../../../providers/v4/runtimeResolver';

const installed = [
  'gemma4:e4b-32k',
  'gemma4:e4b-16k',
  'gemma4:e4b-8k',
  'gemma4:e4b',
];

async function main(): Promise<void> {
  const fetchImpl = (async () => new Response(JSON.stringify({
    models: installed.map((name) => ({ name })),
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const resolver = new RuntimeResolver(new CredentialResolver(), { fetchImpl });
  const result = await runModelPicker({ resolver, tier: 'local', fetchImpl });
  process.stdout.write(`\n[OLLAMA_PICKER_RESULT]${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
