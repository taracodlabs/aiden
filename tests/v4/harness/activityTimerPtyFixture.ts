import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { ActivityRegistry } from '../../../cli/v4/activityRegistry';

const display = new Display({
  skin: new SkinEngine({ forceMono: true }),
  stdout: process.stdout,
});

const registry = new ActivityRegistry(
  (name, args, read) => display.toolRow(name, args, read, { externalTicker: true }),
);
registry.observe('resize-tool', { phase: 'running', at: Date.now() });
registry.start('resize-tool', 'terminal', {
  command: 'Start-Sleep -Seconds 5; Write-Output repeated-handoff-activity-frame',
});

setTimeout(() => {
  registry.settle('resize-tool', { state: 'completed' });
  process.stdout.write('__ACTIVITY_SETTLED__\n');
  setTimeout(() => process.exit(0), 1_250);
}, 4_250);
