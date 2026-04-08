export default function SiteFooter({
  onExportDebug,
  className = "",
}) {
  const footerClass = ["site-footer", className].filter(Boolean).join(" ");
  return (
    <footer className={footerClass}>
      <button
        type="button"
        onClick={onExportDebug}
        className="site-footer-action">
        Export Debug Logs
      </button>
      <a
        href="https://github.com/ihvou/researchit"
        target="_blank"
        rel="noreferrer"
        className="site-footer-link">
        GitHub
      </a>
      <a
        href="https://www.linkedin.com/in/serhii-knyr-aa332b27/"
        target="_blank"
        rel="noreferrer"
        className="site-footer-link">
        Contact
      </a>
    </footer>
  );
}
