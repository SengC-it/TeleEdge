import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {modelConfig, RUNTIME_DIR, runtimeConfig} from './config.mjs';
import {ensureRuntime, loadState} from './storage.mjs';
import {runMonitor, runScan} from './service.mjs';

ensureRuntime();
fs.writeFileSync(path.join(RUNTIME_DIR, 'service.pid'), `${process.pid}\n`);

let queue = Promise.resolve();
function exclusive(task) {
  queue = queue.then(task, task).catch(error => console.error(new Date().toISOString(), error));
  return queue;
}

function publicState() {
  const state = loadState();
  const grossNotional = state.positions.reduce((sum, position) => sum + position.notionalUsdt, 0);
  return {
    modelVersion: modelConfig.version,
    mode: state.mode,
    service: state.service,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    equityUsdt: state.equityUsdt,
    realizedPnlUsdt: state.realizedPnlUsdt,
    activePositions: state.positions.length,
    grossNotionalUsdt: grossNotional,
    grossLeverage: state.equityUsdt > 0 ? grossNotional / state.equityUsdt : null,
    positions: state.positions,
    recentClosedPositions: state.closedPositions.slice(-20),
  };
}

const server = http.createServer((request, response) => {
  const state = publicState();
  if (request.url === '/health') {
    const healthy = state.service.status === 'ready' || state.service.status === 'scanning';
    response.writeHead(healthy ? 200 : 503, {'content-type': 'application/json; charset=utf-8'});
    response.end(`${JSON.stringify({ok: healthy, modelVersion: state.modelVersion, mode: state.mode, service: state.service})}\n`);
    return;
  }
  if (request.url === '/status' || request.url === '/positions') {
    response.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
    response.end(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  response.writeHead(404, {'content-type': 'application/json; charset=utf-8'});
  response.end('{"error":"not found"}\n');
});

server.listen(runtimeConfig.httpPort, runtimeConfig.httpHost, () => {
  console.log(`TeleEdge V7.5 paper service listening on http://${runtimeConfig.httpHost}:${runtimeConfig.httpPort}`);
  exclusive(async () => {
    await runMonitor();
    await runScan();
  });
});

const monitorTimer = setInterval(() => exclusive(() => runMonitor()), runtimeConfig.monitorIntervalMs);
const scanTimer = setInterval(() => exclusive(() => runScan()), runtimeConfig.scanIntervalMs);
monitorTimer.unref();
scanTimer.unref();

function shutdown() {
  clearInterval(monitorTimer);
  clearInterval(scanTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
