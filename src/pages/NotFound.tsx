import { Link } from 'react-router-dom';

/** An address that isn't a page on Streetkey. */
export default function NotFound() {
  return (
    <div className="card stack" style={{ maxWidth: 560 }}>
      <h1 style={{ fontSize: '1.6rem' }}>Page not found</h1>
      <p className="muted" style={{ margin: 0 }}>That address isn’t a page on Streetkey. It may have moved, or the link may be mistyped.</p>
      <div className="row">
        <Link className="btn" to="/">Go to the home page</Link>
        <Link className="btn ghost" to="/search">Search homes</Link>
        <Link className="btn ghost" to="/prices">Sold prices</Link>
      </div>
    </div>
  );
}
