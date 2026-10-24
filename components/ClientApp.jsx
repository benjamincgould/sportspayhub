'use client';

// The whole app runs in the browser and talks only to this site's own /api routes.
// Nothing is rendered on the server: the page arrives empty and the app draws itself, so no
// club or member data is ever baked into the page's HTML.

import React, { useEffect, useState } from 'react';
import SportsClubApp from './SportsClubApp';
import { AuthGate } from './AuthScreens';
import { OwnerConsole } from './OwnerConsole';

export default function ClientApp() {
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  if (!ready) return null;
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
