import { memo } from 'react';
import { ObjectKind } from '../../shared/catalog';

/**
 * The explorer's icon set.
 *
 * Colour is what makes the tree scannable and shape is what makes it correct,
 * and every mark here carries both. That is the same rule the connection row's
 * state glyph follows and it is not decoration: a hue can be taken away — by a
 * high-contrast theme, by `forced-colors`, by one in twelve men — and a tree
 * whose eight object types differ only in hue collapses into eight identical
 * grey rectangles the moment it is. Print this set in black and you can still
 * name every one.
 *
 * So the marks are grouped by silhouette family, which also encodes meaning:
 *
 *   panels     table, view          things with rows. A frame with a header
 *                                   band; a view is two of them, offset,
 *                                   because a view is drawn from something.
 *   squares    procedure, function  things you run. The rounded square says
 *                                   routine and the glyph inside says which.
 *   free forms trigger, sequence,   the long tail, each with a silhouette
 *              type, synonym        shared with nothing else.
 *
 * Every path is `currentColor`, so one CSS rule per kind colours the whole set
 * and `forced-colors` flattens it to `CanvasText` with no work at all. There
 * are no gradients and no ids, so a mark may be rendered a thousand times in
 * one document without colliding with itself.
 */

export type IconMark =
  | ObjectKind
  | 'folder'
  | 'schema'
  | 'favourite'
  | 'column'
  | 'key'
  | 'ref'
  | 'parameter';

interface Props {
  mark: IconMark;
  /** Rendered at 16 unless a smaller row asks for less. */
  size?: number;
  className?: string;
}

