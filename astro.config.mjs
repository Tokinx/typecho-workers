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
  // Workers Caching 平台缓存层：@astrojs/cloudflare 检测到 cloudflare cache
  // provider 后自动生成 `cache: { enabled: true }` 部署配置，并对没有
  // `Cloudflare-CDN-Cache-Control` 头的响应自动补 no-store（安全网）。
  // 公共 HTML 的缓存语义由 typecho-plugin-cache 插件通过该头显式声明。
  cache: {
    provider: {
      name: 'cloudflare',
      entrypoint: '@astrojs/cloudflare/cache/provider',
    },
  },
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
      // workspace 插件/主题包必须走源码路径，禁止 optimizeDeps 预打包：
      // 它们以 node_modules symlink 暴露，Vite 会按依赖预打包，导致包内
      // `typecho/plugin-sdk` 被内联成独立副本，pluginAdminPaths / hook 注册
      // 与中间件（源码版 @/lib/plugin）形成双实例，插件 admin 路由被
      // isReservedCorePath 误判为保留路径而 404。
      exclude: [
        'typecho-plugin-antispam',
        'typecho-plugin-cache',
        'typecho-plugin-notifier',
        'typecho-plugin-notes',
        'typecho-plugin-scribe',
        'typecho-plugin-turnstile',
        'typecho-theme-warm',
      ],
    },
  },
});
