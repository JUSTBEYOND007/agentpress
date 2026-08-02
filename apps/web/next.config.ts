import path from 'node:path';

import type { NextConfig } from 'next';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: workspaceRoot,
  reactStrictMode: true,
  transpilePackages: ['@agentpress/domain', '@agentpress/editor-patch'],
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
