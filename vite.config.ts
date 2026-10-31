import { defineConfig } from 'vite';
import { frontendGateway } from './src/backend/frontend-gateway.js';

export default defineConfig(({ command }) => {
  const gateway = command === 'serve' ? frontendGateway() : { plugins: [], proxy: {} };
  return {
    plugins: gateway.plugins,
    server: { host: '127.0.0.1', strictPort: true, fs: { deny: ['.env', '.env.*', '**/.data/**', '**/*.sqlite*', '**/.git/**', '**/.aws/**', '**/credentials', '**/*.{pem,key,crt}'] }, proxy: gateway.proxy },
    preview: { host: '127.0.0.1', strictPort: true, proxy: gateway.proxy },
  };
});
