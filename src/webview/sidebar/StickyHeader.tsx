import { RefObject } from 'react';
import { GroupHeader, PinnedHeader } from './GroupHeader';
import { ResultsHeader } from './TreeRow';
import { FlatItem } from './model';

/**
 * The section heading that stays put, drawn as a copy rather than with
 * `position: sticky`.
 *
 * Sticky does not compose with absolutely-positioned rows inside a spacer: the
 * headers are laid out by the same offset table the rows are, so there is no
 * flow for them to stick within. So one element lives outside the scroller's
 * content at `top: 0` and `VirtualList` writes its `translateY` straight to
 * `overlayRef` every frame — one transform, no layout, no React work. That is
 * also why this component never touches the ref it is handed.
 *
 * It is `aria-hidden`, and the real header stays in DOM order and keeps the
 * accessible name and the tab stop. The overlay's twistie is a click proxy: it
 * posts the same `collapse` message with the same arguments, so nothing has to
 * be wired between the two copies. A keyboard user forty rows into a group
 * presses ← to reach the real header, which is the workbench's own gesture.
 *
 * The overlay carries its own ribbon segment because it covers the group's, and
 * a 3px column that breaks wherever the heading happens to have stopped is a
 * column the eye stops trusting.
 */
export function StickyHeader(props: {
  item: FlatItem | null;
  overlayRef: RefObject<HTMLDivElement>;
}): JSX.Element | null {
  const { item, overlayRef } = props;

  // `owner` yields a header index or -1, so anything that is not one of the
  // three headers only reaches here if the geometry is wrong. Drawing nothing
  // beats naming the wrong environment, which is worse than no sticky header
  // at all.
  if (item === null || (item.kind !== 'group' && item.kind !== 'pinned' && item.kind !== 'results')) {
    return null;
  }

  return (
    <div className="sticky" ref={overlayRef} aria-hidden="true">
      {item.kind === 'group' ? (
        <>
          <span className={`ribbon env-${item.environment}`} />
          <GroupHeader
            environment={item.environment}
            count={item.count}
            open={item.open}
            collapsed={item.collapsed}
            top={0}
            // The copy is out of the accessible tree, so these carry no
            // meaning; they are here because the values must still be valid.
            posinset={1}
            setsize={1}
            overlay
          />
        </>
      ) : item.kind === 'results' ? (
        // A search across four servers puts `dbo.Customer` in four sections.
        // The connection each result belongs to is the fact that distinguishes
        // them, so it is the one heading that must never scroll away.
        <ResultsHeader
          gkey={item.key}
          top={0}
          label={item.label}
          count={item.count}
          capped={item.capped}
          posinset={1}
          setsize={1}
          overlay
        />
      ) : (
        <PinnedHeader count={item.count} top={0} posinset={1} setsize={1} overlay />
      )}
    </div>
  );
}
