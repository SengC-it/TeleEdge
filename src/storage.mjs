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
    v8Shadow: {
      schemaVersion: 1,
      modelVersion: 'V8-shadow-research-20260819',
      mode: 'paper-shadow',
      startedAt: now,
      updatedAt: now,
      equityUsdt: runtimeConfig.equityUsdt,
      peakEquityUsdt: runtimeConfig.equityUsdt,
      realizedPnlUsdt: 0,
      positions: [],
      closedPositions: [],
      processedSignalIds: [],
      lastScanSummary: null,
      lastMonitorSummary: null,
    },
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
  for (const position of [...state.positions, ...state.closedPositions]) {
    position.signalPrice ??= position.entry;
    position.decisionTime ??= position.openedAt ?? position.signalTime;
    position.fillTime ??= position.openedAt ?? position.signalTime;
    position.fillPrice ??= position.entry;
    position.lastFundingTime ??= position.fillTime;
    position.lastCheckedAt ??= position.fillTime;
  }
  state.processedSignalIds ||= [];
  state.cooldowns ||= {};
  state.v8Shadow ||= createInitialState(now).v8Shadow;
  state.v8Shadow.positions ||= [];
  state.v8Shadow.closedPositions ||= [];
  state.v8Shadow.peakEquityUsdt ||= state.v8Shadow.equityUsdt;
  state.v8Shadow.processedSignalIds ||= [];
  state.service ||= {};
  return state;
}

export function saveState(state, now = Date.now()) {
  state.updatedAt = now;
  state.processedSignalIds = state.processedSignalIds.slice(-20_000);
  state.closedPositions = state.closedPositions.slice(-5_000);
  state.v8Shadow.processedSignalIds = state.v8Shadow.processedSignalIds.slice(-20_000);
  state.v8Shadow.closedPositions = state.v8Shadow.closedPositions.slice(-5_000);
  state.v8Shadow.updatedAt = now;
  atomicWriteJson(STATE_FILE, state);
}
