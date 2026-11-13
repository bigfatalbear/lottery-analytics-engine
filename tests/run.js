#!/usr/bin/env node
/**
 * Runner de testes sem dependencias externas.
 * Executa as suites obrigatorias + testes de integridade (modulos e datasets).
 *
 * Uso: node tests/run.js [--verbose]
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tests as validatorTests } from './validator.test.js';
import { tests as statisticsTests } from './statistics.test.js';
import { tests as scoringTests } from './scoring.test.js';
import { tests as bitmaskTests } from './bitmask.test.js';
import { tests as combinationTests } from './combination.test.js';
import { tests as backtestTests } from './backtest.test.js';
import { GAME_IDS, getProfile } from '../src/js/game-profiles.js';
import { validateDataset } from '../src/js/validator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

const suites = [
  { name: 'validator', tests: validatorTests },
  { name: 'statistics', tests: statisticsTests },
  { name: 'scoring', tests: scoringTests },
  { name: 'bitmask', tests: bitmaskTests },
  { name: 'combination', tests: combinationTests },
  { name: 'backtest', tests: backtestTests },
];

const MODULES = [
  'app.js',
  'accessibility.js',
  'backtest-engine.js',
  'bitmask.js',
  'charts.js',
  'combination-engine.js',
  'config.js',
  'data-loader.js',
  'db.js',
  'export.js',
  'formatter.js',
  'game-profiles.js',
  'logger.js',
  'monte-carlo.js',
  'notifications.js',
  'scoring-engine.js',
  'state.js',
  'statistics.js',
  'ui.js',
  'validator.js',
  'worker-client.js',
];

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  bold: '\u001b[1m',
};

let passed = 0;
let failed = 0;
const failures = [];

async function runTest(suite, test) {
  const started = performance.now();
  try {
    await test.fn();
    passed += 1;
    const ms = performance.now() - started;
    if (verbose) console.log(`  ${C.green}✓${C.reset} ${test.name} ${C.dim}(${ms.toFixed(1)}ms)${C.reset}`);
  } catch (error) {
    failed += 1;
    failures.push({ suite, name: test.name, error });
    console.log(`  ${C.red}✗ ${test.name}${C.reset}`);
    console.log(`    ${C.dim}${error?.message ?? error}${C.reset}`);
    if (verbose && error?.stack) console.log(`    ${C.dim}${error.stack.split('\n').slice(1, 4).join('\n    ')}${C.reset}`);
  }
}

async function integrityTests() {
  const moduleResults = [];
  for (const file of MODULES) {
    try {
      await import(new URL(`../src/js/${file}`, import.meta.url).href);
      moduleResults.push({ file, ok: true });
    } catch (error) {
      moduleResults.push({ file, ok: false, error });
    }
  }
  moduleResults.push({
    file: 'workers/worker.js',
    ok: await import(new URL('../src/workers/worker.js', import.meta.url).href)
      .then(() => true)
      .catch((error) => {
        console.log(error);
        return false;
      }),
  });

  return {
    name: 'integridade dos modulos',
    fn() {
      const broken = moduleResults.filter((item) => !item.ok);
      if (broken.length > 0) {
        throw new Error(`modulos com falha: ${broken.map((item) => `${item.file} (${item.error?.message})`).join('; ')}`);
      }
    },
    detail: `${moduleResults.length} modulos carregados`,
  };
}

async function datasetTests() {
  const results = [];
  for (const gameId of GAME_IDS) {
    const profile = getProfile(gameId);
    const file = path.join(ROOT, profile.datasetFile);
    try {
      const dataset = JSON.parse(await readFile(file, 'utf8'));
      const check = validateDataset(dataset, profile);
      results.push({ gameId, ok: check.valid, statistics: check.statistics, errors: check.errors });
    } catch (error) {
      results.push({ gameId, ok: false, errors: [error.message] });
    }
  }

  return {
    name: 'integridade dos datasets',
    fn() {
      const broken = results.filter((item) => !item.ok);
      if (broken.length > 0) {
        throw new Error(broken.map((item) => `${item.gameId}: ${item.errors.join('; ')}`).join(' | '));
      }
      for (const item of results) {
        if (item.statistics.validDraws < 100) {
          throw new Error(`${item.gameId} tem apenas ${item.statistics.validDraws} concursos`);
        }
        if (item.statistics.firstContest !== 1) {
          throw new Error(`${item.gameId} nao comeca no concurso 1`);
        }
      }
    },
    detail: results.map((item) => `${item.gameId}=${item.statistics?.validDraws}`).join(' '),
  };
}

async function main() {
  console.log(`${C.bold}LOTTERY ANALYTICS ENGINE — testes${C.reset}\n`);

  for (const suite of suites) {
    console.log(`${C.cyan}${suite.name}${C.reset} ${C.dim}(${suite.tests.length} testes)${C.reset}`);
    for (const test of suite.tests) await runTest(suite.name, test);
  }

  console.log(`\n${C.cyan}integridade${C.reset}`);
  for (const test of [await integrityTests(), await datasetTests()]) {
    await runTest('integridade', test);
    if (verbose && test.detail) console.log(`    ${C.dim}${test.detail}${C.reset}`);
  }

  const total = passed + failed;
  console.log(`\n${C.bold}Resultado:${C.reset} ${C.green}${passed} ok${C.reset} · ${failed > 0 ? C.red : C.dim}${failed} falha(s)${C.reset} · ${total} total`);

  if (failed > 0) {
    console.log(`\n${C.red}Falhas:${C.reset}`);
    for (const failure of failures) {
      console.log(`  - [${failure.suite}] ${failure.name}: ${failure.error?.message ?? failure.error}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('falha fatal no runner de testes', error);
  process.exitCode = 1;
});
