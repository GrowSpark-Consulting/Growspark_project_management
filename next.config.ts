import type { NextConfig } from "next";
import path from "path";
import fs from "fs";

// Get the real path with correct casing on Windows
function getRealPath(inputPath: string): string {
  if (process.platform !== 'win32') return inputPath;
  try {
    return fs.realpathSync.native(inputPath);
  } catch {
    return inputPath;
  }
}

// Normalize the project root to use correct casing
const projectRoot = getRealPath(process.cwd());
const realNodeModulesPath = path.join(projectRoot, 'node_modules');

const nextConfig: NextConfig = {
  // A second local build (the frontend-only test run, tests/local-e2e/with-local-env.mjs) uses its own folder
  distDir: process.env.NEXT_DIST_DIR || '.next',

  // CRITICAL: Fix Windows path casing issues
  // On Windows, paths like C:\Users\user\Desktop and C:\Users\user\desktop are the same folder
  // but webpack treats them as different modules, causing duplicate React instances
  webpack: (config, { isServer, dev }) => {
    if (process.platform === 'win32') {
      // Ensure consistent path resolution
      config.resolve = config.resolve || {};

      // Disable symlink resolution to prevent path variations
      config.resolve.symlinks = false;

      // Use cache without context to prevent path-based cache key issues
      config.resolve.cacheWithContext = false;

      // CRITICAL: Force module resolution to use correct-cased paths only
      // This prevents webpack from finding the same module via different casing
      config.resolve.modules = [
        realNodeModulesPath,
        'node_modules'
      ];

      // Key fix: Normalize the context to use correct casing
      config.context = projectRoot;

      // Normalize snapshot paths to prevent caching issues
      config.snapshot = config.snapshot || {};
      config.snapshot.managedPaths = [realNodeModulesPath];
      config.snapshot.immutablePaths = [realNodeModulesPath];

      // Add alias for the app directory with correct casing
      config.resolve.alias = {
        ...config.resolve.alias,
        '@': projectRoot,
      };

      // Force webpack to use consistent paths in the file system
      if (dev) {
        // Override the resolver to normalize paths
        config.resolveLoader = config.resolveLoader || {};
        config.resolveLoader.modules = [realNodeModulesPath, 'node_modules'];
      }
    }

    return config;
  },

  /* config options here */
  serverExternalPackages: ['@supabase/ssr'],

  // Configure on-demand revalidation for chunk loading
  experimental: {
    // optimizePackageImports disabled - causes vendor-chunks MODULE_NOT_FOUND in Next.js 15 dev mode
    // optimizePackageImports: [
    //   'lucide-react',
    //   '@radix-ui/react-icons',
    //   '@radix-ui/react-dialog',
    //   '@radix-ui/react-select',
    //   '@radix-ui/react-dropdown-menu',
    //   '@radix-ui/react-tooltip',
    //   '@radix-ui/react-popover',
    //   '@radix-ui/react-tabs',
    //   '@radix-ui/react-label',
    //   '@radix-ui/react-slot',
    //   '@xyflow/react',
    //   'recharts',
    //   'date-fns',
    // ],
    // optimizeCss: true, // Disabled - causes CSS MIME type issues in Next.js 15 dev mode
    optimizeServerReact: true,
  },

  // Production optimizations
  reactStrictMode: true,

  // Performance optimizations
  poweredByHeader: false,
  compress: true,

  // Image optimization
  images: {
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    minimumCacheTTL: 60,
  },

  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? {
      exclude: ['error', 'warn'],
    } : false,
  },

  // Skip lint and type checking during build (already verified in CI/dev)
  // This cuts build time in half on low-memory VPS machines
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },

  // Frontend on Vercel, API on Render: when BACKEND_URL (the Render service's URL) is set at build
  // time, every /api request is forwarded there before Vercel's own routes. The browser only talks to
  // the Vercel origin, so the sign-in cookie, CSP and CORS stay same-origin. Server-rendered pages get
  // their data from the same backend (lib/page-data.ts), so Vercel holds no database credentials.
  // Unset (Render itself, local): no forwarding.
  async rewrites() {
    const backend = process.env.BACKEND_URL?.trim().replace(/\/$/, '');
    if (!backend) return [];
    return {
      beforeFiles: [
        { source: '/api/:path*', destination: `${backend}/api/:path*` },
        // Sign-in links (password reset, email confirmation): the code is exchanged for a session there
        { source: '/auth/callback', destination: `${backend}/auth/callback` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },

  // Security Headers
  async headers() {
    // The browser talks to Supabase directly (sign-in and some reads), so connect-src must allow
    // exactly the configured Supabase origin. Behind the nginx /supabase proxy that origin is the
    // app's own ('self'), so nothing is added; for Supabase on another origin (Supabase Cloud,
    // local Docker) it is added explicitly. Evaluated when the app is built.
    const supabaseOrigins = (() => {
      try {
        const { origin } = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '');
        return [origin, origin.replace(/^http/, 'ws')];
      } catch {
        return [];
      }
    })().join(' ');
    return [
      {
        // Apply to all routes
        source: '/:path*',
        headers: [
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on'
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY'
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block'
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin'
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()'
          },
          // Content Security Policy
          {
            key: 'Content-Security-Policy',
            value: process.env.NODE_ENV === 'production'
              ? [
                  "default-src 'self'",
                  "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
                  "style-src 'self' 'unsafe-inline'",
                  "img-src 'self' data: https: blob:",
                  "font-src 'self' data:",
                  `connect-src 'self' ${supabaseOrigins}`.trim(),
                  "frame-src 'self'",
                  "object-src 'none'",
                  "base-uri 'self'",
                  "form-action 'self'",
                  "frame-ancestors 'none'",
                ].join('; ')
              : // Development CSP
                [
                  "default-src 'self'",
                  "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
                  "style-src 'self' 'unsafe-inline'",
                  "img-src 'self' data: https: blob:",
                  "font-src 'self' data:",
                  `connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:* ${supabaseOrigins}`.trim(),
                  "frame-src 'self'",
                ].join('; ')
          }
        ],
      },
    ];
  },
};

export default nextConfig;
