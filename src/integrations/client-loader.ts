/**
 * Astro integration: Client Loader
 *
 * Scans for TypeScript browser-side source files in:
 *   - src/client/*.ts          → compiled to public/js/
 *   - src/plugins/<id>/client/*.ts → compiled to public/plugin-assets/<id>/
 *
 * Uses esbuild to compile TypeScript to IIFE JavaScript, then copies
 * the output into public/ so Astro serves it as static files.
 *
 * Pattern matches theme-loader.ts: discover at build time, copy to public/,
 * no runtime overhead beyond <script src="...">.
 */
import type { AstroIntegration } from 'astro';
import { existsSync, readdirSync, mkdirSync, writeFileSync, statSync, cpSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

interface ClientSource {
  sourcePath: string;
  outDir: string;
  /** URL path the browser will use, e.g. /js/typecho-editor.js */
  publicUrl: string;
}

/**
 * Discover core client sources under src/client/.
 */
function discoverCoreClients(rootDir: string): ClientSource[] {
  const srcDir = join(rootDir, 'src', 'client');
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) return [];

  const entries = readdirSync(srcDir);
  const sources: ClientSource[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;
    const sourcePath = join(srcDir, entry);
    const jsName = entry.replace(/\.ts$/, '.js');
    sources.push({
      sourcePath,
      outDir: join(rootDir, 'public', 'js'),
      publicUrl: `/js/${jsName}`,
    });
  }
  return sources;
}

/**
 * Discover plugin client sources (src/plugins/<name>/client/*.ts).
 */
function discoverPluginClients(rootDir: string): ClientSource[] {
  const pluginsDir = join(rootDir, 'src', 'plugins');
  if (!existsSync(pluginsDir) || !statSync(pluginsDir).isDirectory()) return [];

  const sources: ClientSource[] = [];
  const pluginDirs = readdirSync(pluginsDir).filter(d => {
    if (d.startsWith('.')) return false;
    return statSync(join(pluginsDir, d)).isDirectory();
  });

  for (const pluginId of pluginDirs) {
    const clientDir = join(pluginsDir, pluginId, 'client');
    if (!existsSync(clientDir) || !statSync(clientDir).isDirectory()) continue;

    const entries = readdirSync(clientDir);
    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue;
      const sourcePath = join(clientDir, entry);
      const jsName = entry.replace(/\.ts$/, '.js');
      const outDir = join(rootDir, 'public', 'plugin-assets', pluginId);
      sources.push({
        sourcePath,
        outDir,
        publicUrl: `/plugin-assets/${pluginId}/${jsName}`,
      });
    }
  }
  return sources;
}

async function compileAll(sources: ClientSource[], silent = false): Promise<void> {
  try {
    const esbuild = await import('esbuild');
    for (const src of sources) {
      mkdirSync(src.outDir, { recursive: true });
      const outfile = join(src.outDir, src.sourcePath.split('/').pop()!.replace(/\.ts$/, '.js'));
      await esbuild.build({
        entryPoints: [src.sourcePath],
        outfile,
        bundle: true,
        format: 'iife',
        target: 'es2020',
        minify: false,
        sourcemap: process.env.NODE_ENV !== 'production' ? 'inline' : false,
        logLevel: 'warning',
        // External: browser scripts must not bundle server-side modules
        external: ['cloudflare:*', 'typecho/*', '@/*', 'astro:*', 'node:*'],
      });
      if (!silent) {
        console.log(`[client-loader] ${src.sourcePath} → ${relative(process.cwd(), outfile)}`);
      }
    }
  } catch (err) {
    console.error('[client-loader] esbuild not available, skipping client compilation:', err);
  }
}

export default function clientLoaderIntegration(): AstroIntegration {
  let allSources: ClientSource[] = [];

  return {
    name: 'typecho-client-loader',
    hooks: {
      'astro:config:setup': async ({ config }) => {
        const rootDir = config.root
          ? config.root.pathname.replace(/^\/([A-Z]:)/, '$1')
          : process.cwd();

        allSources = [
          ...discoverCoreClients(rootDir),
          ...discoverPluginClients(rootDir),
        ];

        if (allSources.length > 0) {
          console.log(`[client-loader] Found ${allSources.length} client source(s)`);
          for (const src of allSources) {
            console.log(`  - ${relative(rootDir, src.sourcePath)} → ${src.publicUrl}`);
          }
          await compileAll(allSources);
        } else {
          console.log('[client-loader] No client sources found (src/client/ + src/plugins/*/client/)');
        }
      },

      'astro:server:setup': async ({ server }) => {
        // Recompile on change in dev mode using Vite's existing watcher.
        const changed = new Set<string>();
        let timer: ReturnType<typeof setTimeout> | undefined;

        const schedule = () => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            const paths = [...changed];
            changed.clear();
            const affected = allSources.filter(s => paths.some(p => s.sourcePath === p));
            if (affected.length > 0) {
              console.log('[client-loader] Recompiling due to changes...');
              await compileAll(affected, true);
              console.log('[client-loader] Done. Refresh your browser.');
            }
          }, 300);
        };

        server.watcher.add(allSources.map(src => src.sourcePath));
        server.watcher.on('change', (path: string) => {
          if (allSources.some(src => src.sourcePath === path)) {
            changed.add(path);
            schedule();
          }
        });
      },

      'astro:build:done': async () => {
        if (allSources.length > 0) {
          console.log(`[client-loader] ${allSources.length} client file(s) bundled.`);
        }
      },
    },
  };
}
