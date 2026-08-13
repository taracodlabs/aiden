import type { Metadata } from 'next'
import { DM_Mono, Outfit } from 'next/font/google'
import './globals.css'

// Taracod design system: Outfit for display/body, DM Mono for numbers.
const dmMono = DM_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500'],
})

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-sans',
  weight: ['400', '500', '600', '700'],
})

export const metadata: Metadata = {
  title: 'Aiden Workbench',
  description: 'Aiden — local-first agent · Taracod',
  icons: { icon: '/favicon.png' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dmMono.variable} ${outfit.variable}`}>
      <body>{children}</body>
    </html>
  )
}
