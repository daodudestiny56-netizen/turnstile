import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...rest }: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const LogoMark = ({ size = 32 }: { size?: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect width="32" height="32" rx="9" fill="var(--accent-soft)" stroke="var(--green-border)" />
    <circle cx="16" cy="16" r="9" fill="none" stroke="var(--accent-text)" strokeWidth="2.2" />
    <path
      d="M16 7v18M9.6 11.5l12.8 9M9.6 20.5l12.8-9"
      stroke="var(--accent-text)"
      strokeWidth="2.2"
      strokeLinecap="round"
    />
  </svg>
);

export const ShieldCheck = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  </Icon>
);

export const Alert = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M12 3l9.5 17h-19L12 3z" />
    <path d="M12 10v4M12 17.5v.01" />
  </Icon>
);

export const Stop = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3L8.3 3z" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </Icon>
);

export const Route = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="5" r="2" />
    <path d="M8 19h7a3.5 3.5 0 000-7H9a3.5 3.5 0 010-7h7" />
  </Icon>
);

export const Chart = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Icon>
);

export const Lock = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="4" y="10" width="16" height="11" rx="2.5" />
    <path d="M8 10V7a4 4 0 018 0v3" />
  </Icon>
);

export const Eye = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const Database = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <ellipse cx="12" cy="5.5" rx="8" ry="3" />
    <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </Icon>
);

export const Clock = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

export const Check = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const ArrowRight = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

export const Download = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Icon>
);

export const Refresh = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6" />
  </Icon>
);

export const Sun = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);

export const Moon = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" />
  </Icon>
);

export const Menu = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const Code = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />
  </Icon>
);
