import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { ThemeProvider } from '@/components/ui/theme-provider';
import { Toaster } from 'react-hot-toast';
import dynamic from 'next/dynamic';
import './globals.css';
import { ErrorBoundary } from './app-components/ErrorBoundary';

/* SSR disabled because the Matrix bootstrap touches localStorage and window globals */
const ClientShell = dynamic(() => import('./utils/ClientShell'), { ssr: false });

/* Oxanium's own ascent and descent set its capitals above the middle of a line, so these values centre them instead */
const oxanium = localFont({
  src: [
    { path: './fonts/oxanium-latin-400.woff2', weight: '400' },
    { path: './fonts/oxanium-latin-500.woff2', weight: '500' },
    { path: './fonts/oxanium-latin-600.woff2', weight: '600' },
    { path: './fonts/oxanium-latin-700.woff2', weight: '700' },
    { path: './fonts/oxanium-latin-800.woff2', weight: '800' },
  ],
  variable: '--font-oxanium',
  display: 'swap',
  declarations: [
    { prop: 'ascent-override', value: '84.5%' },
    { prop: 'descent-override', value: '15.5%' },
  ],
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