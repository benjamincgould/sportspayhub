// The app's icons, drawn inline as SVG (no icon package to install or keep updated).
// Shapes are from Lucide (https://lucide.dev), ISC License, Copyright (c) Lucide Contributors.
import React from 'react';
const ICON_NODES = {
  RotateCcw: [['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }], ['path', { d: 'M3 3v5h5' }]],
  Ban: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'm4.9 4.9 14.2 14.2' }]],
  Gift: [['rect', { x: 3, y: 8, width: 18, height: 4, rx: 1 }], ['path', { d: 'M12 8v13' }], ['path', { d: 'M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7' }], ['path', { d: 'M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5' }]],
  ExternalLink: [['path', { d: 'M15 3h6v6' }], ['path', { d: 'M10 14 21 3' }], ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }]],
  Image: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ['circle', { cx: 9, cy: 9, r: 2 }], ['path', { d: 'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21' }]],
  Palette: [['circle', { cx: 13.5, cy: 6.5, r: 1.5 }], ['circle', { cx: 17.5, cy: 10.5, r: 1.5 }], ['circle', { cx: 8.5, cy: 7.5, r: 1.5 }], ['circle', { cx: 6.5, cy: 12.5, r: 1.5 }], ['path', { d: 'M12 2a10 10 0 0 0 0 20c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1 0-.9.7-1.5 1.5-1.5H16a6 6 0 0 0 6-6c0-4.9-4.5-8.9-10-8.9Z' }]],
  LogOut: [['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }], ['polyline', { points: '16 17 21 12 16 7' }], ['line', { x1: 21, y1: 12, x2: 9, y2: 12 }]],
  UserPlus: [['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }], ['circle', { cx: 9, cy: 7, r: 4 }], ['line', { x1: 19, y1: 8, x2: 19, y2: 14 }], ['line', { x1: 22, y1: 11, x2: 16, y2: 11 }]],
  Eye: [['path', { d: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  EyeOff: [['path', { d: 'M9.88 9.88a3 3 0 1 0 4.24 4.24' }], ['path', { d: 'M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68' }], ['path', { d: 'M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61' }], ['line', { x1: 2, y1: 2, x2: 22, y2: 22 }]],
  KeyRound: [['path', { d: 'M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z' }], ['circle', { cx: 16.5, cy: 7.5, r: 0.5 }]],
  Smartphone: [['rect', { x: 5, y: 2, width: 14, height: 20, rx: 2 }], ['line', { x1: 12, y1: 18, x2: 12.01, y2: 18 }]],
  Home: [['path', { d: 'm3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }], ['polyline', { points: '9 22 9 12 15 12 15 22' }]],
  Calendar: [['rect', { x: 3, y: 4, width: 18, height: 18, rx: 2 }], ['line', { x1: 16, y1: 2, x2: 16, y2: 6 }], ['line', { x1: 8, y1: 2, x2: 8, y2: 6 }], ['line', { x1: 3, y1: 10, x2: 21, y2: 10 }]],
  CreditCard: [['rect', { x: 2, y: 5, width: 20, height: 14, rx: 2 }], ['line', { x1: 2, y1: 10, x2: 22, y2: 10 }]],
  User: [['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }], ['circle', { cx: 12, cy: 7, r: 4 }]],
  Settings: [['circle', { cx: 12, cy: 12, r: 3 }], ['circle', { cx: 12, cy: 12, r: 7.5 }], ['path', { d: 'M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1' }]],
  Users: [['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }], ['circle', { cx: 9, cy: 7, r: 4 }], ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }], ['path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }]],
  DollarSign: [['line', { x1: 12, y1: 1, x2: 12, y2: 23 }], ['path', { d: 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6' }]],
  CheckSquare: [['polyline', { points: '9 11 12 14 22 4' }], ['path', { d: 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' }]],
  Layers: [['polygon', { points: '12 2 2 7 12 12 22 7 12 2' }], ['polyline', { points: '2 17 12 22 22 17' }], ['polyline', { points: '2 12 12 17 22 12' }]],
  FileText: [['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 2 14 8 20 8' }], ['line', { x1: 16, y1: 13, x2: 8, y2: 13 }], ['line', { x1: 16, y1: 17, x2: 8, y2: 17 }]],
  AlertCircle: [['circle', { cx: 12, cy: 12, r: 10 }], ['line', { x1: 12, y1: 8, x2: 12, y2: 12 }], ['line', { x1: 12, y1: 16, x2: 12.01, y2: 16 }]],
  Plus: [['line', { x1: 12, y1: 5, x2: 12, y2: 19 }], ['line', { x1: 5, y1: 12, x2: 19, y2: 12 }]],
  Edit2: [['path', { d: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' }]],
  Check: [['polyline', { points: '20 6 9 17 4 12' }]],
  X: [['line', { x1: 18, y1: 6, x2: 6, y2: 18 }], ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]],
  Shield: [['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }]],
  Phone: [['path', { d: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z' }]],
  Mail: [['rect', { x: 2, y: 4, width: 20, height: 16, rx: 2 }], ['path', { d: 'm22 7-10 6L2 7' }]],
  Printer: [['polyline', { points: '6 9 6 2 18 2 18 9' }], ['path', { d: 'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2' }], ['rect', { x: 6, y: 14, width: 12, height: 8 }]],
  Download: [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['polyline', { points: '7 10 12 15 17 10' }], ['line', { x1: 12, y1: 15, x2: 12, y2: 3 }]],
  RefreshCw: [['path', { d: 'M21 12a9 9 0 0 1-15.5 6.2L3 16' }], ['path', { d: 'M3 12a9 9 0 0 1 15.5-6.2L21 8' }], ['polyline', { points: '21 3 21 8 16 8' }], ['polyline', { points: '3 21 3 16 8 16' }]],
  Clock: [['circle', { cx: 12, cy: 12, r: 10 }], ['polyline', { points: '12 6 12 12 16 14' }]],
  MapPin: [['path', { d: 'M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z' }], ['circle', { cx: 12, cy: 10, r: 3 }]],
  Trash2: [['path', { d: 'M3 6h18' }], ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }], ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }], ['line', { x1: 10, y1: 11, x2: 10, y2: 17 }], ['line', { x1: 14, y1: 11, x2: 14, y2: 17 }]],
  ChevronDown: [['polyline', { points: '6 9 12 15 18 9' }]],
  ChevronUp: [['polyline', { points: '18 15 12 9 6 15' }]],
  ChevronLeft: [['polyline', { points: '15 18 9 12 15 6' }]],
  ChevronRight: [['polyline', { points: '9 18 15 12 9 6' }]],
  Undo2: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11' }]],
  Search: [['circle', { cx: 11, cy: 11, r: 8 }], ['line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }]],
  Copy: [['rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }], ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]],
};

const makeIcon = (nodes) => function Icon({ size = 24, className = '', strokeWidth = 2, ...rest }) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round', className, 'aria-hidden': true, focusable: 'false', ...rest,
  }, nodes.map(([tag, attrs], i) => React.createElement(tag, { key: i, ...attrs })));
};
export const LogOut = makeIcon(ICON_NODES.LogOut);
export const UserPlus = makeIcon(ICON_NODES.UserPlus);
export const Eye = makeIcon(ICON_NODES.Eye);
export const EyeOff = makeIcon(ICON_NODES.EyeOff);
export const KeyRound = makeIcon(ICON_NODES.KeyRound);
export const Smartphone = makeIcon(ICON_NODES.Smartphone);
export const Home = makeIcon(ICON_NODES.Home);
export const Calendar = makeIcon(ICON_NODES.Calendar);
export const CreditCard = makeIcon(ICON_NODES.CreditCard);
export const User = makeIcon(ICON_NODES.User);
export const Settings = makeIcon(ICON_NODES.Settings);
export const Users = makeIcon(ICON_NODES.Users);
export const DollarSign = makeIcon(ICON_NODES.DollarSign);
export const CheckSquare = makeIcon(ICON_NODES.CheckSquare);
export const Layers = makeIcon(ICON_NODES.Layers);
export const FileText = makeIcon(ICON_NODES.FileText);
export const AlertCircle = makeIcon(ICON_NODES.AlertCircle);
export const Plus = makeIcon(ICON_NODES.Plus);
export const Edit2 = makeIcon(ICON_NODES.Edit2);
export const Check = makeIcon(ICON_NODES.Check);
export const X = makeIcon(ICON_NODES.X);
export const Shield = makeIcon(ICON_NODES.Shield);
export const Phone = makeIcon(ICON_NODES.Phone);
export const Mail = makeIcon(ICON_NODES.Mail);
export const Printer = makeIcon(ICON_NODES.Printer);
export const Download = makeIcon(ICON_NODES.Download);
export const RefreshCw = makeIcon(ICON_NODES.RefreshCw);
export const Clock = makeIcon(ICON_NODES.Clock);
export const MapPin = makeIcon(ICON_NODES.MapPin);
export const Trash2 = makeIcon(ICON_NODES.Trash2);
export const ChevronDown = makeIcon(ICON_NODES.ChevronDown);
export const ChevronUp = makeIcon(ICON_NODES.ChevronUp);
export const ChevronLeft = makeIcon(ICON_NODES.ChevronLeft);
export const ChevronRight = makeIcon(ICON_NODES.ChevronRight);
export const Undo2 = makeIcon(ICON_NODES.Undo2);
export const Search = makeIcon(ICON_NODES.Search);
export const Copy = makeIcon(ICON_NODES.Copy);
export const Palette = makeIcon(ICON_NODES.Palette);
export const Image = makeIcon(ICON_NODES.Image);
export const ExternalLink = makeIcon(ICON_NODES.ExternalLink);
export const Gift = makeIcon(ICON_NODES.Gift);
export const Ban = makeIcon(ICON_NODES.Ban);
export const RotateCcw = makeIcon(ICON_NODES.RotateCcw);
