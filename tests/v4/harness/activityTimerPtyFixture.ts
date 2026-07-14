import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

const display = new Display({
  skin: new SkinEngine({ forceMono: true }),
  stdout: process.stdout,
});

const row = display.toolRow('terminal', {
  command: 'Start-Sleep -Seconds 5; Write-Output repeated-handoff-activity-frame',
});

setTimeout(() => {
  row.ok(4_250);
  process.stdout.write('__ACTIVITY_SETTLED__\n');
  setTimeout(() => process.exit(0), 1_250);
}, 4_250);
