import type { LinkEntry } from "@/lib/links";
import { RedirectClient } from "./RedirectClient";

type RedirectViewProps = {
  link: LinkEntry;
};

export function RedirectView({ link }: RedirectViewProps) {
  return (
    <main className="page-shell">
      <meta httpEquiv="refresh" content={`0.3;url=${link.target}`} />
      <RedirectClient target={link.target} delayMs={250} />
      <section className="redirect-panel" aria-labelledby="redirect-title">
        <div className="spinner" aria-hidden="true" />
        <h1 id="redirect-title" className="redirect-title">
          Đang chuyển hướng...
        </h1>
        <p className="redirect-description">
          Bạn sẽ được chuyển đến nội dung trong giây lát.
        </p>
        <a className="fallback-link" href={link.target}>
          Mở liên kết ngay
        </a>
      </section>
    </main>
  );
}
