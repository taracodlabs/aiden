import type { Metadata } from 'next'
import { DM_Mono } from 'next/font/google'
import './globals.css'

// Aiden uses the native system sans for product copy and DM Mono for technical data.
const dmMono = DM_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500'],
})

export const metadata: Metadata = {
  title: 'Aiden Workbench',
  description: 'Aiden — local-first agent · Taracod',
  icons: { icon: '/favicon.png' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={dmMono.variable}>
      <body>{children}</body>
    </html>
  )
}
