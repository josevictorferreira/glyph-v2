// Tiny icon set (inline SVG, currentColor) — no icon package dependency.

type IconProps = React.SVGProps<SVGSVGElement> & { size?: number };

function svg({ size = 16, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const X = (p: IconProps) => svg({ ...p, children: <path d="M18 6 6 18M6 6l12 12" /> });
export const Plus = (p: IconProps) => svg({ ...p, children: <path d="M12 5v14M5 12h14" /> });
export const ChevronRight = (p: IconProps) => svg({ ...p, children: <path d="m9 18 6-6-6-6" /> });
export const ChevronDown = (p: IconProps) => svg({ ...p, children: <path d="m6 9 6 6 6-6" /> });
export const Copy = (p: IconProps) =>
  svg({
    ...p,
    children: (
      <>
        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      </>
    ),
  });
export const Play = (p: IconProps) =>
  svg({ ...p, children: <path d="M6 4.5 19 12 6 19.5z" fill="currentColor" /> });
export const Pause = (p: IconProps) =>
  svg({
    ...p,
    children: (
      <>
        <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" />
        <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" />
      </>
    ),
  });
export const Trash = (p: IconProps) =>
  svg({
    ...p,
    children: (
      <>
        <path d="M3 6h18" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </>
    ),
  });
export const Search = (p: IconProps) =>
  svg({
    ...p,
    children: (
      <>
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </>
    ),
  });
export const Settings = (p: IconProps) =>
  svg({
    ...p,
    children: (
      <>
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
  });
export const Sparkle = (p: IconProps) =>
  svg({
    ...p,
    children: (
      <path
        d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.4L22.3 18l-2.4.9L19 21.3l-.9-2.4-2.4-.9 2.4-.9z"
        fill="currentColor"
        stroke="none"
      />
    ),
  });
export const Clock = (p: IconProps) =>
  svg({
    ...p,
    children: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </>
    ),
  });
export const Calendar = (p: IconProps) =>
  svg({
    ...p,
    children: (
      <>
        <rect width="18" height="18" x="3" y="4" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </>
    ),
  });
export const FileText = (p: IconProps) =>
  svg({ ...p, children: <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" /> });
export const AlertTriangle = (p: IconProps) =>
  svg({
    ...p,
    children: (
      <>
        <path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
  });
export const CheckCircle = (p: IconProps) =>
  svg({
    ...p,
    children: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
  });
export const Stop = (p: IconProps) =>
  svg({ ...p, children: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /> });
export const Download = (p: IconProps) =>
  svg({
    ...p,
    children: (
      <>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5" />
        <path d="M12 15V3" />
      </>
    ),
  });
export const Layers = (p: IconProps) =>
  svg({ ...p, children: <path d="m12 2 9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5" /> });
export const CircleSlash = (p: IconProps) =>
  svg({
    ...p,
    children: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="m4.9 4.9 14.2 14.2" />
      </>
    ),
  });

export const PanelLeft = (p: IconProps) =>
  svg({
    ...p,
    children: (
      <>
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M9 3v18" />
      </>
    ),
  });

export const MenuBars = (p: IconProps) =>
  svg({ ...p, children: <path d="M4 6h16M4 12h16M4 18h16" /> });
