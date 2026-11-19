import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Suspense } from "react";
import { Toaster } from "sonner";
import { ChunkErrorHandler } from "@/components/chunk-error-handler";
import { AuthProviderWrapper } from "@/components/auth-provider-wrapper";
import { SWRProvider } from "@/lib/swr-config";
import { ResourceHints } from "@/components/resource-hints";
import { LoadingProvider } from "@/components/loading-overlay";
import { AppWithClockProvider } from "@/components/app-with-clock-provider";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

// Grow Spark Workspace type: Inter for everything, JetBrains Mono for IDs and codes.
// Three weights only (400 / 500 / 600). Self-hosted by next/font, no runtime request to Google.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: 'Project Management - Professional Service Automation',
    template: '%s | Project Management',
  },
  description: 'Professional Service Automation Platform for Project Management - manage projects, track time, and streamline workflows.',
  openGraph: {
    title: 'Project Management - Professional Service Automation',
    description: 'Professional Service Automation Platform for Project Management - manage projects, track time, and streamline workflows.',
    type: 'website',
    siteName: 'Project Management',
  },
  twitter: {
    card: 'summary',
    title: 'Project Management - Professional Service Automation',
    description: 'Professional Service Automation Platform for Project Management',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // data-theme is set before first paint by THEME_INIT_SCRIPT (saved choice or system setting)
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}>
        <ResourceHints />
        <AuthProviderWrapper>
          <SWRProvider>
            <Suspense fallback={null}>
              <LoadingProvider>
                <ChunkErrorHandler />
                <AppWithClockProvider>
                  {children}
                </AppWithClockProvider>
                <Toaster />
              </LoadingProvider>
            </Suspense>
          </SWRProvider>
        </AuthProviderWrapper>
      </body>
    </html>
  );
}
