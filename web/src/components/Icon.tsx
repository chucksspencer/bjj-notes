const PATHS = {
  focus: 'M12 3v3m0 12v3M3 12h3m12 0h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  library: 'M5 4h4v16H5zM10 4h4v16h-4zM15.5 4.8l3.8-1 3.7 15.5-3.8 1z',
  positions: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1.5 3h5L16 13h5',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 5l-7 7 7 7',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.5 15.5 20 20',
  close: 'M6 6l12 12M18 6 6 18',
  play: 'M8 5v14l11-7z',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  check: 'M5 12.5 10 17 19 7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  chevron: 'M6 9l6 6 6-6',
  star: 'M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.9l-5.2 2.75 1-5.8-4.2-4.1 5.8-.85z',
  flask: 'M9.5 3h5M10 3v6L4.8 18.2A1.9 1.9 0 0 0 6.5 21h11a1.9 1.9 0 0 0 1.7-2.8L14 9V3M7.5 14h9',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, label, filled }: { name: IconName; size?: number; label?: string; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={name === 'play' || filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={name === 'play' ? 0 : name === 'more' ? 3.2 : 1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
