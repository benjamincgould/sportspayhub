'use client';

// The whole app runs in the browser and talks only to this site's own /api routes.
// Nothing is rendered on the server: the page arrives empty and the app draws itself, so no
// club or member data is ever baked into the page's HTML.

import React, { useEffect, useState } from 'react';
import SportsClubApp from './SportsClubApp';
import { AuthGate } from './AuthScreens';
import { OwnerConsole } from './OwnerConsole';
import { demoFromHash } from './demo';

export default function ClientApp() {
  const [ready, setReady] = useState(false);
  const [hash, setHash] = useState('');
  useEffect(() => {
    setReady(true);
    setHash(window.location.hash);
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (!ready) return null;
  // A shared demo link (#/demo?...): the sample club, no sign-in, nothing saved
  const demo = demoFromHash(hash);
  if (demo) {
    return (
      <div id="root">
        <SportsClubApp key={hash} mode="demo" demoClub={demo} onExitDemo={() => { window.location.hash = ''; }} />
      </div>
    );
  }
  return (
    <div id="root">
      <AuthGate>
        {({ user, signOut, updateUser }) => (user.role === 'owner'
          ? <OwnerConsole user={user} signOut={signOut} updateUser={updateUser} />
          : <SportsClubApp key={user.id} mode="server" session={{ user }} signOut={signOut} updateUser={updateUser} />)}
      </AuthGate>
    </div>
  );
}
