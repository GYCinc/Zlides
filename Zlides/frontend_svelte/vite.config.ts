import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { loadLacSkill } from './src/contracts/lacSkill';

export default defineConfig(() => {
  let apiKey = process.env.Z_AI_API_KEY || process.env.ZAI_API_KEY || '';
  const secretsPath = '/home/hayron/.secrets.env';
  if (!apiKey && fs.existsSync(secretsPath)) {
    try {
      const content = fs.readFileSync(secretsPath, 'utf8');
      const match = content.match(/(?:Z_AI_API_KEY|ZAI_API_KEY)=["']?([^"'\r\n]+)["']?/);
      if (match) apiKey = match[1];
    } catch (e) {
      console.warn('Could not read .secrets.env:', e);
    }
  }

  const savedSlidesPlugin = () => ({
    name: 'saved-slides-plugin',
    configureServer(server: any) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        // GET /saved -> list all saved slides from saved_slides directory
        if (url.pathname === '/saved' && req.method === 'GET') {
          try {
            const savedDir = path.resolve(__dirname, '../saved_slides');
            if (!fs.existsSync(savedDir)) fs.mkdirSync(savedDir, { recursive: true });

            const files = fs.readdirSync(savedDir);
            const items = [];
            for (const f of files) {
              if (!f.endsWith('.html')) continue;
              const fp = path.join(savedDir, f);
              try {
                const stats = fs.statSync(fp);
                let title = f.replace(/\.html$/, '');
                try {
                  const content = fs.readFileSync(fp, 'utf8');
                  const m = content.match(/<title>(.*?)<\/title>/i);
                  if (m && m[1].trim()) title = m[1].trim();
                } catch (e) {
                  console.warn('vault read failed:', e);
                }

                const d = new Date(stats.mtimeMs);
                items.push({
                  id: f,
                  filename: f,
                  title,
                  createdAt: stats.mtimeMs,
                  modified: stats.mtime.toISOString(),
                  dateStr: d.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                });
              } catch (e) {
                console.warn('vault read failed:', e);
              }
            }
            items.sort((a, b) => b.createdAt - a.createdAt);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(items));
            return;
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e) }));
            return;
          }
        }

        // GET /saved/:filename -> fetch individual slide HTML
        if (url.pathname.startsWith('/saved/') && req.method === 'GET') {
          const filename = decodeURIComponent(url.pathname.slice('/saved/'.length));
          const fp = path.resolve(__dirname, '../saved_slides', filename);
          if (fs.existsSync(fp)) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            fs.createReadStream(fp).pipe(res);
            return;
          }
        }

        // POST /save-slide -> save a newly generated slide to disk
        if (url.pathname === '/save-slide' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: any) => (body += chunk));
          req.on('end', () => {
            try {
              const data = JSON.parse(body || '{}');
              let html = data.html || '';
              const title = data.title || '';
              const decodeHtmlPayload = (raw: string): string => {
                if (!raw || !raw.includes('\\')) return raw;
                return raw.replace(/\\(?:(["\\\/bfnrt])|u([0-9a-fA-F]{4}))/g, (match, p1, p2) => {
                  if (p1) {
                    switch (p1) {
                      case '"': return '"';
                      case '\\': return '\\';
                      case '/': return '/';
                      case 'b': return '\b';
                      case 'f': return '\f';
                      case 'n': return '\n';
                      case 'r': return '\r';
                      case 't': return '\t';
                      default: return match;
                    }
                  }
                  if (p2) {
                    return String.fromCharCode(parseInt(p2, 16));
                  }
                  return match;
                });
              };
              const normalizeForSave = (raw: string): string => {
                const unescaped = decodeHtmlPayload(raw);
                const SEP = "<!-- zlides:page-break -->";
                const extractBody = (h: string) => {
                  const m = h.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
                  return m ? m[1].trim() : h.replace(/<!DOCTYPE[^>]*>/gi, "").replace(/<html[^>]*>/gi, "").replace(/<\/html>/gi, "").replace(/<head[\s\S]*?<\/head>/gi, "").trim();
                };
                const extractHead = (h: string) => {
                  const m = h.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
                  return m ? m[1].trim() : '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">';
                };
                const assemble = (pages: string[]): string => {
                  if (pages.length === 0) return unescaped;
                  const first = pages[0];
                  let headInner = extractHead(first);
                  const fix = `\n<style>\nhtml,body{background:#0f1112 !important;margin:0;padding:0;}\nbody{overflow:auto !important;height:auto !important;min-height:100vh;color:#e5e7eb;}\n.slide{width:100% !important;max-width:1280px !important;margin:0 auto !important;height:auto !important;min-height:0 !important;max-width:100%;}\n</style>`;
                  headInner += fix;
                  const bodies = pages.map(extractBody).join('\n<div class="zlides-page-separator" style="height:1px;background:#2e3236;margin:24px 0;"></div>\n');
                  return `<!DOCTYPE html>\n<html lang="en">\n<head>${headInner}\n</head>\n<body style="background:#0f1112;color:#e5e7eb;margin:0;padding:24px;max-width:100%;overflow:auto;">\n${bodies}\n</body>\n</html>`;
                };
                if (unescaped.includes(SEP)) {
                  const parts = unescaped.split(SEP).map((s: string) => s.trim()).filter(Boolean);
                  return assemble(parts);
                }
                const dc = (unescaped.match(/<!DOCTYPE/gi) || []).length;
                if (dc > 1) {
                  const parts = unescaped.split(/(?=<!DOCTYPE)/gi).map((s: string) => s.trim()).filter(Boolean);
                  if (parts.length > 1) return assemble(parts);
                }
                return unescaped;
              };
              html = decodeHtmlPayload(normalizeForSave(html));
              const savedDir = path.resolve(__dirname, '../saved_slides');
              if (!fs.existsSync(savedDir)) fs.mkdirSync(savedDir, { recursive: true });

              const now = new Date();
              const ts = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
              const clean = (title || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
              const filename = `slide_${ts}_${clean}.html`;
              const fp = path.join(savedDir, filename);

              fs.writeFileSync(fp, html, 'utf8');
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ status: 'ok', filename }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: String(e) }));
            }
          });
          return;
        }

        // GET /api/vig/transcript?video=<id> -> real YouTube transcript with cue timings
        if (url.pathname === '/api/vig/transcript' && req.method === 'GET') {
          const sendJson = (status: number, payload: any) => {
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(payload));
          };

          const videoId = url.searchParams.get('video') || '';
          if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
            sendJson(400, { error: 'invalid video id' });
            return;
          }

          const cacheDir = path.resolve(__dirname, '../.vig-cache');
          const cachePath = path.resolve(__dirname, '../.vig-cache', videoId + '.json');

          const serveCache = () => {
            try {
              const raw = fs.readFileSync(cachePath, 'utf8');
              JSON.parse(raw);
              res.setHeader('Content-Type', 'application/json');
              res.end(raw);
            } catch (e: any) {
              sendJson(502, { error: String(e && e.message ? e.message : e), stderr: '' });
            }
          };

          if (fs.existsSync(cachePath)) {
            serveCache();
            return;
          }

          try {
            fs.mkdirSync(cacheDir, { recursive: true });
          } catch (e: any) {
            sendJson(502, { error: String(e && e.message ? e.message : e), stderr: '' });
            return;
          }

          const fetcherPath = path.resolve(__dirname, 'vig/fetch-transcript.py');
          const args = [
            'run',
            '--isolated',
            '--with',
            'youtube-transcript-api',
            fetcherPath,
            '--video',
            videoId,
            '--out',
            cachePath,
          ];
          const runUv = (bin: string) =>
            new Promise<void>((resolve, reject) => {
              execFile(
                bin,
                args,
                { timeout: 180000, maxBuffer: 1024 * 1024 * 20 },
                (err: any, _stdout: any, stderr: any) => {
                  if (err) {
                    err.stderr = stderr;
                    reject(err);
                    return;
                  }
                  resolve();
                }
              );
            });

          try {
            try {
              await runUv('uv');
            } catch (e: any) {
              if (e && e.code === 'ENOENT') {
                await runUv('/home/hayron/.local/bin/uv');
              } else {
                throw e;
              }
            }
          } catch (e: any) {
            sendJson(502, {
              error: String(e && e.message ? e.message : e).slice(0, 2000),
              stderr: String(e && e.stderr ? e.stderr : '').trim().slice(0, 4096),
            });
            return;
          }

          serveCache();
          return;
        }

        // GET /api/vig/contract -> the model contract fenced between the markers in the
        // skill's SKILL.md. Read live on every request: the skill stays the single source
        // of truth, so the app can never send a stale copy of the rules.
        if (url.pathname === '/api/vig/contract' && req.method === 'GET') {
          const skillDir = process.env.VIG_SKILL_DIR || '/home/hayron/By Student/.opencode/commands/vig-generator';
          const skillPath = path.resolve(skillDir, 'SKILL.md');
          try {
            const raw = fs.readFileSync(skillPath, 'utf8');
            const marked = raw.match(/<!-- VIG-MODEL-CONTRACT:START -->([\s\S]*?)<!-- VIG-MODEL-CONTRACT:END -->/);
            if (!marked) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'contract markers missing in SKILL.md' }));
              return;
            }
            const contract = marked[1].replace(/<!--[\s\S]*?-->/g, '').trim();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              contract,
              chars: contract.length,
              sha256: createHash('sha256').update(contract).digest('hex'),
              source: skillPath,
            }));
            return;
          } catch (e: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
            return;
          }
        }

        // GET /api/lac/contract -> the LAC worksheet skill, read live on every request:
        // the rules the model sees, plus the chassis (styles, font links, engine) the app owns.
        if (url.pathname === '/api/lac/contract' && req.method === 'GET') {
          try {
            const skill = loadLacSkill();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              contract: skill.contract,
              chars: skill.contract.length,
              sha256: skill.sha256,
              source: skill.source,
              styles: skill.styles,
              links: skill.links,
              engine: skill.engine,
            }));
            return;
          } catch (e: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
            return;
          }
        }

        next();
      });
    },
  });

  return {
    plugins: [svelte(), tailwindcss(), savedSlidesPlugin()],
    define: {
      'import.meta.env.VITE_DEFAULT_API_KEY': JSON.stringify(apiKey),
    },
    server: {
      port: 2727,
      host: '0.0.0.0',
      strictPort: true,
    },
    preview: {
      port: 2727,
      host: '0.0.0.0',
      strictPort: true,
    },
    build: {
      outDir: '../public',
      emptyOutDir: true,
    },
    resolve: {
      alias: {
        $lib: path.resolve(__dirname, './src/lib'),
        $contracts: path.resolve(__dirname, './src/contracts'),
      },
    },
  };
});
