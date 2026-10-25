// The sales demo: a pretend club with sample members, groups and payments, dressed in the
// prospect's sport, name and colour. It runs entirely in the browser: nothing is saved, nothing
// reaches the server, no real payments or emails. Reloading starts it fresh.

import { BRAND_COLOURS } from './brand';

// What each sport calls its groups and members, and where it trains
export const SPORT_PRESETS = {
  Swimming: { group: 'Squad', member: 'Athlete', venue: 'Main Pool', spots: ['Lanes 1–2', 'Lanes 3–4', 'Lanes 5–6'] },
  Rugby: { group: 'Grade', member: 'Player', venue: 'Main Field', spots: ['Field 1', 'Field 2', 'Field 3'] },
  Football: { group: 'Team', member: 'Player', venue: 'Main Park', spots: ['Pitch 1', 'Pitch 2', 'Pitch 3'] },
  Netball: { group: 'Team', member: 'Player', venue: 'Netball Centre', spots: ['Court 1', 'Court 2', 'Court 3'] },
  Basketball: { group: 'Team', member: 'Player', venue: 'Stadium', spots: ['Court 1', 'Court 2', 'Court 3'] },
  Hockey: { group: 'Team', member: 'Player', venue: 'Hockey Turf', spots: ['Turf 1', 'Turf 2', 'Turf 1'] },
  Cricket: { group: 'Team', member: 'Player', venue: 'Club Grounds', spots: ['Nets', 'Oval', 'Nets'] },
  Athletics: { group: 'Group', member: 'Athlete', venue: 'Athletics Track', spots: ['Track', 'Field area', 'Track'] },
  Gymnastics: { group: 'Class', member: 'Gymnast', venue: 'Gym', spots: ['Floor', 'Beam & bars', 'Floor'] },
  Tennis: { group: 'Group', member: 'Player', venue: 'Tennis Club', spots: ['Courts 1–2', 'Courts 3–4', 'Courts 5–6'] },
  Dance: { group: 'Class', member: 'Dancer', venue: 'Studio', spots: ['Studio A', 'Studio B', 'Studio A'] },
  'Martial arts': { group: 'Class', member: 'Student', venue: 'Dojo', spots: ['Mat 1', 'Mat 2', 'Mat 1'] },
  Cycling: { group: 'Group', member: 'Rider', venue: 'Velodrome', spots: ['Track', 'Road loop', 'Track'] },
  Rowing: { group: 'Crew', member: 'Rower', venue: 'Boat Shed', spots: ['Lake', 'Erg room', 'Lake'] },
  Other: { group: 'Group', member: 'Member', venue: 'Club Rooms', spots: ['Room 1', 'Room 2', 'Room 3'] },
};
export const DEMO_SPORTS = Object.keys(SPORT_PRESETS);
const COLOURS = new Set(BRAND_COLOURS.map((c) => c.name));

// Tidy whatever was asked for (it can come from a shared link, so trust nothing)
export function demoClubFrom({ name, sport, colour } = {}) {
  const s = SPORT_PRESETS[sport] ? sport : 'Swimming';
  const p = SPORT_PRESETS[s];
  return {
    name: String(name || '').replace(/[<>]/g, '').trim().slice(0, 60) || 'Skills 4 Life Aquatics',
    sport: s,
    venue: p.venue,
    spots: p.spots,
    branding: { group: p.group, groups: `${p.group}s`, member: p.member, members: `${p.member}s`, colour: COLOURS.has(colour) ? colour : 'indigo', logo: null },
  };
}

// A link anyone can open to try the demo (no sign-in)
export function demoLink(origin, { name, sport, colour }) {
  const q = new URLSearchParams({ name: name || '', sport: sport || 'Swimming', colour: colour || 'indigo' });
  return `${origin}/#/demo?${q}`;
}
export function demoFromHash(hash) {
  const m = /^#\/demo(?:\?(.*))?$/.exec(hash || '');
  if (!m) return null;
  const q = new URLSearchParams(m[1] || '');
  return demoClubFrom({ name: q.get('name'), sport: q.get('sport'), colour: q.get('colour') });
}
