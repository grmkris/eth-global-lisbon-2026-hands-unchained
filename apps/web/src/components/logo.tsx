/**
 * The Hands Unchained mark.
 *
 * `logo.png` at the repo root is the full lockup — a worker's arm and an SO-101
 * snapping a chain. It is an illustrative ~1.7:1 drawing, so at nav size it
 * turns to mush: measured, not assumed. At 18px the whole lockup is
 * unreadable, while the arm on its own still reads as a flexed arm, because it
 * spends the entire height budget on one form instead of three. So the app
 * carries the arm crop.
 *
 * It stays RASTER rather than traced to vector. The antialiasing and the cyan
 * gradient are doing real legibility work down there, and the app is
 * permanently dark (`<html className="dark">`), so a `currentColor` silhouette
 * would buy nothing and cost the gradient.
 *
 * Regenerate with `python3 presentation/extract-logo.py` — it cuts this,
 * `logo-plate.png`, `logo-art.png` and the traced `logo-mark.svg` from the one
 * source — then copy `presentation/logo-arm.png` to `src/logo-mark.png`.
 */
import markUrl from "../logo-mark.png?url";

export function HandMark(props: { className?: string }) {
	return (
		<img
			src={markUrl}
			alt=""
			aria-hidden="true"
			className={props.className}
			width={208}
			height={256}
		/>
	);
}
