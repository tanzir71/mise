import { useEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { Modal } from '@mise/ui/Modal.tsx';
import { newInboxId } from '@mise/core/inbox';
import { stockIsLow } from '@mise/core/stock';
import { quickUpdate, type QuickStockPreview } from '@mise/core/quickUpdate';
import {
  parseStockQuantity,
  stockAtoms,
  stockNumber,
  stockNameKey,
  stockQuantityText,
  stockToOrder,
} from '@mise/core/stock-quantity';
import {
  parseStaffStockCommand,
  type StaffStockCommand,
  type StaffStockPrepared,
} from '@mise/core/staff-stock-actions';
import {
  staffStockOriginalLimit,
  type StaffStockOriginal,
} from '@mise/core/staff-stock-journal';
import type { StaffStockItem, StaffStockPage } from '@mise/core/staff-stock';
import type { ScreenJournalRecord } from '@mise/core/device-screen-state';
import {
  createStaffStockSession,
  type StaffStockSession,
} from './data/staff-stock-session';
import { DeviceScreenRequestError } from './data/device-screen-remote';
import {
  ScreenStorageError,
  type ScreenJournal,
} from './data/device-screen-journal';
import './staff-stock.css';
import { useStockSpeech } from './useStockSpeech';

const sizes = {
  count: 14,
  minus: 14,
  plus: 14,
  history: 14,
  'low-dot': 6,
  mic: 18,
} as const;
function StockIcon({ name }: { name: keyof typeof sizes }) {
  return (
    <img
      alt=""
      src={import.meta.env.BASE_URL + 'staff-stock-assets/' + name + '.svg'}
      width={sizes[name]}
      height={sizes[name]}
    />
  );
}
function StockValue({
  text,
  label = 'value',
}: {
  text: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  if (text.length <= 4096)
    return <span className="staff-stock-literal">{text}</span>;
  return (
    <span className="staff-stock-long">
      <Button
        kind="secondary"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide' : 'Show'} full {label} ({stockQuantityText(text.length)}{' '}
        characters)
      </Button>
      <span className="staff-stock-long-full" hidden={!open}>
        {text}
      </span>
    </span>
  );
}
const itemLabel = (item: StaffStockItem) =>
  item.name.length <= 4096 ? item.name : 'stock item ' + item.id;
const isPending = (row: StaffStockOriginal) =>
  !row.outcome || row.outcome.state === 'pending';
const stamp = (at: number) =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at);
const failure = (error: unknown) =>
  error instanceof DeviceScreenRequestError ||
  error instanceof ScreenStorageError
    ? error.message
    : 'This stock request is unconfirmed. Keep the original or tell the manager by hand.';