export const ObjectIcon = memo(function ObjectIcon({ mark, size = 16, className }: Props) {
  return (
    <svg
      className={`oi oi-${mark}${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[mark]}
    </svg>
  );
});

/**
 * Drawn on a 16 grid with a 1.3 stroke, which puts every edge on a half pixel
 * and keeps the set crisp at 100% without hinting. Anything filled is drawn at
 * a reduced opacity so a mark reads as a line drawing with one weighted area,
 * rather than as a solid blob that outshouts the name beside it.
 */
const PATHS: Record<IconMark, JSX.Element> = {
  /*
   * Containers. One silhouette in one neutral for every place you open — the
   * kind folders, and every schema.
   *
   * The eight object hues below used to be spent twice: once on a folder
   * called Tables and again on each of the twelve hundred tables inside it.
   * Four unrelated silhouettes in one column, each announcing what its own
   * label already said, is noise where a tree most needs calm. Spending hue
   * only on the leaves makes it mean exactly one thing — this row is an
   * object, and this is its kind — and leaves the container column to be read
   * as structure.
   *
   * Depth and the label separate a schema from a kind folder, which is what
   * separates them in every file tree ever drawn. Favourites keeps its star:
   * it is a list you built, not a place in the database.
   */
  folder: (
    <>
      <path
        d="M1.9 4.5a1.6 1.6 0 0 1 1.6-1.6h2.7l1.6 1.9h4.7a1.6 1.6 0 0 1 1.6 1.6v5.5a1.6 1.6 0 0 1-1.6 1.6H3.5a1.6 1.6 0 0 1-1.6-1.6z"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 6.9h11v5.1a1.1 1.1 0 0 1-1.1 1.1H3.6A1.1 1.1 0 0 1 2.5 12z"
        fill="currentColor"
        stroke="none"
        opacity={0.28}
      />
      <path d="M2 6.9h12" strokeWidth={1.1} opacity={0.65} />
    </>
  ),

  /* Panels. */

  table: (
    <>
      <rect x="1.9" y="2.9" width="12.2" height="10.2" rx="1.8" />
      <path d="M2.4 6.3h11.2" />
      <path d="M8 6.3v6.8" strokeWidth={1.1} opacity={0.7} />
      <path d="M2.4 9.7h11.2" strokeWidth={1.1} opacity={0.7} />
      <path d="M2.6 3.6h10.8v2.2H2.6z" fill="currentColor" stroke="none" opacity={0.3} />
    </>
  ),

  view: (
    <>
      <rect x="4.7" y="1.9" width="9.4" height="7.6" rx="1.7" opacity={0.5} strokeWidth={1.15} />
      <rect x="1.9" y="5.7" width="9.4" height="8.4" rx="1.7" />
      <path d="M2.4 8.7h8.4" />
      <path d="M2.5 6.3h8.2v2.1H2.5z" fill="currentColor" stroke="none" opacity={0.3} />
    </>
  ),

  /* Squares: the things that execute. */

  procedure: (
    <>
      <rect x="1.9" y="1.9" width="12.2" height="12.2" rx="3.3" />
      <path d="M6.5 5.3 10.7 8l-4.2 2.7z" fill="currentColor" stroke="none" />
    </>
  ),

  function: (
    <>
      <rect x="1.9" y="1.9" width="12.2" height="12.2" rx="3.3" />
      <path d="M10.1 4.6a1.9 1.9 0 0 0-2.9 1.3l-1 5.9" strokeWidth={1.45} strokeLinecap="round" />
      <path d="M5.4 7.4h4.3" strokeWidth={1.45} strokeLinecap="round" />
    </>
  ),

  /* The long tail. */

  trigger: (
    <path
      d="M9.6 1.6 3.5 9.1h3.6l-.7 5.3 6.1-7.6H9.1z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={1.1}
      strokeLinejoin="round"
      fillOpacity={0.35}
    />
  ),

  // An arrow with rungs: something that only ever counts upward.
  sequence: (
    <>
      <path d="M8 14.1V3.1" strokeWidth={1.5} strokeLinecap="round" />
      <path d="M4.6 6.3 8 2.7l3.4 3.6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.8 9.5h6.4M5.7 12.2h4.6" strokeWidth={1.35} strokeLinecap="round" opacity={0.65} />
    </>
  ),

  type: (
    <>
      <circle cx="8" cy="8" r="2.55" />
      <path
        d="M8 1.9v1.7M8 12.4v1.7M14.1 8h-1.7M3.6 8H1.9M12.3 3.7 11.1 4.9M4.9 11.1l-1.2 1.2M12.3 12.3l-1.2-1.2M4.9 4.9 3.7 3.7"
        strokeWidth={1.45}
        strokeLinecap="round"
      />
    </>
  ),

  synonym: (
    <>
      <path d="M6.6 4.5 7.9 3.2a3.2 3.2 0 0 1 4.6 4.5l-1.3 1.4" strokeWidth={1.45} strokeLinecap="round" />
      <path d="M9.4 11.5 8.1 12.8a3.2 3.2 0 0 1-4.6-4.5l1.3-1.4" strokeWidth={1.45} strokeLinecap="round" />
      <path d="M6.1 9.9 9.9 6.1" strokeWidth={1.45} strokeLinecap="round" />
    </>
  ),

  /* Containers and members. */

  schema: (
    <>
      <path d="M8 1.9 14.1 5v6L8 14.1 1.9 11V5z" strokeLinejoin="round" />
      <path d="M1.9 5 8 8.1 14.1 5M8 8.1v6" strokeWidth={1.15} strokeLinejoin="round" opacity={0.7} />
    </>
  ),

  favourite: (
    <path
      d="M8 2.2 9.8 5.9l4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z"
      fill="currentColor"
      strokeWidth={1.1}
      strokeLinejoin="round"
      fillOpacity={0.5}
    />
  ),

  column: (
    <>
      <rect x="4.7" y="2.4" width="6.6" height="11.2" rx="1.7" />
      <path d="M5.2 5.9h5.6" strokeWidth={1.15} opacity={0.7} />
    </>
  ),

  key: (
    <>
      <circle cx="5.5" cy="6.5" r="2.7" strokeWidth={1.4} />
      <path d="m7.4 8.4 5.1 5.1M10.6 11.6l1.4-1.4M12 13l1.4-1.4" strokeWidth={1.4} strokeLinecap="round" />
    </>
  ),

  ref: (
    <>
      <path d="M6.6 4.5 7.9 3.2a3.2 3.2 0 0 1 4.6 4.5l-1.3 1.4" strokeWidth={1.35} strokeLinecap="round" />
      <path d="M9.4 11.5 8.1 12.8a3.2 3.2 0 0 1-4.6-4.5l1.3-1.4" strokeWidth={1.35} strokeLinecap="round" />
    </>
  ),

  parameter: (
    <>
      <path d="M3.6 8h6.8" strokeWidth={1.45} strokeLinecap="round" />
      <path d="M8.5 5.3 11.4 8l-2.9 2.7" strokeWidth={1.45} strokeLinecap="round" strokeLinejoin="round" />
    </>
  )
};
