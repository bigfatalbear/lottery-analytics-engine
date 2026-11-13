#!/usr/bin/env node
/**
 * Servidor estatico local para desenvolvimento e verificacao manual.
 * Simula o GitHub Pages: serve a raiz do repositorio com os MIME corretos.
 *
 * Uso: node scripts/serve.mjs [porta]
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number.parseInt(process.argv[2] ?? process.env.PORT ?? '8788', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    let filePath = path.join(ROOT, decodeURIComponent(url.pathname));

    if (!filePath.startsWith(ROOT)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (url.pathname.endsWith('/')) filePath = path.join(filePath, 'index.html');

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      fileStat = null;
    }

    // Fallback de SPA: rotas desconhecidas devolvem index.html
    if (!fileStat || !fileStat.isFile()) {
      const index = path.join(ROOT, 'index.html');
      response.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      createReadStream(index).pipe(response);
      return;
    }

    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': fileStat.size,
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/',
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Erro: ${error.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Servindo ${ROOT}`);
  console.log(`http://127.0.0.1:${PORT}`);
});
