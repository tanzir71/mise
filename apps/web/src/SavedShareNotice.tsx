import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './data/db';

/** Count-only feedback keeps source content separate from an unselected outlet. */
export function SavedShareNotice({
  purpose,
}: {
  purpose: 'setup' | 'join' | 'operator';
}) {
  const count = useLiveQuery(
    () => db.inboxItems.filter((item) => item.outletId === null).count(),
    [],
  );
  if (!count) return null;
  const object = count === 1 ? 'it' : 'them',
    next =
      purpose === 'operator'
        ? `Choose or verify an outlet, then open Inbox to review ${object}.`
        : purpose === 'join'
          ? `Your saved shares stay on this device while the outlet joins. Review ${object} in Inbox afterwards.`
          : `Set up this device, then review ${object} in Inbox.`;
  return (
    <p className="saved-share-notice" role="status">
      {count} shared {count === 1 ? 'item is' : 'items are'} saved on this
      device. {next}
    </p>
  );
}
