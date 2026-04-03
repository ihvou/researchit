export default function ChevronIcon({
  direction = "down",
  size = 12,
  stroke = "currentColor",
  strokeWidth = 1.8,
}) {
  const rotation = direction === "up" ? 180 : direction === "left" ? 90 : direction === "right" ? -90 : 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{ transform: `rotate(${rotation}deg)`, display: "inline-block", flexShrink: 0 }}>
      <path
        d="M2.5 4.25L6 7.75L9.5 4.25"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
