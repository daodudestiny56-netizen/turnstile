import { useMemo, type ReactNode } from "react";
import qrcode from "qrcode-generator";

/**
 * A QR code drawn as inline SVG from the module matrix: no images, no data: URLs, so the strict
 * Content Security Policy stays as it is. Always black on white with a quiet zone, whatever the
 * theme, because that is what phone cameras read reliably.
 */
export function QrCode({
  text,
  label,
  size = 220,
}: {
  text: string;
  label: string;
  size?: number;
}): ReactNode {
  const { d, extent } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    let path = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    return { d: path, extent: n + 2 * quiet };
  }, [text]);
  return (
    <svg
      className="qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${extent} ${extent}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
