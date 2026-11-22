import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { newInboxId } from '@mise/core/inbox';
import {
  customerViewerUrl,
  customerWhatsAppUrl,
} from '@mise/core/customer-link-url';
import type {
  CustomerLinkAttempt,
  CustomerLinkJournal,
  CustomerLinkMetadata,
  CustomerLinkPage,
} from '@mise/core/customer-link-admin';
import {
  assertLiveCommandReceipt,
  CommandRequestError,
} from './data/command-request';
import {
  useCustomerLinkOwner,
  type CustomerLinkOwner,
} from './use-customer-link-owner';
import type { CustomerLinkAreaProps } from './CustomerLinkArea';
import './customer-link-controls.css';
const blank = (): CustomerLinkJournal => ({
  v: 1,
  lifecycle: null,
  revoke: null,
});
export function CustomerLinkControls({
  setup,
  kind,
  resourceId,
  phone,
  label,
}: CustomerLinkAreaProps) {
  const [online, setOnline] = useState(navigator.onLine),
    [working, setWorking] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [journal, setJournal] = useState<CustomerLinkJournal>(blank),
    [attempt, setAttempt] = useState<CustomerLinkAttempt | null>(null),
    [page, setPage] = useState<CustomerLinkPage | null>(null),
    [more, setMore] = useState(false),
    [fallback, setFallback] = useState(''),
    [language, setLanguage] = useState<'en' | 'bn'>('en');
  const [shared, setShared] = useState<{
    owner: CustomerLinkOwner;
    value: CustomerLinkMetadata & { token: string };
    url: string;
  } | null>(null);
  const owner = useCustomerLinkOwner(setup, kind, resourceId, online),
    ready = owner.ready,
    holder = useRef(ready),
    busy = useRef<CustomerLinkOwner | null>(null),
    pageGeneration = useRef(0);
  holder.current = ready;
  const sharedNow =
    shared && shared.owner === ready && ready?.active ? shared : null;
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    return () => {
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
    };
  }, []);
  useEffect(() => {
    pageGeneration.current++;
    setWorking(false);
    setShared(null);
    setFallback('');
    setPage(ready?.page ?? null);
    setAttempt(null);
    setJournal(blank());
    setError('');
    setNotice('');
    setMore(false);
    if (!ready) return;
    const original = ready;
    let current = true;
    try {
      setJournal(original.session.saved());
    } catch {
      setError(
        'Keep the saved link record. It needs review before another link can be created.',
      );
      return;
    }
    void original.session
      .inspect(original.signal)
      .then((value) => {
        if (current && original.active && holder.current === original) {
          setAttempt(value);
          setJournal(original.session.saved());
        }
      })
      .catch(() => {
        if (current && original.active && holder.current === original)
          setError(
            'The saved link could not be checked. Keep it and try again.',
          );
      });
    return () => {
      current = false;
    };
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    const original = ready;
    const changed = (e: StorageEvent) => {
      if (e.key !== null && e.key !== original.session.key) return;
      original.session.forget();
      setShared(null);
      setFallback('');
      setAttempt(null);
      try {
        setJournal(original.session.saved());
        setNotice(
          'Saved links changed in another tab. Check now before continuing.',
        );
      } catch {
        setError(
          'The saved link record needs review. Keep it and use the manual message option.',
        );
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [ready]);
  const current = (value: CustomerLinkOwner) =>
    value.active && holder.current === value && !value.signal.aborted;
  const date = (at: number) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: setup.outlet.timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(at);
  async function reload(value: CustomerLinkOwner) {
    const generation = ++pageGeneration.current;
    const [next, actual] = await Promise.all([
      value.session.page(null, 50, value.signal),
      value.session.inspect(value.signal),
    ]);
    if (!current(value) || generation !== pageGeneration.current) return;
    setPage(next);
    setAttempt(actual);
    setJournal(value.session.saved());
    if (actual?.state !== 'issued') setShared(null);
  }
  async function action(work: (value: CustomerLinkOwner) => Promise<void>) {
    if (!ready || busy.current === ready || more) return;
    const original = ready;
    busy.current = original;
    setWorking(true);
    setError('');
    setNotice('');
    pageGeneration.current++;
    try {
      await work(original);
    } catch (e) {
      if (current(original)) {
        setError(
          e instanceof CommandRequestError && e.kind === 'auth'
            ? 'Sign in again with the original phone account. The saved link action is retained.'
            : 'This link action is unconfirmed. Check its saved attempt or retry its saved revocation.',
        );
        try {
          setJournal(original.session.saved());
        } catch {
          setError(
            'The saved link record needs review. Keep it and use the manual message option.',
          );
        }
        if (e instanceof CommandRequestError && e.kind === 'auth') {
          original.active = false;
          original.session.forget();
          setShared(null);
          owner.refresh();
        }
      }
    } finally {
      if (busy.current === original) busy.current = null;
      if (holder.current === original) setWorking(false);
    }
  }
  async function create(value: CustomerLinkOwner) {
    const source = {
      id: newInboxId(),
      createEventId: newInboxId(),
      kind,
      resourceId,
      expiresAt: null,
    };
    await value.session.create(source, value.signal);
    const receipt = await value.session.share(value.signal);
    assertLiveCommandReceipt(receipt);
    if (!current(value)) return;
    const url = customerViewerUrl(location.origin, import.meta.env.BASE_URL, {
      apiUrl: value.config.apiUrl,
      kind,
      token: receipt.token,
    });
    assertLiveCommandReceipt(receipt);
    setShared({ owner: value, value: receipt, url });
    setJournal(value.session.saved());
    setNotice('Customer link created.');
    await reload(value);
  }
  async function close(value: CustomerLinkOwner) {
    const saved = value.session.saved(),
      l = saved.lifecycle;
    if (!l) return;
    setShared(null);
    setFallback('');
    const event = l.type === 'close' ? l.eventId : newInboxId(),
      actual = await value.session.close(event, value.signal);
    if (current(value)) {
      setJournal(value.session.saved());
      setAttempt(actual);
      setNotice(
        actual.closure?.eventId === event
          ? 'Link attempt closed. It can be replaced.'
          : 'This link was already closed by another authorized person. It can be replaced.',
      );
    }
    await reload(value);
  }
  async function revoke(value: CustomerLinkOwner, link: CustomerLinkMetadata) {
    const saved = value.session.saved();
    if (saved.lifecycle?.source.id === link.id) {
      await close(value);
      return;
    }
    const original = saved.revoke ?? { link, eventId: newInboxId() };
    await value.session.revoke(original.link, original.eventId, value.signal);
    if (current(value)) {
      setJournal(value.session.saved());
      setNotice('Link is revoked.');
    }
    await reload(value);
  }
  function validShared(value: NonNullable<typeof shared>) {
    if (!current(value.owner)) return false;
    try {
      assertLiveCommandReceipt(value.value);
      return true;
    } catch {
      setShared(null);
      setFallback('');
      setError(
        'This link changed. Check its saved attempt before sharing again.',
      );
      return false;
    }
  }
  async function copy(message = false) {
    if (!sharedNow || !ready || !validShared(sharedNow)) return;
    const original = sharedNow,
      value = message ? messageText : original.url;
    try {
      await navigator.clipboard.writeText(value);
      if (validShared(original))
        setNotice(message ? 'Message copied.' : 'Link copied.');
    } catch {
      if (validShared(original)) {
        setFallback(value);
        setNotice('Select and copy the complete text below.');
      }
    }
  }
  const title = kind === 'order' ? 'Tracking link' : 'Customer khata link',
    lifecycle = journal.lifecycle;
  const canCreate = Boolean(
    ready &&
    !working &&
    !more &&
    !journal.revoke &&
    (!lifecycle || attempt?.state === 'closed'),
  );
  const messageText =
    language === 'bn'
      ? `${kind === 'order' ? 'আপনার অর্ডার' : 'আপনার খাতা'} · ${label}\n${sharedNow?.url ?? ''}`
      : `${kind === 'order' ? 'Track your order' : 'Your khata'} · ${label}\n${sharedNow?.url ?? ''}`;
  const whatsapp =
    phone && sharedNow ? customerWhatsAppUrl(phone, messageText) : null;
  return (
    <Card
      className="app-panel customer-link-card"
      role="region"
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <MiseIcon name="link" size={18} />
      </header>
      <p>
        {kind === 'order'
          ? 'Anyone with the link can view this order.'
          : 'Share only with this customer. Anyone with the link can view this khata.'}
      </p>
      {!online ? (
        <p role="status">
          Connect to manage customer links. The manual message option is still
          available.
        </p>
      ) : owner.checking ? (
        <p aria-busy="true">Checking access…</p>
      ) : null}
      {!ready && !owner.checking ? (
        <div className="customer-link-status">
          <p>
            {owner.error ||
              (!owner.configured
                ? 'Connect this shop and sync the record before creating a customer link.'
                : 'An owner or assigned manager must sign in to manage this link.')}
          </p>
          <Link to="/settings/sync">Sync setup</Link>
          <Button kind="ghost" disabled={!online} onClick={owner.refresh}>
            Refresh access
          </Button>
        </div>
      ) : null}
      {sharedNow ? (
        <>
          <div className="customer-link-url-row">
            <input
              readOnly
              aria-label={title + ' address'}
              value={sharedNow.url}
              onFocus={(event) => event.target.select()}
            />
            <Button
              kind="secondary"
              disabled={working}
              onClick={() => void copy()}
            >
              Copy link
            </Button>
          </div>
          <small>Expires {date(sharedNow.value.expiresAt)}</small>
          <div className="customer-link-actions">
            <label>
              Message language
              <select
                value={language}
                onChange={(event) =>
                  setLanguage(event.target.value as 'en' | 'bn')
                }
              >
                <option value="en">English</option>
                <option value="bn">বাংলা</option>
              </select>
            </label>
            {whatsapp ? (
              <a
                className="button button-secondary"
                href={whatsapp}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  if (!validShared(sharedNow)) event.preventDefault();
                }}
              >
                WhatsApp
              </a>
            ) : null}
            <Button kind="secondary" onClick={() => void copy(true)}>
              Copy message
            </Button>
            <Button
              kind="ghost"
              onClick={() => {
                if (validShared(sharedNow)) setNotice('Marked done.');
              }}
            >
              I shared it
            </Button>
          </div>
          {fallback ? (
            <label>
              Select and copy
              <textarea
                value={fallback}
                readOnly
                rows={3}
                onFocus={(event) => event.target.select()}
              />
            </label>
          ) : null}
        </>
      ) : lifecycle && attempt?.state !== 'closed' ? (
        <p>
          {attempt?.state === 'revoked' || attempt?.state === 'expired'
            ? 'This link is no longer active. Close its saved attempt before replacing it.'
            : lifecycle.type === 'close'
              ? 'Closure is unconfirmed. Retry the saved closure.'
              : lifecycle.link
                ? 'The one-time link secret is unavailable here. Close this link before creating a replacement.'
                : 'Creation is unconfirmed. Check or close the saved attempt before replacing it.'}
        </p>
      ) : null}
      {ready ? (
        <>
          {journal.revoke ? (
            <div className="customer-link-status">
              <p>A saved revocation is unconfirmed.</p>
              <Button
                kind="secondary"
                disabled={working}
                onClick={() =>
                  void action((value) => revoke(value, journal.revoke!.link))
                }
              >
                Retry saved revocation
              </Button>
            </div>
          ) : null}
          <div className="customer-link-actions">
            {canCreate ? (
              <Button onClick={() => void action(create)}>
                {lifecycle ? 'Create replacement link' : 'Create customer link'}
              </Button>
            ) : null}
            {lifecycle && attempt?.state !== 'closed' ? (
              <Button
                kind="secondary"
                disabled={working || more || Boolean(journal.revoke)}
                onClick={() => void action(close)}
              >
                {sharedNow
                  ? 'Revoke this link'
                  : lifecycle.type === 'close'
                    ? 'Retry saved closure'
                    : 'Close saved attempt'}
              </Button>
            ) : null}
            <Button
              kind="ghost"
              disabled={working || more}
              onClick={() => void action(reload)}
            >
              Check now
            </Button>
          </div>
          {page?.entries.length ? (
            <details className="customer-link-existing">
              <summary>
                Existing links · {page.entries.length}
                {page.next ? ' +' : ''}
              </summary>
              <ul>
                {page.entries.map((entry) => (
                  <li key={entry.id}>
                    <div>
                      <span>Created {date(entry.createdAt)}</span>
                      <small>
                        {entry.revokedAt !== null
                          ? 'Revoked ' + date(entry.revokedAt)
                          : 'Expires ' + date(entry.expiresAt)}
                      </small>
                    </div>
                    {entry.revokedAt === null ? (
                      <Button
                        kind="ghost"
                        disabled={working || Boolean(journal.revoke)}
                        onClick={() =>
                          void action((value) =>
                            revoke(value, {
                              id: entry.id,
                              kind: entry.kind,
                              resourceId: entry.resourceId,
                              createdAt: entry.createdAt,
                              expiresAt: entry.expiresAt,
                              revokedAt: entry.revokedAt,
                            }),
                          )
                        }
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {page.next ? (
                <Button
                  kind="secondary"
                  disabled={working || more}
                  onClick={() => {
                    if (!ready || !page.next) return;
                    const original = ready,
                      previous = page;
                    setMore(true);
                    void original.session
                      .page(previous.next, 50, original.signal)
                      .then((next) => {
                        if (current(original))
                          setPage({
                            ...next,
                            entries: [...previous.entries, ...next.entries],
                          });
                      })
                      .catch(() => {
                        if (current(original))
                          setError(
                            'More links could not be checked. Try again.',
                          );
                      })
                      .finally(() => {
                        if (current(original)) setMore(false);
                      });
                  }}
                >
                  More links
                </Button>
              ) : null}
            </details>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="customer-link-notice" role="status">
        {notice}
      </p>
    </Card>
  );
}
