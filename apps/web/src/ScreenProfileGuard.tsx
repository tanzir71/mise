import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@mise/ui/primitives.tsx';
import {
  readScreenReservation,
  watchScreenProfile,
} from './data/screen-profile';

export function ScreenProfileGuard({ children }: { children: ReactNode }) {
  const [state, setState] = useState<
      'checking' | 'owner' | 'screen' | 'failed'
    >('checking'),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true,
      revision = 0;
    const check = () => {
      const at = ++revision;
      void readScreenReservation(import.meta.env.BASE_URL)
        .then((value) => {
          if (active && at === revision) setState(value ? 'screen' : 'owner');
        })
        .catch(() => {
          if (active && at === revision) setState('failed');
        });
    };
    check();
    const stop = watchScreenProfile(import.meta.env.BASE_URL, check);
    return () => {
      active = false;
      revision++;
      stop();
    };
  }, [retry]);
  if (state === 'owner') return children;
  return (
    <main className="coming-soon screen-profile-guard">
      <p className="eyebrow">MISE · THIS BROWSER</p>
      <h1>
        {state === 'checking'
          ? 'Opening Mise…'
          : state === 'screen'
            ? 'This profile is a shared screen.'
            : 'Browser storage could not be checked.'}
      </h1>
      {state === 'screen' ? (
        <>
          <p>
            Continue to the paired screen. Keep the owner’s shop and phone
            sign-in in a separate browser profile.
          </p>
          <Link
            className="button button-primary"
            to="/screen/setup?flags=deviceAccess"
          >
            Open shared screen
          </Link>
        </>
      ) : state === 'failed' ? (
        <>
          <p>
            Keep this browser’s records. Retry the storage check before opening
            a workspace.
          </p>
          <Button onClick={() => setRetry((value) => value + 1)}>
            Try again
          </Button>
        </>
      ) : (
        <p role="status">Checking this device…</p>
      )}
    </main>
  );
}
