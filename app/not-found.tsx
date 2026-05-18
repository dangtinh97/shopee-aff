import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page-shell">
      <section className="redirect-panel" aria-labelledby="not-found-title">
        <h1 id="not-found-title" className="redirect-title">
          Không tìm thấy link
        </h1>
        <p className="redirect-description">
          Link này không tồn tại hoặc đã bị xóa khỏi datasource.
        </p>
        <Link className="fallback-link" href="/">
          Quay về trang chính
        </Link>
      </section>
    </main>
  );
}
