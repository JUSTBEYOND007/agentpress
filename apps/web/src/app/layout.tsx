import type { Metadata } from 'next';

import { PRODUCT_NAME } from '@agentpress/domain';

import './globals.css';

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: 'AgentPress writing workspace',
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
