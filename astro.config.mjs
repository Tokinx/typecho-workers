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
  },
});
