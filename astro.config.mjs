import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import themeLoader from './src/integrations/theme-loader.ts';
import pluginLoader from './src/integrations/plugin-loader.ts';
import clientLoader from './src/integrations/client-loader.ts';
import { sharedAliases } from './vite.shared.mjs';

const isBuild = process.argv.includes('build');

export default defineConfig({
  output: 'server',
  // Preserve authored whitespace in server-rendered markup and Vite assets.
  // Some themes rely on it for inline content and whitespace-sensitive CSS.
  compressHTML: false,
  adapter: cloudflare({
    imageService: 'passthrough',
    inspectorPort: isBuild ? false : undefined,
  }),
  security: {
    checkOrigin: false,
    // Permit the two local origins to fetch each other's assets when one is
    // used as a development-only CDN host. Production origins stay excluded.
    allowedDomains: [
      { protocol: 'http', hostname: 'localhost', port: '4321' },
      { protocol: 'http', hostname: '127.0.0.1', port: '4321' },
    ],
  },
  integrations: [themeLoader(), pluginLoader(), clientLoader()],
  vite: {
    build: {
      minify: false,
      cssMinify: false,
    },
    resolve: {
      alias: sharedAliases,
    },
    optimizeDeps: {
      // 预包含懒发现的依赖，避免首次启动时触发第二次优化 pass。
      // 第二次 pass 会全量重发依赖文件，而 workerd runner 仍引用首次 pass
      // 的旧 URL，导致 "The file does not exist at .../deps_ssr/xxx.js" 崩溃。
      include: ['astro/assets/services/noop'],
    },
  },
});
