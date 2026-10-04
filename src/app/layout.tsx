import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { Oxanium } from 'next/font/google';
import { ThemeProvider } from '@/components/ui/theme-provider';
import { Toaster } from 'react-hot-toast';
import dynamic from 'next/dynamic';
import './globals.css';
import { ErrorBoundary } from './app-components/ErrorBoundary';

/* SSR disabled because the Matrix bootstrap touches localStorage and window globals */
const ClientShell = dynamic(() => import('./utils/ClientShell'), { ssr: false });

const oxanium = Oxanium({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-oxanium',
  display: 'swap',
});

const geistMono = localFont({
  src: './fonts/GeistMonoVF.woff',
  variable: '--font-geist-mono',
  weight: '100 900',
});

export const metadata: Metadata = {
  title: 'Nexus',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className={`${oxanium.variable} ${geistMono.variable} antialiased h-[100dvh] overflow-hidden`}
      >
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
          <Toaster position="top-center" />
          <ErrorBoundary>
            <ClientShell>{children}</ClientShell>
          </ErrorBoundary>
        </ThemeProvider>
      </body>
    </html>
  );
}