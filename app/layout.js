import './globals.css';

export const metadata = {
  title: process.env.PLATFORM_NAME || 'Club App',
  description: 'Bookings, attendance and payments for sports clubs.',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
  // Added to an iPhone's home screen, it opens full screen like a normal app
  appleWebApp: { capable: true, title: process.env.PLATFORM_NAME || 'Club App', statusBarStyle: 'black-translucent' },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#4f46e5',
};

// Every page is rendered per request, so each one gets its own security nonce (see proxy.js)
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }) {
  return (
    <html lang="en-NZ">
      <body>{children}</body>
    </html>
  );
}
