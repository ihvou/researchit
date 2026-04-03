export default function Spinner({ size = 12, color = "var(--ck-accent)" }) {
  return (
    <span style={{
      display: "inline-block", width: size, height: size,
      border: "2px solid var(--ck-line)", borderTopColor: color,
      borderRadius: "50%", animation: "spin .75s linear infinite", flexShrink: 0,
    }} />
  );
}
