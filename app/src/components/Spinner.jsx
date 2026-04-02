export default function Spinner({ size = 12, color = "var(--ck-blue)" }) {
  return (
    <span style={{
      display: "inline-block", width: size, height: size,
      border: "2px solid #dbe4ff", borderTopColor: color,
      borderRadius: "50%", animation: "spin .75s linear infinite", flexShrink: 0,
    }} />
  );
}
