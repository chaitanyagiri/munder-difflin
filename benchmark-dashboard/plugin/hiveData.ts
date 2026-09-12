import fs from 'fs';
import path from 'path';
import type { Plugin, ViteDevServer } from 'vite';
import { IncomingMessage, ServerResponse } from 'http';

function parseJsonl(content: string) {
  return content.split('\n').filter(Boolean).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function hiveDataPlugin(): Plugin {
  return {
    name: 'hive-data',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        if (!req.url?.startsWith('/api/')) {
          return next();
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const apiPath = url.pathname.replace('/api/', '');
        const hiveRoot = url.searchParams.get('hiveRoot') || process.env.HIVE_ROOT || '/Users/saikiransangarthi/HarnessAgents/hive';

        let filename = '';
        let isJsonl = false;

        switch (apiPath) {
          case 'log': filename = 'log.jsonl'; isJsonl = true; break;
          case 'cost': filename = 'cost-ledger.jsonl'; isJsonl = true; break;
          case 'tasks': filename = 'tasks.json'; isJsonl = false; break;
          case 'registry': filename = 'registry.json'; isJsonl = false; break;
          case 'fleet': filename = 'fleet.json'; isJsonl = false; break;
          case 'results': filename = 'results.jsonl'; isJsonl = true; break;
          default:
            return next();
        }

        const filePath = path.join(hiveRoot, filename);
        try {
          if (!fs.existsSync(hiveRoot)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'invalid request' }));
            return;
          }
          const realHiveRoot = fs.realpathSync(hiveRoot);

          if (!fs.existsSync(filePath)) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'not found' }));
            return;
          }

          const realFilePath = fs.realpathSync(filePath);
          if (realFilePath !== path.join(realHiveRoot, filename)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'invalid request' }));
            return;
          }

          const content = await fs.promises.readFile(realFilePath, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          if (isJsonl) {
            res.end(JSON.stringify(parseJsonl(content)));
          } else {
            res.end(content);
          }
        } catch (e: any) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'internal error' }));
        }
      });
    }
  };
}
