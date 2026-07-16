import {loadState} from './storage.mjs';
import {runMonitor, runScan} from './service.mjs';

const command = process.argv[2] || 'status';
if (command === 'scan') console.log(JSON.stringify(await runScan(), null, 2));
else if (command === 'monitor') console.log(JSON.stringify(await runMonitor(), null, 2));
else if (command === 'status') console.log(JSON.stringify(loadState(), null, 2));
else {
  console.error('Usage: node src/cli.mjs <scan|monitor|status>');
  process.exitCode = 2;
}
