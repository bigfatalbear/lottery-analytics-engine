#!/usr/bin/env node
/**
 * Valida os datasets versionados. Usado pelo CI e localmente.
 * Sai com codigo 1 se algum dataset for invalido.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GAME_IDS, getProfile } from '../src/js/game-profiles.js';
import { validateDataset } from '../src/js/validator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

for (const gameId of GAME_IDS) {
  const profile = getProfile(gameId);
  const file = path.join(ROOT, profile.datasetFile);
  let dataset;
  try {
    dataset = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    console.error(`[erro] ${gameId}: nao foi possivel ler ${profile.datasetFile}: ${error.message}`);
    failures += 1;
    continue;
  }

  const check = validateDataset(dataset, profile, { strict: false });
  const stats = check.statistics;
  const status = check.valid ? 'OK' : 'FALHA';
  console.log(
    `[${status}] ${gameId}: ${stats.validDraws} concursos validos, ${stats.invalidDraws} invalidos, ` +
      `intervalo ${stats.firstContest}-${stats.lastContest} (${stats.firstDate} a ${stats.lastDate}), ` +
      `${stats.gaps} lacuna(s), hash ${String(dataset.hash).slice(0, 12)}...`,
  );

  if (check.errors.length > 0) {
    for (const error of check.errors) console.error(`  erro: ${error}`);
  }
  if (check.warnings.length > 0) {
    for (const warning of check.warnings.slice(0, 10)) console.warn(`  aviso: ${warning}`);
  }
  if (!check.valid) failures += 1;
  if (stats.validDraws === 0) failures += 1;

  if (dataset.lastContest !== stats.lastContest) {
    console.warn(`  aviso: lastContest (${dataset.lastContest}) difere do ultimo concurso (${stats.lastContest})`);
  }
  if (dataset.drawCount !== undefined && dataset.drawCount !== stats.validDraws) {
    console.warn(`  aviso: drawCount (${dataset.drawCount}) difere da quantidade validada (${stats.validDraws})`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} dataset(s) com problema.`);
  process.exitCode = 1;
} else {
  console.log('\nTodos os datasets estao validos.');
}