const need = (item: StaffStockItem) => {
  try {
    return stockQuantityText(stockToOrder(item));
  } catch {
    return 'Review pack size';
  }
};
type Adjustment = {
  item: StaffStockItem;
  reason: 'used' | 'received' | 'waste' | 'count';
  quantity: string;
  note: string;
  at: number;
};
const CountRow = memo(function CountRow({
  item,
  value,
  disabled,
  onChange,
}: {
  item: StaffStockItem;
  value: string;
  disabled: boolean;
  onChange: (id: string, value: string) => void;
}) {
  return (
    <div role="row" className="staff-stock-count-row">
      <div role="rowheader">
        <StockValue text={item.name} label="item name" />
        <StockValue text={item.unit} label="unit" />
      </div>
      <div role="cell">{stockQuantityText(item.onHand)}</div>
      <div role="cell">
        <label>
          <span className="sr-only">Counted {itemLabel(item)}</span>
          <input
            inputMode="decimal"
            value={value}
            placeholder="Not counted"
            disabled={disabled}
            onChange={(e) => onChange(item.id, e.target.value)}
          />
        </label>
      </div>
    </div>
  );
});
export function StaffStockScreen({
  journal,
  source,
  onOriginals,
}: {
  journal: ScreenJournal;
  source: ScreenJournalRecord;
  onOriginals?: (present: boolean) => void;
}) {
  const actor = useRef<StaffStockSession | null>(null),
    generation = useRef(0),
    working = useRef(false),
    manual = useRef<HTMLTextAreaElement>(null);
  const [pages, setPages] = useState<StaffStockPage[]>([]),
    [originals, setOriginals] = useState<StaffStockOriginal[]>([]),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [denied, setDenied] = useState(false),
    [storageReady, setStorageReady] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [manualText, setManualText] = useState(''),
    [online, setOnline] = useState(() => navigator.onLine);
  const [view, setView] = useState<'stock' | 'count' | 'saved'>('stock'),
    [filter, setFilter] = useState('all'),
    [search, setSearch] = useState(''),
    [quick, setQuick] = useState(''),
    [preview, setPreview] = useState<QuickStockPreview | null>(null),
    [adjust, setAdjust] = useState<Adjustment | null>(null),
    [counts, setCounts] = useState<Record<string, string>>({}),
    [countAt, setCountAt] = useState(0),
    [comparison, setComparison] = useState<{
      id: string;
      packet: StaffStockPrepared;
    } | null>(null),
    [expanded, setExpanded] = useState<string | null>(null);
  const items = useMemo(() => pages.flatMap((p) => p.items), [pages]),
    byId = useMemo(
      () => new Map(items.map((item) => [item.id, item])),
      [items],
    );
  const pending = originals.find(isPending),
    next = pages.at(-1)?.next ?? null,
    access = pages[0]?.access,
    hasCountDraft = Object.values(counts).some((value) => value.trim());
  const canAdjust = Boolean(
    ready &&
    storageReady &&
    !denied &&
    !pending &&
    originals.length < staffStockOriginalLimit &&
    access?.permissions.includes('stock.adjust'),
  );
  const speech = useStockSpeech(
    online,
    (text) => {
      setQuick(text);
      setPreview(null);
    },
    () => setError('Could not hear the stock update. Type it and review.'),
  );
  const countChanged = useCallback(
    (id: string, value: string) =>
      setCounts((before) => ({ ...before, [id]: value })),
    [],
  );
  const sync = () => {
    const saved = actor.current?.saved();
    if (saved) {
      setOriginals(saved.actions);
      setDenied(Boolean(saved.readDenied));
      setStorageReady(saved.storageReady);
      onOriginals?.(Boolean(saved.actions.length));
    }
  };
  async function run(work: (reader: StaffStockSession) => Promise<void>) {
    if (working.current || !actor.current) return;
    const started = generation.current,
      reader = actor.current;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await work(reader);
    } catch (e) {
      if (started === generation.current) {
        setError(failure(e));
        setComparison(null);
      }
    } finally {
      if (started === generation.current) {
        sync();
        working.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    const started = ++generation.current;
    let reader: StaffStockSession | null = null;
    setReady(false);
    working.current = true;
    setBusy(true);
    void (async () => {
      reader = await createStaffStockSession(journal, source);
      if (started !== generation.current) {
        reader.stop();
        return;
      }
      actor.current = reader;
      sync();
      setReady(true);
      try {
        const page = await reader.read();
        if (started === generation.current) {
          setPages([page]);
          setDenied(false);
        }
      } catch (e) {
        if (started === generation.current) setError(failure(e));
      }
    })()
      .catch((e) => {
        if (started === generation.current) setError(failure(e));
      })
      .finally(() => {
        if (started === generation.current) {
          sync();
          working.current = false;
          setBusy(false);
        }
      });
    const connectivity = () => setOnline(navigator.onLine);
    window.addEventListener('online', connectivity);
    window.addEventListener('offline', connectivity);
    return () => {
      generation.current++;
      reader?.stop();
      actor.current = null;
      working.current = false;
      window.removeEventListener('online', connectivity);
      window.removeEventListener('offline', connectivity);
    };
  }, [journal, source, onOriginals]);
  useEffect(() => {
    if (manualText) {
      manual.current?.focus();
      manual.current?.select();
    }
  }, [manualText]);
  function refresh(more = false) {
    setComparison(null);
    setPreview(null);
    void run(async (reader) => {
      const page = await reader.read(more ? next : null);
      setPages((before) => (more ? [...before, page] : [page]));
      setDenied(false);
      setNotice('Current quantities checked.');
    });
  }
  async function copy(text: string) {
    setManualText('');
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Copied. Pass this note to the manager.');
    } catch {
      setManualText(text);
      setNotice('Select and copy the complete note below.');
    }
  }
  async function review(reader: StaffStockSession, id: string) {
    setComparison(null);
    const result = await reader.review(id);
    sync();
    if (result.state === 'review') {
      setComparison({ id, packet: result });
      setExpanded(id);
    } else
      setNotice(
        result.state === 'applied'
          ? 'The original stock change was already recorded.'
          : 'The unfinished request was closed.',
      );
  }
  async function capture(
    reader: StaffStockSession,
    command: StaffStockCommand,
    undoId: string | null = null,
    selected = pages,
  ) {
    const intent = await reader.capture(command, selected, undoId);
    sync();
    if (command.type === 'stock.batch' && command.count) {
      setCounts({});
      setCountAt(0);
    }
    setAdjust(null);
    setPreview(null);
    setQuick('');
    await review(reader, intent.command.id);
  }
  function adjustStock() {
    if (!adjust) return;
    const quantity = parseStockQuantity(adjust.quantity);
    if (quantity === null || (!quantity && adjust.reason !== 'count')) return;
    const draft = adjust;
    void run((reader) =>
      capture(
        reader,
        parseStaffStockCommand({
          id: newInboxId(),
          type: 'stock.adjust',
          outletId: draft.item.outletId,
          occurredAt: draft.at,
          moveId: newInboxId(),
          change: {
            id: draft.item.id,
            revision: draft.item.revision,
            reason: draft.reason,
            quantity,
            source: draft.reason === 'count' ? 'count' : 'manual',
            note: draft.note,
          },
        }),
      ),
    );
  }
  function quickReview() {
    speech.cancel();
    setPreview(quickUpdate(quick, items, access?.outletId ?? ''));
    setError('');
  }
  function quickSave() {
    if (!preview?.changes.length || preview.issues.length) return;
    const id = newInboxId(),
      changes = preview.changes.map((change, i) => ({
        id: change.id,
        revision: change.revision,
        reason: change.reason,
        quantity: change.quantity,
        source: 'quick_update' as const,
        note: change.note,
        eventId: i === 0 ? id : newInboxId(),
        moveId: newInboxId(),
      }));
    void run((reader) =>
      capture(
        reader,
        parseStaffStockCommand({
          id,
          type: 'stock.batch',
          outletId: access!.outletId,
          occurredAt: Date.now(),
          count: false,
          batchId: null,
          changes,
        }),
      ),
    );
  }
  function saveCounts() {
    const entered = items.filter((item) => counts[item.id]?.trim());
    if (
      !entered.length ||
      entered.length > 1000 ||
      entered.some((item) => parseStockQuantity(counts[item.id]) === null)
    )
      return;
    const id = newInboxId();
    void run(async (reader) => {
      await capture(
        reader,
        parseStaffStockCommand({
          id,
          type: 'stock.batch',
          outletId: access!.outletId,
          occurredAt: countAt,
          count: true,
          batchId: newInboxId(),
          changes: entered.map((item, i) => ({
            id: item.id,
            revision: item.revision,
            reason: 'count',
            quantity: parseStockQuantity(counts[item.id])!,
            source: 'count',
            note: 'Physical count',
            eventId: i === 0 ? id : newInboxId(),
            moveId: newInboxId(),
          })),
        }),
      );
      setCounts({});
    });
  }
  function recover(row: StaffStockOriginal, close = false) {
    setComparison(null);
    void run(async (reader) => {
      const result = await reader.recover(
        row.intent.command.id,
        close ? 'close' : 'inspect',
      );
      setNotice(
        result.state === 'applied'
          ? 'This original change was recorded.'
          : result.state === 'closed'
            ? 'The unfinished request was closed.'
            : 'The original is still unconfirmed. Review it before changing a quantity.',
      );
    });
  }
  function undo(row: StaffStockOriginal, itemId: string) {
    const move = row.outcome?.receipt?.command.results.find(
      (result) => result.stockItemId === itemId,
    )?.moveId;
    if (!move) return;
    setComparison(null);
    void run(async (reader) => {
      const selected: StaffStockPage[] = [];
      let after: string | null = null,
        item: StaffStockItem | undefined;
      do {
        const page = await reader.read(after);
        selected.push(page);
        item = page.items.find((i) => i.id === itemId);
        after = page.next;
        if (item || (page.items.at(-1)?.id && page.items.at(-1)!.id > itemId))
          break;
      } while (after);
      if (!item) throw new DeviceScreenRequestError('review');
      await capture(
        reader,
        {
          id: newInboxId(),
          type: 'stock.undo',
          outletId: item.outletId,
          occurredAt: Date.now(),
          stockItemId: item.id,
          revision: item.revision,
          undoMoveId: move,
          moveId: newInboxId(),
        },
        row.intent.command.id,
        selected,
      );
    });
  }
  function step(item: StaffStockItem, delta: bigint) {
    try {
      setAdjust({
        item,
        reason: 'count',
        quantity: String(stockNumber(stockAtoms(item.onHand) + delta)),
        note: 'On hand count',
        at: Date.now(),
      });
    } catch {
      setError('Use a supported nonnegative quantity.');
    }
  }
  const selectedCount = items.filter((item) => counts[item.id]?.trim()),
    countInvalid = selectedCount.some(
      (item) => parseStockQuantity(counts[item.id]) === null,
    ),
    low = useMemo(() => items.filter(stockIsLow), [items]),
    categories = useMemo(
      () => [...new Set(items.map((i) => i.category).filter(Boolean))],
      [items],
    );
  const visible = useMemo(() => {
    const query = stockNameKey(search);
    return items.filter(
      (item) =>
        (filter === 'low'
          ? stockIsLow(item)
          : filter.startsWith('category:')
            ? item.category === filter.slice(9)
            : true) &&
        (!query ||
          stockNameKey(
            item.name + ' ' + item.nameLocal + ' ' + item.aliases.join(' '),
          ).includes(query)),
    );
  }, [items, filter, search]);
  const outlet =
    pages[0]?.outletName ??
    (source.state.phase === 'signed-in'
      ? (JSON.parse(source.state.outletNameJson) as string)
      : 'Your outlet');
  return (
    <main className="staff-stock" aria-busy={busy}>
      <header className="staff-stock-heading">
        <div>
          <p>{outlet}</p>
          <h1>
            {view === 'count'
              ? 'Night count'
              : view === 'saved'
                ? 'My stock requests'
                : 'Stock'}
          </h1>
          <p>Use your own PIN. Compare current quantities before saving.</p>
        </div>
        <div>
          <Button
            kind="secondary"
            disabled={busy}
            onClick={() => {
              setView(view === 'saved' ? 'stock' : 'saved');
              setComparison(null);
            }}
          >
            <StockIcon name="history" />
            My requests {originals.length || ''}
          </Button>
          {view !== 'count' ? (
            <Button
              kind="secondary"
              disabled={busy || !canAdjust || !items.length}
              onClick={() => {
                setView('count');
                if (!countAt) setCountAt(Date.now());
                setComparison(null);
              }}
            >
              <StockIcon name="count" />
              Count
            </Button>
          ) : (
            <Button
              kind="secondary"
              disabled={busy}
              onClick={() => setView('stock')}
            >
              Back to stock
            </Button>
          )}
        </div>
      </header>
      {!online ? (
        <p className="staff-stock-note" role="status">
          Offline. Saved originals stay on this screen. You can close an
          unfinished request or copy a note for the manager.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="staff-stock-error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div className="staff-stock-tools">
        <small>
          {pages.length && !denied
            ? 'Checked ' + stamp(pages[pages.length - 1].serverAt)
            : 'No current stock read'}
        </small>
        <Button
          kind="secondary"
          disabled={busy || !ready || hasCountDraft}
          onClick={() => refresh()}
        >
          Refresh stock
        </Button>
        <Button
          kind="secondary"
          onClick={() =>
            void copy(
              'Please review stock at ' +
                outlet +
                '. This screen cannot confirm a quantity change. I will report the physical item, amount and time by hand.',
            )
          }
        >
          Copy note for manager
        </Button>
      </div>
      {hasCountDraft ? (
        <p>
          Your entered counts stay with their original loaded items. Finish this
          count before refreshing stock.
        </p>
      ) : null}
      {manualText ? (
        <label>
          Note for manual copy
          <textarea
            ref={manual}
            rows={5}
            readOnly
            value={manualText}
            onFocus={(e) => e.target.select()}
          />
        </label>
      ) : null}
      {notice.includes('manager') || manualText ? (
        <Button
          kind="secondary"
          onClick={() =>
            setNotice(
              'You passed the note on. Stock changes still need their actual recorded outcome.',
            )
          }
        >
          I told the manager
        </Button>
      ) : null}
      {!storageReady ? (
        <Card>
          <h2>Keep this screen open</h2>
          <p>
            The browser could not verify or save its stock originals. Keep the
            existing data and tell the manager the change by hand.
          </p>
        </Card>
      ) : null}
      {originals.length >= staffStockOriginalLimit ? (
        <Card>
          <h2>Keep the saved history</h2>
          <p>
            This screen has reached its saved-request capacity. Keep the
            complete originals and tell the manager the next change by hand.
          </p>
        </Card>
      ) : null}
      {pending ? (
        <Card className="staff-stock-pending">
          <h2>Finish your saved request first</h2>
          <p>
            The complete original is retained. Check its actual outcome or
            review a current comparison before sending another change.
          </p>
          <Button
            kind="secondary"
            disabled={busy}
            onClick={() => {
              setView('saved');
              setExpanded(pending.intent.command.id);
            }}
          >
            Open saved request
          </Button>
        </Card>
      ) : null}
      {view !== 'saved' && (!items.length || denied) ? (
        <Card>
          <h2>{denied ? 'Current stock access changed' : 'No stock loaded'}</h2>
          <p>
            The manager enables Update stock for this outlet. Your own saved
            requests remain available for inspection, closure and manual copy.
          </p>
        </Card>
      ) : null}
      {view === 'stock' && items.length && !denied ? (
        <>
          <Card className="staff-stock-quick">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                quickReview();
              }}
            >
              <label htmlFor="staff-stock-quick">Quick update</label>
              <div>
                <input
                  id="staff-stock-quick"
                  value={quick}
                  maxLength={8000}
                  placeholder="used 2 kg chicken, got 10 L oil"
                  disabled={busy || !canAdjust}
                  onChange={(e) => {
                    speech.cancel();
                    setQuick(e.target.value);
                    setPreview(null);
                  }}
                />
                {speech.supported ? (
                  <Button
                    kind="ghost"
                    type="button"
                    aria-label="Say stock update"
                    disabled={busy || !canAdjust || speech.listening}
                    onClick={speech.start}
                  >
                    <StockIcon name="mic" />
                  </Button>
                ) : null}
                <Button
                  kind="secondary"
                  type="submit"
                  disabled={busy || !canAdjust || !quick.trim()}
                >
                  Review
                </Button>
              </div>
            </form>
            <p>
              Type the items and quantities. Every change is shown before
              saving.
            </p>
            {preview ? (
              <div className="staff-stock-preview">
                {preview.changes.map((change) => (
                  <p key={change.id}>
                    <StockValue text={change.name} label="item name" /> ·{' '}
                    {stockQuantityText(change.before)} →{' '}
                    {stockQuantityText(change.after)}{' '}
                    <StockValue text={change.unit} label="unit" />
                  </p>
                ))}
                {preview.issues.map((issue, i) => (
                  <p role="alert" key={i}>
                    {issue.clause}:{' '}
                    <StockValue text={issue.message} label="review message" />
                  </p>
                ))}
                <Button
                  disabled={
                    busy ||
                    !canAdjust ||
                    !preview.changes.length ||
                    Boolean(preview.issues.length)
                  }
                  onClick={quickSave}
                >
                  Compare current quantities
                </Button>
              </div>
            ) : null}
          </Card>
          <div
            className="staff-stock-filters"
            role="group"
            aria-label="Stock filters"
          >
            {[
              ['all', 'All ' + items.length],
              ['low', 'Low ' + low.length],
              ...categories.map((c, index) => [
                'category:' + c,
                c.length <= 4096 ? c : 'Imported category ' + (index + 1),
              ]),
            ].map(([key, label]) => (
              <Button
                key={key}
                kind={filter === key ? 'primary' : 'secondary'}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
              </Button>
            ))}
          </div>
          {categories
            .filter((c) => c.length > 4096)
            .map((c) => (
              <p key={c}>
                <StockValue text={c} label="category" />
              </p>
            ))}
          <label className="staff-stock-search">
            Search stock
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <div className="staff-stock-columns">
            <span>Item</span>
            <span>On hand (tap to review)</span>
          </div>
          <Card className="staff-stock-list">
            {visible.map((item) => (
              <div key={item.id} className="staff-stock-item">
                <div>
                  <div className="staff-stock-name">
                    <StockValue text={item.name} label="item name" /> ·{' '}
                    <StockValue text={item.unit} label="unit" />
                  </div>
                  {item.name.length > 4096 ? (
                    <small>
                      Item <code>{item.id}</code>
                    </small>
                  ) : null}
                  {stockIsLow(item) ? (
                    <span className="staff-stock-low">
                      <StockIcon name="low-dot" />
                      Low
                    </span>
                  ) : null}
                  {item.nameLocal ? (
                    <div lang="bn" className="staff-stock-local">
                      <StockValue text={item.nameLocal} label="local name" />
                    </div>
                  ) : null}
                  <small>
                    Target (par) {stockQuantityText(item.target)} · To order{' '}
                    {need(item)}
                  </small>
                </div>
                <div className="staff-stock-stepper">
                  <Button
                    kind="ghost"
                    disabled={busy || !canAdjust || item.onHand < 1}
                    aria-label={'Decrease ' + itemLabel(item)}
                    onClick={() => step(item, -1000n)}
                  >
                    <StockIcon name="minus" />
                  </Button>
                  <Button
                    kind="ghost"
                    disabled={busy || !canAdjust}
                    aria-label={
                      'Review on hand ' +
                      itemLabel(item) +
                      ', ' +
                      stockQuantityText(item.onHand)
                    }
                    onClick={() =>
                      setAdjust({
                        item,
                        reason: 'count',
                        quantity: String(item.onHand),
                        note: '',
                        at: Date.now(),
                      })
                    }
                  >
                    {stockQuantityText(item.onHand)}
                  </Button>
                  <Button
                    kind="ghost"
                    disabled={busy || !canAdjust}
                    aria-label={'Increase ' + itemLabel(item)}
                    onClick={() => step(item, 1000n)}
                  >
                    <StockIcon name="plus" />
                  </Button>
                </div>
              </div>
            ))}
          </Card>
          {!visible.length ? <p>No loaded items match this filter.</p> : null}
          <div className="staff-stock-adjust-actions">
            {(['used', 'received', 'waste'] as const).map((reason) => (
              <Button
                key={reason}
                kind="secondary"
                disabled={busy || !canAdjust}
                onClick={() =>
                  setAdjust({
                    item: items[0],
                    reason,
                    quantity: '',
                    note: '',
                    at: Date.now(),
                  })
                }
              >
                {reason === 'used'
                  ? 'Used stock'
                  : reason === 'received'
                    ? 'Received stock'
                    : 'Waste'}
              </Button>
            ))}
          </div>
        </>
      ) : null}
      {view === 'count' && items.length && !denied ? (
        <Card className="staff-stock-count">
          <header>
            <h2>Physical count</h2>
            <p>
              Enter only what you counted. Blank items remain unchanged. Each
              request supports up to 1,000 counted items.
            </p>
            <p>
              {selectedCount.length} of {items.length} loaded items entered
            </p>
          </header>
          <div role="table" aria-label="Physical stock count">
            <div role="row" className="staff-stock-count-row">
              <span role="columnheader">Item</span>
              <span role="columnheader">Expected</span>
              <span role="columnheader">Counted</span>
            </div>
            {items.map((item) => (
              <CountRow
                key={item.id}
                item={item}
                value={counts[item.id] ?? ''}
                disabled={busy || !canAdjust}
                onChange={countChanged}
              />
            ))}
          </div>
          {countInvalid ? (
            <p role="alert">
              Use a nonnegative quantity with at most three decimals.
            </p>
          ) : null}
          {selectedCount.length > 1000 ? (
            <p role="alert">
              Save at most 1,000 counts in one request. Keep the other items for
              another count.
            </p>
          ) : null}
          <Button
            disabled={
              busy ||
              !canAdjust ||
              !selectedCount.length ||
              selectedCount.length > 1000 ||
              countInvalid
            }
            onClick={saveCounts}
          >
            Compare {selectedCount.length || ''}{' '}
            {selectedCount.length === 1 ? 'count' : 'counts'}
          </Button>
        </Card>
      ) : null}
      {view !== 'saved' && next && !denied ? (
        <Button
          kind="secondary"
          disabled={busy || Boolean(comparison)}
          onClick={() => refresh(true)}
        >
          Load more stock
        </Button>
      ) : null}
      {comparison ? (
        <Card
          className="staff-stock-comparison"
          role="region"
          aria-label="Current stock comparison"
        >
          <h2>Review current quantities</h2>
          <p>
            Confirming records this physical change. The original report and
            time remain retained.
          </p>
          {comparison.packet.review.lines.map((line, i) => (
            <div className="staff-stock-comparison-line" key={line.itemId}>
              <StockValue
                text={comparison.packet.review.items[i].name}
                label="item name"
              />
              <strong>
                {stockQuantityText(line.before)} →{' '}
                {stockQuantityText(line.after)}{' '}
                <StockValue
                  text={comparison.packet.review.items[i].unit}
                  label="unit"
                />
              </strong>
              {comparison.packet.review.withdrawn.includes(line.itemId) ? (
                <small>
                  A previous movement was withdrawn. Check this item carefully.
                </small>
              ) : null}
            </div>
          ))}
          <p>Comparison expires {stamp(comparison.packet.review.expiresAt)}.</p>
          <div className="staff-stock-buttons">
            <Button
              disabled={busy}
              onClick={() => {
                const chosen = comparison;
                void run(async (reader) => {
                  const outcome = await reader.confirm(
                    chosen.id,
                    chosen.packet,
                  );
                  setComparison(null);
                  setNotice(
                    outcome.state === 'applied'
                      ? 'Stock change recorded. Check the actual receipt in My requests.'
                      : 'The unfinished request was closed.',
                  );
                  setPages([]);
                  setView('saved');
                });
              }}
            >
              Confirm quantities
            </Button>
            <Button
              kind="secondary"
              disabled={busy}
              onClick={() => setComparison(null)}
            >
              Keep original for later
            </Button>
          </div>
        </Card>
      ) : null}
      {view === 'saved' ? (
        <section
          className="staff-stock-history"
          aria-label="My saved stock requests"
        >
          {!originals.length ? (
            <Card>
              <p>No saved stock requests for your PIN on this screen.</p>
            </Card>
          ) : null}
          {[...originals].reverse().map((row) => {
            const id = row.intent.command.id,
              isOpen = expanded === id;
            return (
              <Card key={id} className="staff-stock-original">
                <header>
                  <h2>
                    {row.intent.command.type === 'stock.undo'
                      ? 'Undo'
                      : row.intent.command.type === 'stock.batch'
                        ? 'Stock batch'
                        : 'Stock change'}{' '}
                    ·{' '}
                    {row.outcome?.state === 'applied'
                      ? 'Recorded'
                      : row.outcome?.state === 'closed'
                        ? 'Closed'
                        : row.closeRequested
                          ? 'Closure saved locally'
                          : 'Unconfirmed'}
                  </h2>
                  <p>
                    {stamp(row.intent.command.occurredAt)} ·{' '}
                    {row.intent.items.length}{' '}
                    {row.intent.items.length === 1 ? 'item' : 'items'}
                  </p>
                  <code>{id}</code>
                </header>
                <div className="staff-stock-buttons">
                  <Button
                    kind="secondary"
                    disabled={busy}
                    onClick={() => setExpanded(isOpen ? null : id)}
                  >
                    {isOpen ? 'Hide original' : 'Show original'}
                  </Button>
                  <Button
                    kind="secondary"
                    disabled={busy}
                    onClick={() => recover(row)}
                  >
                    Check saved request
                  </Button>
                  {isPending(row) ? (
                    <>
                      <Button
                        disabled={busy || row.closeRequested || denied}
                        onClick={() => void run((reader) => review(reader, id))}
                      >
                        Review current stock
                      </Button>
                      <Button
                        kind="secondary"
                        disabled={busy}
                        onClick={() => recover(row, true)}
                      >
                        Close unfinished request
                      </Button>
                    </>
                  ) : null}
                  <Button
                    kind="secondary"
                    onClick={() =>
                      void copy(JSON.stringify(row.intent, null, 2))
                    }
                  >
                    Copy complete original
                  </Button>
                </div>
                {isOpen ? (
                  <>
                    <p>
                      Original PIN session:{' '}
                      <code>{row.intent.origin.sessionId}</code>
                    </p>
                    {row.intent.items.map((item, i) => (
                      <div className="staff-stock-original-line" key={item.id}>
                        <div className="staff-stock-name">
                          <StockValue text={item.name} label="item name" /> ·{' '}
                          <StockValue text={item.unit} label="unit" />
                        </div>
                        <small>
                          Reported on hand {stockQuantityText(item.onHand)}
                        </small>
                        {row.outcome?.receipt ? (
                          <p>
                            Recorded{' '}
                            {stockQuantityText(
                              row.outcome.receipt.reviewed[i].before,
                            )}{' '}
                            →{' '}
                            {stockQuantityText(
                              row.outcome.receipt.reviewed[i].after,
                            )}
                          </p>
                        ) : null}
                        {row.outcome?.state === 'applied' &&
                        row.intent.command.type !== 'stock.undo' &&
                        !denied &&
                        (access
                          ? access.permissions.includes('stock.undo')
                          : row.intent.origin.permissions.includes(
                              'stock.undo',
                            )) &&
                        !pending ? (
                          <Button
                            kind="secondary"
                            disabled={busy}
                            onClick={() => undo(row, item.id)}
                          >
                            Review undo for {itemLabel(item)}
                          </Button>
                        ) : null}
                      </div>
                    ))}
                    <details>
                      <summary>Complete original source</summary>
                      <pre>{JSON.stringify(row.intent, null, 2)}</pre>
                    </details>
                  </>
                ) : null}
              </Card>
            );
          })}
        </section>
      ) : null}
      <Modal
        open={adjust !== null}
        title="Review a stock change"
        closeLabel="Close stock editor"
        onClose={() => {
          if (!busy) setAdjust(null);
        }}
        variant="sheet"
        className="staff-stock-editor"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            adjustStock();
          }}
        >
          {adjust ? (
            <>
              <label>
                Item
                <select
                  disabled={busy}
                  value={adjust.item.id}
                  onChange={(e) => {
                    const item = byId.get(e.target.value);
                    if (item)
                      setAdjust({
                        ...adjust,
                        item,
                        quantity:
                          adjust.reason === 'count' ? String(item.onHand) : '',
                      });
                  }}
                >
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {itemLabel(item)} ·{' '}
                      {item.unit.length <= 4096 ? item.unit : 'imported unit'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Change
                <select
                  value={adjust.reason}
                  disabled={busy}
                  onChange={(e) =>
                    setAdjust({
                      ...adjust,
                      reason: e.target.value as Adjustment['reason'],
                      quantity: '',
                    })
                  }
                >
                  <option value="used">Used</option>
                  <option value="received">Received</option>
                  <option value="waste">Waste</option>
                  <option value="count">Physical count</option>
                </select>
              </label>
              <label>
                <span className="staff-stock-unit-caption">
                  Quantity{' '}
                  {adjust.item.unit.length <= 4096
                    ? '(' + adjust.item.unit + ')'
                    : ''}
                </span>
                <input
                  autoFocus
                  inputMode="decimal"
                  aria-invalid={Boolean(
                    adjust.quantity.trim() &&
                    parseStockQuantity(adjust.quantity) === null,
                  )}
                  value={adjust.quantity}
                  disabled={busy}
                  onChange={(e) =>
                    setAdjust({ ...adjust, quantity: e.target.value })
                  }
                />
                {adjust.quantity.trim() &&
                parseStockQuantity(adjust.quantity) === null ? (
                  <small role="alert">
                    Use a nonnegative quantity with at most three decimals.
                  </small>
                ) : null}
              </label>
              {adjust.item.unit.length > 4096 ? (
                <div>
                  <p>Complete imported unit</p>
                  <StockValue text={adjust.item.unit} label="unit" />
                </div>
              ) : null}
              <label>
                Note
                <textarea
                  value={adjust.note}
                  maxLength={1000}
                  disabled={busy}
                  onChange={(e) =>
                    setAdjust({ ...adjust, note: e.target.value })
                  }
                />
              </label>
              <p>Original report time: {stamp(adjust.at)}</p>
              <Button
                type="submit"
                disabled={
                  busy ||
                  !canAdjust ||
                  parseStockQuantity(adjust.quantity) === null ||
                  (adjust.reason !== 'count' &&
                    parseStockQuantity(adjust.quantity) === 0)
                }
              >
                Compare current quantities
              </Button>
            </>
          ) : null}
        </form>
      </Modal>
    </main>
  );
}
