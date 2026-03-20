export default function Spinner({ size = 12, color = "#a855f7" }) {
  return (
    <span style={{
      display: "inline-block", width: size, height: size,
      border: "2px solid #ffffff14", borderTopColor: color,
      borderRadius: "50%", animation: "spin .75s linear infinite", flexShrink: 0,
    }} />
  );
}
