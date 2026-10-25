// Lets people add the app to their phone's home screen, where it opens full screen like a normal
// app (no browser address bar).
export default function manifest() {
  const name = process.env.PLATFORM_NAME || 'Club App';
  return {
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: 'Bookings, attendance and payments for sports clubs.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f8fafc',
    theme_color: '#4f46e5',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
