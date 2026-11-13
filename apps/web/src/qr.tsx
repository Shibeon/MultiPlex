import { encode } from 'uqr';

/** QR code en SVG (modules sombres sur fond clair, marge comprise : lisible quel que soit le thème). */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, data } = encode(text, { ecc: 'M', border: 2 });
  let d = '';
  data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
  return (
    <svg class="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shape-rendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
