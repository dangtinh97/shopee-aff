import Link from "next/link";

export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="redirect-panel" aria-labelledby="home-title">
        <h1 id="home-title" className="redirect-title">
          Redirect Links
        </h1>
        <p className="redirect-description">
          Project Next.js tạo link trung gian có Open Graph preview và redirect
          đến URL đích.
        </p>
        <Link className="fallback-link" href="/xemvideo/abc123">
          Xem link mẫu
        </Link>
      </section>
    </main>
  );
}
