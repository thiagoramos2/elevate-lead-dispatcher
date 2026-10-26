import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Para onde o Next encaminha /api/*. Lido no build (as rewrites vão para o manifest da build):
// no Docker, a imagem é construída com API_INTERNAL_URL=http://api:3001.
const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Monorepo: o tracing de arquivos do standalone parte da raiz do repositório.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  reactStrictMode: true,
  // O navegador só fala com o Next (mesma origem): o cookie de sessão SameSite=Strict funciona e não
  // é preciso CORS. O Next repassa /api/* para a API.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
