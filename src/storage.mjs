import fs from 'node:fs';
import path from 'node:path';
import {RUNTIME_DIR, runtimeConfig, modelConfig} from './config.mjs';

export const STATE_FILE = path.join(RUNTIME_DIR, 'state.json');
export const EVENTS_FILE = path.join(RUNTIME_DIR, 'events.ndjson');
export const OUTBOX_FILE = path.join(RUNTIME_DIR, 'outbox.ndjson');

export function ensureRuntime() {
  fs.mkdirSync(RUNTIME_DIR, {recursive: true});
}

export function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function appendNdjson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function createInitialState(now = Date.now()) {
  return {
    schemaVersion: 1,
    modelVersion: modelConfig.version,
    mode: runtimeConfig.mode,
    startedAt: now,
    updatedAt: now,
    equityUsdt: runtimeConfig.equityUsdt,
    realizedPnlUsdt: 0,
    positions: [],
    closedPositions: [],
    processedSignalIds: [],
    cooldowns: {},
    service: {
      status: 'starting',
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastMonitorAt: null,
      lastError: null,
      lastScanSummary: null,
    },
  };
}

export function loadState(now = Date.now()) {
  ensureRuntime();
  const state = readJson(STATE_FILE, null) || createInitialState(now);
  state.positions ||= [];
  state.closedPositions ||= [];
  state.processedSignalIds ||= [];
  state.cooldowns ||= {};
  state.service ||= {};
  return state;
}

export function saveState(state, now = Date.now()) {
  state.updatedAt = now;
  state.processedSignalIds = state.processedSignalIds.slice(-20_000);
  state.closedPositions = state.closedPositions.slice(-5_000);
  atomicWriteJson(STATE_FILE, state);
}
